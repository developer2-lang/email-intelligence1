/**
 * Tracking data-access layer.
 *
 * Marks email_logs rows as opened/clicked directly via PostgREST and keeps
 * campaign_analytics in sync. The `record_email_open` / `record_email_click`
 * SQL functions in backend/email_tracking_migration.sql remain as an equivalent
 * server-side implementation but are not invoked by this module.
 */
import { supabase } from './supabaseService.js';
import * as emailLogService from './emailLogService.js';
import * as followupService from './followupService.js';
import * as sequenceWorker from '../workers/sequenceWorker.js';

/**
 * Optional anti-bot grace period (seconds) between sent_at and an open request
 * before it is counted as a real human open.
 *
 * IMPORTANT: default is 0 = DISABLED. Gmail's image proxy and Outlook prefetch
 * each pixel URL exactly ONCE, seconds after delivery, and then serve the
 * cached image to the human later — so they never re-request the URL. A grace
 * period here therefore means "Gmail/Outlook recipients are NEVER recorded as
 * opened". Every commercial ESP counts the prefetch as an open.
 *
 * If you still want the filter, set TRACKING_MIN_OPEN_DELAY in backend/.env
 * (e.g. 90) and be aware that real Gmail opens will be lost.
 *
 * Configurable via TRACKING_MIN_OPEN_DELAY (default 0). The SQL functions in
 * backend/email_tracking_migration.sql apply no delay filter either.
 */
const MIN_OPEN_DELAY_SECONDS = parseMinOpenDelay();
const MIN_OPEN_DELAY_MS = MIN_OPEN_DELAY_SECONDS * 1000;

function parseMinOpenDelay() {
  const value = Number(process.env.TRACKING_MIN_OPEN_DELAY);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  return wrapped;
}

function printSupabaseError(prefix, error) {
  console.error(`[TrackingService] ${prefix} — error: ${error.message}`);
  if (error.code) console.error(`[TrackingService] ${prefix} — code: ${error.code}`);
  if (error.details) console.error(`[TrackingService] ${prefix} — details: ${error.details}`);
  if (error.hint) console.error(`[TrackingService] ${prefix} — hint: ${error.hint}`);
}

/**
 * Look up the email_log row by its tracking_id so recordOpen can gate on
 * sent_at before the RPC runs. Returns null when the id is malformed or no
 * row matches.
 *
 * @param {string} trackingId
 * @returns {Promise<object|null>}
 */
async function getLogByTrackingId(trackingId) {
  if (!isValidUuid(trackingId)) {
    console.log(`[Tracking] Invalid tracking ID format: ${trackingId}`);
    return null;
  }
  const { data, error } = await supabase
    .from('email_logs')
    .select('id, campaign_id, contact_id, email, sent_at, opened, clicked')
    .eq('tracking_id', trackingId)
    .maybeSingle();
  if (error) {
    printSupabaseError('getLogByTrackingId FAILED', error);
    throw toError(error, 'Failed to look up email log by tracking id');
  }
  return data || null;
}

/**
 * Delay in milliseconds between sent_at and now. null when there is no row or
 * no sent_at to compare against.
 *
 * @param {object|null} log
 * @param {Date} now
 * @returns {number|null}
 */
function getOpenDelayMs(log, now) {
  if (!log || !log.sent_at) return null;
  const sentAtMs = new Date(log.sent_at).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - sentAtMs);
}

/**
 * True when the open request arrived within the grace period after sending.
 *
 * @param {number|null} delayMs
 * @returns {boolean}
 */
function isBotAutoLoad(delayMs) {
  return delayMs !== null && delayMs < MIN_OPEN_DELAY_MS;
}

/**
 * Mark an email as opened. Idempotent: repeated pixel loads only record once.
 * Ignores auto-loads that fire within the grace period after sending.
 *
 * Always resolves successfully — the tracking endpoint responds HTTP 200 even
 * when the event is skipped (auto-load or invalid tracking id).
 *
 * @param {string} trackingId - UUID embedded in the tracking pixel.
 * @returns {Promise<{success: boolean, ignored: boolean, reason: string}>}
 */
export async function recordOpen(trackingId) {
  console.log('[Tracking] Tracking request received');
  console.log(`[Tracking] Tracking ID: ${trackingId}`);

  if (!isValidUuid(trackingId)) {
    console.log(`[Tracking] Invalid tracking ID: ${trackingId}`);
    return {
      success: true,
      ignored: true,
      reason: 'invalid',
    };
  }

  const now = new Date();
  const log = await getLogByTrackingId(trackingId);
  const sentAt = log && log.sent_at;
  const openedBefore = log && log.opened === true;

  console.log(`[Tracking] sent_at: ${sentAt || '(no matching email_log)'}`);
  console.log(`[Tracking] current time: ${now.toISOString()}`);
  console.log(`[Tracking] Campaign ID: ${log?.campaign_id || '(unknown)'}`);
  console.log(`[Tracking] Recipient ID: ${log?.contact_id || '(unknown)'}`);
  console.log(`[Tracking] Recipient email: ${log?.email || '(unknown)'}`);
  console.log(`[Tracking] Opened before: ${openedBefore}`);

  const delayMs = getOpenDelayMs(log, now);
  console.log(`[Tracking] delay: ${delayMs === null ? 'unknown' : `${delayMs}ms`}`);

  if (isBotAutoLoad(delayMs)) {
    console.log(
      `[Tracking] event: ignored — auto-open for tracking_id ${trackingId} ` +
      `fired ${delayMs}ms after sent_at (within ${MIN_OPEN_DELAY_SECONDS}s threshold)`
    );
    return {
      success: true,
      ignored: true,
      reason: 'auto_open',
      campaignId: log?.campaign_id || null,
    };
  }

  if (!log || !log.id || !log.campaign_id) {
    console.warn('[Tracking] recordOpen could not resolve an email log row; open was not recorded');
    return {
      success: true,
      ignored: true,
      reason: 'not_found',
      campaignId: log?.campaign_id || null,
    };
  }

  const { data: updateData, error: updateError } = await supabase
    .from('email_logs')
    .update({ opened: true, opened_at: new Date().toISOString() })
    .eq('id', log.id)
    .eq('opened', false)
    .select('id,campaign_id,opened,opened_at')
    .maybeSingle();

  if (updateError) {
    printSupabaseError('recordOpen UPDATE FAILED', updateError);
    throw toError(updateError, 'Failed to record email open');
  }

  const openedAfter = updateData && updateData.opened === true;
  console.log(`[Tracking] Tracking ID: ${trackingId}`);
  console.log(`[Tracking] Campaign: ${log.campaign_id}`);
  console.log(`[Tracking] Contact: ${log.contact_id}`);
  console.log(`[Tracking] Email: ${log.email}`);
  console.log('[Tracking] Opened before:', openedBefore);
  console.log('[Tracking] Updated row:', updateData);
  console.log(`[Tracking] Opened after: ${openedAfter}`);

  if (!updateData) {
    console.log('[Tracking] recordOpen skipped update because the email was already opened or not found');
    return {
      success: true,
      ignored: true,
      reason: 'duplicate',
      campaignId: log.campaign_id,
    };
  }

  const analytics = await emailLogService.syncCampaignAnalytics(log.campaign_id);
  console.log(`[Tracking] Analytics synced: ${JSON.stringify(analytics)}`);

  // Keep the linked sequence_step_log(s) tracking flags in line with this
  // authoritative email_log record so the sequence Logs API, eligibility
  // fallbacks and any direct DB reads see the real open instead of the
  // never-synced false flag. Best-effort — a failure must never break the
  // tracking reply.
  try {
    await emailLogService.syncStepLogFromEmailLog(log.id, {
      opened: true,
      opened_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[Tracking] Step-log open sync failed (non-fatal): ${error.message}`);
  }

  // Follow-up automation — after a genuine first open is recorded, hand the
  // event to the follow-up service (manual → queue, automatic → send now).
  // Best-effort: a follow-up failure must never break the open-tracking reply.
  try {
    const followup = await followupService.handleOpenFollowup(
      log.campaign_id,
      log.contact_id,
      log.email
    );
    if (followup) {
      console.log(`[Tracking] Follow-up queued — ${log.email}: ${JSON.stringify(followup)}`);
    }
  } catch (error) {
    console.error(`[Tracking] Follow-up handling failed (non-fatal): ${error.message}`);
  }

  // Sequence automation — a genuine first open on a sequence step email
  // advances the recipient onto the step's 'opened' branch child immediately.
  // Best-effort: only sequence step emails match (others return null), and a
  // failure here must never break the open-tracking reply.
  try {
    const advanced = await sequenceWorker.handleStepOpened({
      id: log.id,
      contact_id: log.contact_id,
    });
    if (advanced) {
      console.log(`[Tracking] Sequence advanced on open — step ${advanced.step_number} (opened)`);
    }
  } catch (error) {
    console.error(`[Tracking] Sequence open advancement failed (non-fatal): ${error.message}`);
  }

  console.log(`[Tracking] event: recorded — tracking_id: ${trackingId}`);
  return {
      success: true,
      ignored: false,
      reason: 'recorded',
      campaignId: log.campaign_id,
  };
}

/**
 * Mark an email as clicked. Idempotent: repeated clicks only record once.
 * Unchanged: click tracking is NOT gated on sent_at.
 *
 * @param {string} trackingId - UUID embedded in the click link.
 */
function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function updateCampaignAnalytics(campaignId, stats) {
  if (!campaignId) return null;

  const row = {
    campaign_id: campaignId,
    total_recipients: safeNumber(stats.total),
    delivered: safeNumber(stats.delivered),
    opened: safeNumber(stats.opened),
    clicked: safeNumber(stats.clicked),
    open_rate: safeNumber(stats.delivered) > 0 ? Number(((safeNumber(stats.opened) / safeNumber(stats.delivered)) * 100).toFixed(1)) : 0,
    click_rate: safeNumber(stats.delivered) > 0 ? Number(((safeNumber(stats.clicked) / safeNumber(stats.delivered)) * 100).toFixed(1)) : 0,
  };

  const { data, error } = await supabase
    .from('campaign_analytics')
    .upsert(row, { onConflict: 'campaign_id' })
    .select('*')
    .single();

  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('cannot insert into view') || message.includes('cannot update view') || message.includes('55000')) {
      console.warn('[TrackingService] campaign_analytics appears to be a view; skipping analytics upsert.');
      return null;
    }
    throw toError(error, 'Failed to update campaign analytics');
  }

  return data;
}

export async function recordClick(input) {
  const trackingId = typeof input === 'string' ? input : input?.trackingId;
  const campaignId = input && typeof input === 'object' ? input.campaignId : null;
  const recipientId = input && typeof input === 'object' ? input.recipientId : null;

  console.log(`[Tracking] Tracking request received`);
  console.log(`[Tracking] Tracking ID: ${trackingId || '(none)'} campaign_id: ${campaignId || '(none)'} recipient_id: ${recipientId || '(none)'}`);

  let resolvedTrackingId = trackingId;
  if (!resolvedTrackingId && campaignId && recipientId) {
    const { data, error } = await supabase
      .from('email_logs')
      .select('tracking_id')
      .eq('campaign_id', campaignId)
      .eq('contact_id', recipientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      printSupabaseError('recordClick lookup FAILED', error);
      throw toError(error, 'Failed to resolve click tracking row');
    }

    resolvedTrackingId = data?.tracking_id || null;
  }

  if (!resolvedTrackingId) {
    console.warn('[Tracking] recordClick could not resolve a tracking id; click was not recorded');
    return { success: false, ignored: true, reason: 'unresolved' };
  }

  const log = await getLogByTrackingId(resolvedTrackingId);
  if (!log || !log.id || !log.campaign_id) {
    console.warn('[Tracking] recordClick could not resolve a matching email_log row; click was not recorded');
    return { success: false, ignored: true, reason: 'not_found' };
  }

  const { data: updateData, error: updateError } = await supabase
    .from('email_logs')
    .update({ clicked: true, clicked_at: new Date().toISOString() })
    .eq('id', log.id)
    .eq('clicked', false)
    .select('id,campaign_id')
    .single();

  if (updateError) {
    printSupabaseError('recordClick UPDATE FAILED', updateError);
    throw toError(updateError, 'Failed to record email click');
  }

  if (!updateData) {
    return {
      success: true,
      ignored: true,
      reason: 'duplicate',
    };
  }

  // Keep the linked sequence_step_log(s) tracking flags in line with this
  // authoritative email_log record. Best-effort — a failure must never break
  // the click redirect.
  try {
    await emailLogService.syncStepLogFromEmailLog(log.id, {
      clicked: true,
      clicked_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[Tracking] Step-log click sync failed (non-fatal): ${error.message}`);
  }

  // Opens are NOT manufactured from a click. Per the tracking design,
  // email_logs.opened is set ONLY by recordOpen() when the open pixel
  // (/api/tracking/open/:trackingId) is actually requested by the mail client.
  // A click proves interaction but must not back-fill opened=true — otherwise
  // opens could never be measured independently of clicks. The campaign
  // statistics below are recomputed from the authoritative email_logs rows.

  const stats = await supabase
    .from('email_logs')
    .select('id, status, opened, clicked')
    .eq('campaign_id', log.campaign_id);

  const rows = stats.data || [];
  const total = rows.length;
  const delivered = rows.filter((row) => row.status === 'sent').length;
  const opened = rows.filter((row) => row.opened === true).length;
  const clicked = rows.filter((row) => row.clicked === true).length;

  await updateCampaignAnalytics(log.campaign_id, { total, delivered, opened, clicked });

  console.log(`[Tracking] recorded: true — tracking_id: ${resolvedTrackingId}`);
  return {
    success: true,
    ignored: false,
    reason: 'recorded',
  };
}
