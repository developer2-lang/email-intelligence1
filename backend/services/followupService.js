/**
 * Campaign follow-up automation service.
 *
 * Triggered from trackingService.recordOpen after a genuine first open is
 * recorded for an email_log row.
 *
 * Two modes (configured per campaign in the `campaign_followups` table):
 *   - manual:    a "pending" row is inserted into `campaign_followup_logs` and
 *                the operator sends it later from the Pending Follow-ups tab.
 *   - automatic: the configured follow-up campaign is emailed to the opener
 *                immediately — no cron, no scheduling, no waiting.
 *
 * Duplicate prevention: the UNIQUE constraint on
 * (campaign_id, contact_id, followup_campaign_id) in `campaign_followup_logs`
 * guarantees a recipient receives the same follow-up only once. Sends are
 * additionally gated on the existing row's status.
 */
import { supabase } from './supabaseService.js';
import * as supabaseService from './supabaseService.js';
import * as emailLogService from './emailLogService.js';
import * as emailService from './emailService.js';
import trackingEdge from '../config/trackingEdge.js';
import {
  personalizeTemplate,
  stripHtml,
  decodeHtmlEntities,
  hasHtmlTags,
  plainTextToHtml,
} from '../utils/emailTemplate.js';
import { parseTime, computeNextRun } from '../utils/scheduleTime.js';

const CONFIG_TABLE = 'campaign_followups';
const LOG_TABLE = 'campaign_followup_logs';
const HISTORY_TABLE = 'followup_history';
const SCHEDULE_TABLE = 'campaign_schedules';
const TRIGGER_TYPE = 'opened';

/**
 * Sentinel stored in `campaigns.mailchimp_campaign_id` (an unused, nullable
 * column) to flag a follow-up campaign whose original is "All". The
 * campaign_followups.campaign_id column is a strict FK to campaigns.id and can
 * never hold the literal value 'all', and when every eligible campaign already
 * has its own follow-up there is no real campaign left to anchor an All row to —
 * so the All marker lives on the follow-up campaign row itself.
 */
const ALL_FOLLOWUP_MARKER = '__ALL_FOLLOWUP__';

function toError(error, fallback) {
  const wrapped = new Error((error && error.message) || fallback);
  wrapped.status = 500;
  return wrapped;
}

// ─── Follow-up schedule (parity with the campaign scheduling machinery) ────

function normalizeTimeToStore(timeStr) {
  if (!timeStr) return null;
  const t = parseTime(timeStr);
  if (!t) return String(timeStr).trim();
  return [
    String(t.hours).padStart(2, '0'),
    String(t.minutes).padStart(2, '0'),
    String(t.seconds).padStart(2, '0'),
  ].join(':');
}

/**
 * Build a campaign_schedules row from a follow-up schedule payload, including
 * the computed next_run — mirrors buildScheduleRow in campaignService.js.
 */
function buildScheduleRow(input) {
  const row = {
    schedule_type: input.schedule_type,
    start_date: input.start_date || null,
    send_time: normalizeTimeToStore(input.send_time),
    repeat_interval:
      input.repeat_interval != null ? Math.max(1, Number(input.repeat_interval) || 1) : 1,
    weekly_days:
      Array.isArray(input.weekly_days) && input.weekly_days.length > 0
        ? input.weekly_days.join(', ')
        : null,
    monthly_type: input.monthly_type || null,
    day_of_month: input.day_of_month != null ? Number(input.day_of_month) : null,
    week_number: input.week_number || null,
    weekday: input.weekday || null,
    timezone: input.timezone || 'Asia/Kolkata',
  };
  const next = computeNextRun(row);
  return { ...row, next_run: next ? next.toISOString() : null };
}

/**
 * True when a follow-up campaign has an active schedule (a campaign_schedules
 * row) and is set to `status='scheduled'` — matching the cloud runner's model.
 */
export async function isScheduledFollowup(followupCampaignId) {
  if (!followupCampaignId) return false;
  const { data: schedule, error: scheduleError } = await supabase
    .from(SCHEDULE_TABLE)
    .select('id')
    .eq('campaign_id', followupCampaignId)
    .limit(1);
  if (scheduleError) return false;
  if (!schedule || schedule.length === 0) return false;
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('status')
    .eq('id', followupCampaignId)
    .maybeSingle();
  if (campaignError) return false;
  return campaign && String(campaign.status).toLowerCase() === 'scheduled';
}

/**
 * Persist a follow-up schedule to campaign_schedules (keyed by the follow-up
 * campaign id) and mark that follow-up campaign `status='scheduled'` so the
 * campaign scheduler delivers it to openers only at the scheduled times.
 * When `schedule` is absent the follow-up keeps today's behaviour and any
 * previous schedule row + `scheduled` status are cleared.
 */
async function persistFollowupSchedule(followupCampaignId, schedule) {
  if (!schedule || !['one_time', 'weekly', 'monthly'].includes(schedule.schedule_type)) {
    await supabase.from(SCHEDULE_TABLE).delete().eq('campaign_id', followupCampaignId);
    await supabase.from('campaigns').update({ status: 'draft' }).eq('id', followupCampaignId);
    return;
  }
  const row = buildScheduleRow(schedule);
  await supabaseService.replaceCampaignSchedule(followupCampaignId, row);
  await supabase.from('campaigns').update({ status: 'scheduled' }).eq('id', followupCampaignId);
}

// ─── Config (campaign_followups) ──────────────────────────────────────────

/**
 * Fetch the follow-up configuration for one campaign. Returns null when the
 * campaign has none.
 */
export async function getFollowupConfig(campaignId) {
  if (!campaignId) return null;
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01') return null; // table not created yet
    throw toError(error, 'Failed to fetch follow-up settings');
  }
  return data || null;
}

/**
 * Persist the follow-up configuration for a campaign.
 *
 * Disabling the follow-up (or saving without a follow-up campaign) clears any
 * stored configuration so re-enabling always requires a fresh selection.
 * Each campaign keeps exactly one config row (replaced on every save).
 */
export async function saveFollowupConfig(campaignId, config = {}) {
  if (!campaignId) {
    const err = new Error('campaign_id is required');
    err.status = 400;
    throw err;
  }

  const active = Boolean(config && config.is_active);
  const followupCampaignId = config && config.followup_campaign_id
    ? String(config.followup_campaign_id).trim()
    : null;

  // Disabled / no follow-up campaign selected → clear the stored config.
  if (!active || !followupCampaignId) {
    const { error } = await supabase
      .from(CONFIG_TABLE)
      .delete()
      .eq('campaign_id', campaignId);
    if (error && error.code !== '42P01') throw toError(error, 'Failed to clear follow-up settings');
    return null;
  }

  if (String(followupCampaignId) === String(campaignId)) {
    const err = new Error('A campaign cannot be its own follow-up campaign');
    err.status = 400;
    throw err;
  }

  const mode = config.followup_mode === 'automatic' ? 'automatic' : 'manual';

  // Replace any existing row for this campaign.
  const { error: deleteError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('campaign_id', campaignId);
  if (deleteError && deleteError.code !== '42P01') {
    throw toError(deleteError, 'Failed to replace follow-up settings');
  }

  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .insert({
      campaign_id: campaignId,
      followup_campaign_id: followupCampaignId,
      trigger_type: TRIGGER_TYPE,
      followup_mode: mode,
      is_active: true,
    })
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to save follow-up settings');
  return data || null;
}

/**
 * List every configured follow-up relationship, decorated with the original
 * campaign name, the follow-up campaign name, how many contacts opened the
 * original (eligible recipients) and how many follow-ups have already been
 * sent for the pair.
 *
 * Used by the dedicated Follow-ups page (GET /api/followups).
 */
export async function listFollowupConfigs() {
  const { data: configs, error } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    if (error.code === '42P01') return []; // table not created yet
    throw toError(error, 'Failed to list follow-up settings');
  }

  const rows = configs || [];
  const allFollowups = await listAllFollowupCampaigns();
  if (rows.length === 0 && allFollowups.length === 0) return [];

  // Decorate with campaign names (best-effort).
  const nameById = new Map();
  const createdById = new Map();
  try {
    const campaigns = await supabaseService.listCampaigns();
    for (const c of campaigns) {
      nameById.set(String(c.id), c.campaign_name || '');
      if (c.created_at) createdById.set(String(c.id), c.created_at);
    }
  } catch (listError) {
    console.warn(`[Followup] Could not resolve campaign names: ${listError.message}`);
  }

  const markerFollowupIds = new Set(allFollowups.map((c) => String(c.id)));
  const allFollowupIds = new Set(markerFollowupIds);
  for (const r of rows) allFollowupIds.add(String(r.followup_campaign_id));

  const originalIds = [...new Set(rows.map((r) => String(r.campaign_id)))];

  // Eligible recipients per ORIGINAL campaign: email_logs opened=true. These
  // are the follow-up's ELIGIBLE recipients — never its "opened" count.
  const openedByOriginal = new Map();
  try {
    const { data: openedLogs, error: openedError } = await supabase
      .from('email_logs')
      .select('campaign_id, contact_id, email')
      .in('campaign_id', originalIds)
      .eq('opened', true);
    if (!openedError) {
      const sets = new Map(originalIds.map((id) => [String(id), new Set()]));
      for (const log of openedLogs || []) {
        const set = sets.get(String(log.campaign_id));
        if (set) set.add(String(log.contact_id) || normalizeEmail(log.email));
      }
      for (const [id, set] of sets) openedByOriginal.set(id, set.size);
    }
  } catch (openedError) {
    console.warn(`[Followup] Could not count opened recipients: ${openedError.message}`);
  }

  // Already-sent counts per (original, follow-up) pair.
  const sentByPair = new Map();
  try {
    const { data: logs, error: logsError } = await supabase
      .from(LOG_TABLE)
      .select('campaign_id, followup_campaign_id, status')
      .in('campaign_id', originalIds);
    if (!logsError) {
      for (const log of logs || []) {
        if (!['sent', 'already_sent'].includes(log.status)) continue;
        const key = `${String(log.campaign_id)}|${String(log.followup_campaign_id)}`;
        sentByPair.set(key, (sentByPair.get(key) || 0) + 1);
      }
    }
  } catch (logsError) {
    console.warn(`[Followup] Could not count sent follow-ups: ${logsError.message}`);
  }

  // Already-sent recipients per FOLLOW-UP campaign (union across originals) —
  // backs the "remaining eligible" count for "All" rows.
  const sentByFollowup = new Map();
  try {
    const { data: logs, error: logsError } = await supabase
      .from(LOG_TABLE)
      .select('followup_campaign_id, contact_id, status')
      .in('followup_campaign_id', [...allFollowupIds]);
    if (!logsError) {
      for (const log of logs || []) {
        if (!['sent', 'already_sent'].includes(log.status)) continue;
        const fupId = String(log.followup_campaign_id);
        if (!sentByFollowup.has(fupId)) sentByFollowup.set(fupId, new Set());
        sentByFollowup.get(fupId).add(String(log.contact_id));
      }
    }
  } catch (logsError) {
    console.warn(`[Followup] Could not count sent all-campaign follow-ups: ${logsError.message}`);
  }

  // The FOLLOW-UP campaign's OWN engagement from ITS email_logs. These are the
  // follow-up opens/clicks — the original campaign's opens never enter here.
  const followupMetrics = new Map();
  try {
    const { data: emailLogs, error: logsError } = await supabase
      .from('email_logs')
      .select('campaign_id, status, opened, clicked')
      .in('campaign_id', [...allFollowupIds]);
    if (!logsError) {
      for (const log of emailLogs || []) {
        const id = String(log.campaign_id);
        if (!followupMetrics.has(id)) followupMetrics.set(id, { delivered: 0, opened: 0, clicked: 0 });
        const m = followupMetrics.get(id);
        if (log.status === 'sent') m.delivered += 1;
        if (log.opened === true) m.opened += 1;
        if (log.clicked === true) m.clicked += 1;
      }
    }
  } catch (logsError) {
    console.warn(`[Followup] Could not count follow-up engagement: ${logsError.message}`);
  }

  // Union of opened recipients across ALL eligible originals (the "All" eligible set).
  const allOpenedUnion = await computeAllOpenedUnion();

  const grouped = new Map();
  for (const row of rows) {
    const fupId = String(row.followup_campaign_id);
    if (!grouped.has(fupId)) grouped.set(fupId, []);
    grouped.get(fupId).push(row);
  }

  const ctx = { nameById, createdById, openedByOriginal, sentByPair, sentByFollowup, followupMetrics, allOpenedUnion };

  const result = [];
  for (const [fupId, group] of grouped) {
    const distinctOriginals = new Set(group.map((r) => String(r.campaign_id)));
    const isAll = markerFollowupIds.has(fupId) || distinctOriginals.size > 1;
    result.push(
      isAll
        ? buildAllFollowupRow(fupId, group[0], ctx)
        : buildIndividualFollowupRow(group[0], ctx)
    );
  }

  // All follow-ups that could not be anchored to a real campaign (every
  // eligible campaign already had its own follow-up) still show via the marker.
  for (const camp of allFollowups) {
    if (grouped.has(String(camp.id))) continue;
    result.push(buildAllFollowupRow(String(camp.id), null, ctx));
  }

  result.sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });

  return result;
}

/**
 * Engagement metrics for a follow-up campaign, computed ONLY from that
 * follow-up campaign's own email_logs (delivered = status sent, opened /
 * clicked = tracking columns). This is what backs followUpOpenedCount /
 * followUpDeliveredCount — never the original campaign's logs.
 */
function engagementFields(followupId, followupMetrics) {
  const m = followupMetrics.get(String(followupId)) || { delivered: 0, opened: 0, clicked: 0 };
  return {
    followup_delivered: m.delivered,
    followup_opened: m.opened,
    followup_clicked: m.clicked,
    followup_open_rate: m.delivered > 0 ? Number(((m.opened / m.delivered) * 100).toFixed(1)) : 0,
    followup_click_rate: m.delivered > 0 ? Number(((m.clicked / m.delivered) * 100).toFixed(1)) : 0,
  };
}

function buildIndividualFollowupRow(row, ctx) {
  const followupId = String(row.followup_campaign_id);
  const pairKey = `${String(row.campaign_id)}|${followupId}`;
  const opened = ctx.openedByOriginal.get(String(row.campaign_id)) || 0;
  const sent = ctx.sentByPair.get(pairKey) || 0;
  return {
    ...row,
    original_campaign_name: ctx.nameById.get(String(row.campaign_id)) || '—',
    followup_campaign_name: ctx.nameById.get(followupId) || '—',
    opened_count: opened,
    sent_count: sent,
    ...engagementFields(followupId, ctx.followupMetrics),
    remaining_eligible: Math.max(0, opened - sent),
    is_all: false,
  };
}

function buildAllFollowupRow(followupId, sampleRow, ctx) {
  const opened = ctx.allOpenedUnion;
  const sent = (ctx.sentByFollowup.get(String(followupId)) || new Set()).size;
  return {
    id: followupId,
    campaign_id: 'all',
    followup_campaign_id: followupId,
    trigger_type: (sampleRow && sampleRow.trigger_type) || TRIGGER_TYPE,
    followup_mode: (sampleRow && sampleRow.followup_mode) || 'manual',
    is_active: true,
    created_at: ctx.createdById.get(String(followupId)) || (sampleRow && sampleRow.created_at) || null,
    original_campaign_name: 'All',
    followup_campaign_name: ctx.nameById.get(String(followupId)) || '—',
    opened_count: opened,
    sent_count: sent,
    ...engagementFields(String(followupId), ctx.followupMetrics),
    remaining_eligible: Math.max(0, opened - sent),
    is_all: true,
  };
}

/**
 * Campaigns flagged as an "All" follow-up via the ALL_FOLLOWUP_MARKER sentinel
 * on the (otherwise unused) mailchimp_campaign_id column.
 */
async function listAllFollowupCampaigns() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name, created_at')
    .eq('mailchimp_campaign_id', ALL_FOLLOWUP_MARKER);
  if (error) {
    if (error.code === '42P01' || error.code === '42703') return []; // tables/columns not created yet
    throw toError(error, 'Failed to fetch all-campaign follow-ups');
  }
  return data || [];
}

/**
 * A follow-up campaign flagged as an "All" follow-up, or null.
 */
async function getFollowupCampaignIfAll(campaignId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name')
    .eq('id', campaignId)
    .eq('mailchimp_campaign_id', ALL_FOLLOWUP_MARKER)
    .maybeSingle();
  if (error) return null;
  return data || null;
}

/**
 * Remove an "All" follow-up: drop its config rows (if any) and clear the marker.
 */
async function removeAllFollowup(followupCampaignId) {
  const { error: configError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId);
  if (configError && configError.code !== '42P01') {
    throw toError(configError, 'Failed to remove all-campaign follow-up configuration');
  }
  const { error: markerError } = await supabase
    .from('campaigns')
    .update({ mailchimp_campaign_id: null })
    .eq('id', followupCampaignId);
  if (markerError) {
    throw toError(markerError, 'Failed to remove all-campaign follow-up marker');
  }
}

/**
 * Count of distinct opened recipients across ALL eligible original campaigns,
 * deduped by contact id (fallback: normalized email). Mirrors getOpenedContactsForAll.
 */
async function computeAllOpenedUnion() {
  try {
    const eligible = await listEligibleOriginalCampaigns();
    if (eligible.length === 0) return 0;
    const ids = eligible.map((c) => String(c.id));
    const { data: logs, error } = await supabase
      .from('email_logs')
      .select('contact_id, email')
      .in('campaign_id', ids)
      .eq('opened', true);
    if (error) return 0;
    const seen = new Set();
    for (const log of logs || []) {
      const key = String(log.contact_id) || normalizeEmail(log.email);
      if (key) seen.add(key);
    }
    return seen.size;
  } catch (error) {
    console.warn(`[Followup] Could not compute all-campaign opened union: ${error.message}`);
    return 0;
  }
}

async function campaignExists(campaignId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .maybeSingle();
  if (error && error.code !== '42P01') {
    throw toError(error, 'Failed to verify campaign');
  }
  return Boolean(data);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Campaigns that may act as an ORIGINAL for a follow-up: every campaign that
 * is not itself used as another campaign's follow-up campaign. This mirrors the
 * single-campaign rule (a follow-up campaign can never be an original) and is
 * what backs the "All" union — the same set shown as individual dropdown options.
 */
async function listEligibleOriginalCampaigns() {
  const campaigns = await supabaseService.listCampaigns();
  const { data: configs, error } = await supabase
    .from(CONFIG_TABLE)
    .select('followup_campaign_id');
  if (error && error.code !== '42P01') {
    throw toError(error, 'Failed to fetch follow-up settings');
  }
  const followupIds = new Set((configs || []).map((r) => String(r.followup_campaign_id)));
  // An "All" follow-up campaign is flagged via the marker sentinel; it is never
  // eligible to be an original campaign.
  const markedAll = await listAllFollowupCampaigns();
  for (const c of markedAll) followupIds.add(String(c.id));
  return (campaigns || []).filter((c) => c && c.id && !followupIds.has(String(c.id)));
}

/**
 * Create a follow-up relationship from the dedicated Follow-ups page
 * (POST /api/followups).
 *
 * The follow-up campaign is created WITHOUT an audience segment — its
 * recipients ALWAYS come from the ORIGINAL campaign's openers
 * (email_logs opened=true), never from a segment. `campaign_followups`
 * stores the canonical link (campaign_id = original, followup_campaign_id =
 * follow-up).
 *
 * Payload:
 *   {
 *     original_campaign_id: string,     // required
 *     followup_campaign_id: string|null, // existing campaign to reuse, or
 *     campaign_name, subject_line, from_name, html_content, campaign_type, // create new
 *     followup_mode: 'manual'|'automatic',
 *     is_active: boolean
 *   }
 */
export async function createFollowupConfig(payload = {}) {
  const originalCampaignId = payload.original_campaign_id
    ? String(payload.original_campaign_id).trim()
    : '';
  if (!originalCampaignId) {
    const err = new Error('original_campaign_id is required');
    err.status = 400;
    throw err;
  }

  // "All" — recipients are the union of openers across every eligible campaign.
  if (originalCampaignId === 'all') {
    return createAllCampaignsFollowup(payload);
  }

  const originalExists = await campaignExists(originalCampaignId);
  if (!originalExists) {
    const err = new Error('Original campaign not found');
    err.status = 404;
    throw err;
  }

  // A campaign that is itself a follow-up can never be an original campaign.
  const originalFollowupCheck = await supabaseService.resolveFollowupRecipients(originalCampaignId);
  if (originalFollowupCheck.isFollowup) {
    const err = new Error('A follow-up campaign cannot be used as an original campaign');
    err.status = 400;
    throw err;
  }

  const mode = payload.followup_mode === 'automatic' ? 'automatic' : 'manual';
  const isActive = payload.is_active !== false;

  let followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id).trim()
    : null;
  let created = false;

  if (followupCampaignId) {
    if (followupCampaignId === originalCampaignId) {
      const err = new Error('A campaign cannot be its own follow-up campaign');
      err.status = 400;
      throw err;
    }
    const followupExists = await campaignExists(followupCampaignId);
    if (!followupExists) {
      const err = new Error('Selected follow-up campaign not found');
      err.status = 404;
      throw err;
    }
    const followupCheck = await supabaseService.resolveFollowupRecipients(followupCampaignId);
    if (followupCheck.isFollowup) {
      const err = new Error('That campaign is already configured as a follow-up');
      err.status = 400;
      throw err;
    }
  } else {
    // Create a NEW follow-up campaign. No audience_segment: a follow-up is
    // never sent to a segment — only to the original campaign's openers.
    const missing = [];
    if (!payload.campaign_name || !String(payload.campaign_name).trim()) missing.push('campaign_name');
    if (!payload.subject_line || !String(payload.subject_line).trim()) missing.push('subject_line');
    if (!payload.html_content || !String(payload.html_content).trim()) missing.push('html_content');
    if (missing.length > 0) {
      const err = new Error(`Missing required fields: ${missing.join(', ')}`);
      err.status = 400;
      throw err;
    }

    const record = {
      campaign_name: String(payload.campaign_name).trim(),
      subject_line: String(payload.subject_line).trim(),
      from_name: String(payload.from_name || '').trim() || 'Rupali Sirsath — IUOVA Design Consultancy',
      audience_segment: null,
      campaign_type: String(payload.campaign_type || 'Follow Up').trim(),
      email_body: String(payload.html_content),
      html_content: String(payload.html_content),
      template_name: null,
      schedule_date: null,
      schedule_time: null,
      status: 'draft',
    };
    const saved = await supabaseService.saveCampaign(record);
    followupCampaignId = saved.id;
    created = true;
  }

  const config = await saveFollowupConfig(originalCampaignId, {
    is_active: isActive,
    followup_mode: mode,
    followup_campaign_id: followupCampaignId,
  });

  await persistFollowupSchedule(followupCampaignId, payload.schedule);

  return {
    config,
    original_campaign_id: originalCampaignId,
    followup_campaign_id: followupCampaignId,
    created,
  };
}

/**
 * Create a follow-up whose recipients are the UNION of opened contacts across
 * every eligible original campaign (deduped by contact id, fallback email).
 *
 * The follow-up campaign is created/reused exactly like the single-campaign
 * path (no audience segment — recipients always come from email_logs
 * opened=true). Config rows are written ONLY for eligible campaigns that do not
 * already have a follow-up configuration: an existing per-campaign follow-up is
 * NEVER overwritten, so individual campaign selection keeps working unchanged.
 *
 * @returns {Promise<{config: null, original_campaign_id: 'all', followup_campaign_id: string, created: boolean, linked_campaign_count: number, total_campaigns: number}>}
 */
async function createAllCampaignsFollowup(payload) {
  const mode = payload.followup_mode === 'automatic' ? 'automatic' : 'manual';
  const isActive = payload.is_active !== false;

  const eligible = await listEligibleOriginalCampaigns();
  if (eligible.length === 0) {
    const err = new Error('No eligible campaigns found for an all-campaigns follow-up');
    err.status = 400;
    throw err;
  }

  let followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id).trim()
    : null;
  let created = false;

  if (followupCampaignId) {
    if (eligible.some((c) => String(c.id) === followupCampaignId)) {
      const err = new Error('A campaign cannot be its own follow-up campaign');
      err.status = 400;
      throw err;
    }
    const followupExists = await campaignExists(followupCampaignId);
    if (!followupExists) {
      const err = new Error('Selected follow-up campaign not found');
      err.status = 404;
      throw err;
    }
    const followupCheck = await supabaseService.resolveFollowupRecipients(followupCampaignId);
    if (followupCheck.isFollowup) {
      const err = new Error('That campaign is already configured as a follow-up');
      err.status = 400;
      throw err;
    }
  } else {
    // Create a NEW follow-up campaign. No audience_segment: a follow-up is
    // never sent to a segment — only to the eligible campaigns' openers.
    const missing = [];
    if (!payload.campaign_name || !String(payload.campaign_name).trim()) missing.push('campaign_name');
    if (!payload.subject_line || !String(payload.subject_line).trim()) missing.push('subject_line');
    if (!payload.html_content || !String(payload.html_content).trim()) missing.push('html_content');
    if (missing.length > 0) {
      const err = new Error(`Missing required fields: ${missing.join(', ')}`);
      err.status = 400;
      throw err;
    }

    const record = {
      campaign_name: String(payload.campaign_name).trim(),
      subject_line: String(payload.subject_line).trim(),
      from_name: String(payload.from_name || '').trim() || 'Rupali Sirsath — IUOVA Design Consultancy',
      audience_segment: null,
      campaign_type: String(payload.campaign_type || 'Follow Up').trim(),
      email_body: String(payload.html_content),
      html_content: String(payload.html_content),
      template_name: null,
      schedule_date: null,
      schedule_time: null,
      status: 'draft',
    };
    const saved = await supabaseService.saveCampaign(record);
    followupCampaignId = saved.id;
    created = true;
  }

  // Flag the follow-up campaign as an "All" follow-up via the (unused, nullable)
  // mailchimp_campaign_id sentinel. campaign_followups.campaign_id is a strict FK
  // to campaigns.id and can never hold the literal value 'all', so the marker
  // lives on the follow-up campaign row itself — this is what makes the
  // synthesized "All" row resolve in the Active table even when every eligible
  // campaign already has its own follow-up.
  const { error: markerError } = await supabase
    .from('campaigns')
    .update({ mailchimp_campaign_id: ALL_FOLLOWUP_MARKER })
    .eq('id', followupCampaignId);
  if (markerError) {
    throw toError(markerError, 'Failed to mark all-campaigns follow-up');
  }

  // Link eligible campaigns that do not already have a follow-up. Existing
  // per-campaign configurations are preserved untouched.
  let linkedCampaignCount = 0;
  if (isActive) {
    for (const campaign of eligible) {
      if (String(campaign.id) === String(followupCampaignId)) continue;
      const existing = await getFollowupConfig(String(campaign.id));
      if (existing) continue;
      await saveFollowupConfig(String(campaign.id), {
        is_active: true,
        followup_mode: mode,
        followup_campaign_id: followupCampaignId,
      });
      linkedCampaignCount += 1;
    }
  }

  await persistFollowupSchedule(followupCampaignId, payload.schedule);

  return {
    config: null,
    original_campaign_id: 'all',
    followup_campaign_id: followupCampaignId,
    created,
    linked_campaign_count: linkedCampaignCount,
    total_campaigns: eligible.length,
  };
}

/**
 * Update an existing follow-up configuration (mode / is_active) by its row id
 * (PATCH /api/followups/:id).
 *
 * Disabling (is_active: false) clears the stored row — same semantics as
 * saveFollowupConfig — so re-enabling always requires a fresh configuration.
 *
 * @param {string} configId The campaign_followups row id.
 * @param {object} payload  { followup_mode?: 'manual'|'automatic', is_active?: boolean }
 * @returns {Promise<object|null>} The updated config row, or null when disabled.
 */
export async function updateFollowupConfig(configId, payload = {}) {
  if (!configId) {
    const err = new Error('config_id is required');
    err.status = 400;
    throw err;
  }

  // An "All" follow-up row is anchored to the marker-flagged follow-up campaign
  // rather than a campaign_followups row — handle it separately.
  const allFollowup = await getFollowupCampaignIfAll(configId);
  if (allFollowup) {
    return updateAllFollowup(configId, payload);
  }

  const { data: existing, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('id', configId)
    .maybeSingle();
  if (fetchError) throw toError(fetchError, 'Failed to fetch follow-up configuration');
  if (!existing) {
    const err = new Error('Follow-up configuration not found');
    err.status = 404;
    throw err;
  }

  if (payload.is_active === false) {
    const { error: deleteError } = await supabase
      .from(CONFIG_TABLE)
      .delete()
      .eq('id', configId);
    if (deleteError && deleteError.code !== '42P01') {
      throw toError(deleteError, 'Failed to disable follow-up configuration');
    }
    return null;
  }

  const mode = payload.followup_mode === 'automatic' || payload.followup_mode === 'manual'
    ? payload.followup_mode
    : existing.followup_mode;
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : existing.is_active;

  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .update({ followup_mode: mode, is_active: isActive })
    .eq('id', configId)
    .select('*')
    .single();
  if (error) throw toError(error, 'Failed to update follow-up configuration');
  return data || null;
}

/**
 * Update an "All" follow-up (anchor = marker-flagged follow-up campaign id).
 * Disabling removes the All follow-up entirely (config rows + marker), matching
 * the per-campaign disable semantics. Re-enabling / mode change propagates to
 * every config row anchored to that follow-up campaign.
 */
async function updateAllFollowup(followupCampaignId, payload) {
  if (payload.is_active === false) {
    await removeAllFollowup(followupCampaignId);
    return null;
  }

  const { data: rows, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('followup_campaign_id', followupCampaignId);
  if (fetchError && fetchError.code !== '42P01') {
    throw toError(fetchError, 'Failed to fetch all-campaigns follow-up configuration');
  }

  const updates = {};
  const mode = payload.followup_mode;
  if (mode === 'automatic' || mode === 'manual') updates.followup_mode = mode;
  if (payload.is_active !== undefined) updates.is_active = Boolean(payload.is_active);

  if (Object.keys(updates).length > 0 && (rows || []).length > 0) {
    const { error: updateError } = await supabase
      .from(CONFIG_TABLE)
      .update(updates)
      .eq('followup_campaign_id', followupCampaignId);
    if (updateError) throw toError(updateError, 'Failed to update all-campaigns follow-up configuration');
  }

  return (rows && rows[0]) || {
    id: followupCampaignId,
    campaign_id: 'all',
    followup_campaign_id: followupCampaignId,
    trigger_type: TRIGGER_TYPE,
    followup_mode: mode || 'manual',
    is_active: true,
  };
}

/**
 * Delete a follow-up configuration by its row id (DELETE /api/followups/:id).
 * Removes only the relationship row — the underlying campaigns are untouched.
 *
 * @param {string} configId The campaign_followups row id.
 * @returns {Promise<object>} The deleted row.
 */
export async function deleteFollowupConfig(configId) {
  if (!configId) {
    const err = new Error('config_id is required');
    err.status = 400;
    throw err;
  }

  // Resolve the follow-up campaign id. A campaign_followups row id is an
  // individual follow-up → use its followup_campaign_id. Anything else
  // (synthesized "All" / orphan rows) is already the follow-up campaign id.
  let followupCampaignId = '';
  let configRow = null;
  const { data: configLookup, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('id', configId)
    .maybeSingle();
  if (fetchError && fetchError.code !== '42P01') {
    throw toError(fetchError, 'Failed to fetch follow-up configuration');
  }
  if (configLookup) {
    configRow = configLookup;
    followupCampaignId = String(configLookup.followup_campaign_id || '');
  } else {
    const { data: campaignLookup, error: campaignFetchError } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', configId)
      .maybeSingle();
    if (campaignFetchError && campaignFetchError.code !== '42P01') {
      throw toError(campaignFetchError, 'Failed to fetch follow-up campaign');
    }
    if (campaignLookup) followupCampaignId = String(campaignLookup.id);
  }

  if (!followupCampaignId) {
    const err = new Error('Follow-up configuration not found');
    err.status = 404;
    throw err;
  }

  // campaign_followup_logs has no FK to campaigns — remove its rows explicitly
  // so the follow-up's pending/sent records are not orphaned.
  const { error: logError } = await supabase
    .from(LOG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId);
  if (logError && logError.code !== '42P01') {
    throw toError(logError, 'Failed to delete follow-up records');
  }

  // followup_history references the follow-up campaign — remove explicitly.
  const { error: historyError } = await supabase
    .from(HISTORY_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId);
  if (historyError && historyError.code !== '42P01') {
    throw toError(historyError, 'Failed to delete follow-up history');
  }

  // Config rows referencing this follow-up campaign (either direction).
  const { error: configError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId);
  if (configError && configError.code !== '42P01') {
    throw toError(configError, 'Failed to remove follow-up configuration');
  }
  const { error: configAsOriginalError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('campaign_id', followupCampaignId);
  if (configAsOriginalError && configAsOriginalError.code !== '42P01') {
    throw toError(configAsOriginalError, 'Failed to remove follow-up configuration');
  }

  // The follow-up campaign's own related rows are deleted explicitly too
  // (their ON DELETE CASCADE FKs would also do it, but this works regardless
  // of the live FK set). Only records belonging to this follow-up campaign are
  // touched — never the original campaign, contacts, or unrelated email logs.
  const relatedDeletes = [
    ['campaign_analytics', 'campaign_id'],
    ['campaign_attachments', 'campaign_id'],
    ['campaign_contacts', 'campaign_id'],
    ['campaign_schedules', 'campaign_id'],
    ['email_logs', 'campaign_id'],
  ];
  for (const [table, column] of relatedDeletes) {
    const { error: relError } = await supabase.from(table).delete().eq(column, followupCampaignId);
    if (relError && relError.code !== '42P01') {
      throw toError(relError, `Failed to delete related ${table} records`);
    }
  }

  // Finally delete the follow-up campaign itself.
  const { data, error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', followupCampaignId)
    .select('*')
    .maybeSingle();
  if (error && error.code !== '42P01') {
    throw toError(error, 'Failed to delete follow-up campaign');
  }
  if (!data) {
    const err = new Error('Follow-up configuration not found');
    err.status = 404;
    throw err;
  }
  return {
    id: configRow ? String(configRow.id) : followupCampaignId,
    campaign_id: configRow ? String(configRow.campaign_id) : 'all',
    followup_campaign_id: followupCampaignId,
    trigger_type: (configRow && configRow.trigger_type) || TRIGGER_TYPE,
    followup_mode: (configRow && configRow.followup_mode) || 'manual',
    is_active: configRow ? Boolean(configRow.is_active) : false,
  };
}

// ─── Follow-up log rows (campaign_followup_logs) ──────────────────────────

async function getLogRow(id) {
  const { data, error } = await supabase
    .from(LOG_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch follow-up record');
  return data || null;
}

async function getExistingLog(campaignId, contactId, followupCampaignId) {
  const { data, error } = await supabase
    .from(LOG_TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId)
    .eq('followup_campaign_id', followupCampaignId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to check for an existing follow-up');
  return data || null;
}

async function insertPendingLog({ campaignId, contactId, email, followupCampaignId, openedAt }) {
  const { data, error } = await supabase
    .from(LOG_TABLE)
    .insert({
      campaign_id: campaignId,
      contact_id: contactId,
      email,
      followup_campaign_id: followupCampaignId,
      opened_at: openedAt,
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) {
    // 23505 = unique_violation on (campaign_id, contact_id, followup_campaign_id)
    // → the follow-up is already queued/sent; treat as a no-op.
    if (error.code === '23505') return null;
    throw toError(error, 'Failed to record follow-up');
  }
  return data || null;
}

async function updateLogStatus(id, updates) {
  const { data, error } = await supabase
    .from(LOG_TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw toError(error, 'Failed to update follow-up record');
  return data || null;
}

// ─── Core email send ───────────────────────────────────────────────────────

/**
 * Send the configured follow-up campaign to a single recipient.
 *
 * Reuses the same personalisation pipeline as the bulk email worker: merge
 * tags are replaced, plain-text bodies converted to HTML, and the message is
 * logged in `email_logs` under the follow-up campaign so it is tracked (open
 * pixel + click links, handled by emailService.sendEmail) and counted in that
 * campaign's analytics.
 */
async function sendFollowupEmail(followupCampaignId, contactId, email) {
  const followupCampaign = await supabaseService.getCampaign(followupCampaignId);
  if (!followupCampaign) {
    const err = new Error('Follow-up campaign not found');
    err.status = 404;
    throw err;
  }

  let contact = null;
  try {
    contact = await supabaseService.getContactById(contactId);
  } catch (error) {
    console.warn(`[Followup] Contact ${contactId} not found — using email from the open event`);
  }
  contact = contact || {};

  // Log the message under the follow-up campaign. createEmailLogs attaches a
  // fresh tracking_id when the open/click tracking columns exist.
  const createdLogs = await emailLogService.createEmailLogs([
    {
      campaign_id: followupCampaignId,
      contact_id: contactId,
      email: contact.email || email,
      status: 'pending',
    },
  ]);
  const createdLog = createdLogs && createdLogs[0];
  if (!createdLog) {
    const err = new Error('Failed to queue the follow-up email');
    err.status = 500;
    throw err;
  }

  // campaign_contacts for the follow-up campaign must contain ONLY the contacts
  // that actually receive the follow-up — never the full audience. This row is
  // what drives recipient_count and the analytics total, so it is linked here.
  // Best-effort: a failure must not fail the send.
  try {
    await supabaseService.linkContactToCampaign(followupCampaignId, contactId);
  } catch (error) {
    console.warn(`[Followup] Could not link follow-up recipient to campaign_contacts: ${error.message}`);
  }

  const decoded = decodeHtmlEntities(
    personalizeTemplate(followupCampaign.html_content || '', contact, email)
  );
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);

  let htmlToSend = personalizedHtml;
  if (trackingEdge.isEdge) {
    const { html: withEdgePixel, pixelUrl } = trackingEdge.appendEdgeTrackingPixel(
      personalizedHtml,
      followupCampaign.id,
      createdLog.email,
      createdLog.tracking_id || null
    );
    htmlToSend = withEdgePixel;
    console.log(`[Followup] Edge tracking — follow-up campaign: ${followupCampaign.id} contact_email: ${createdLog.email}`);
    console.log(`[Followup] Edge tracking pixel URL: ${pixelUrl}`);
  }

  let sent = false;
  try {
    // Development-only diagnostics — proves THIS recipient's contact row is the
    // ONLY source of personalization for this email. No credentials are logged.
    console.log(`[Personalization] recipient=${createdLog.email}`);
    console.log(`[Personalization] contact_id=${contact.id || contactId || '(none)'}`);
    console.log(`[Personalization] full_name=${contact.full_name || ''}`);
    console.log(`[Personalization] company=${contact.company || ''}`);
    console.log(`[Personalization] designation=${contact.designation || ''}`);
    console.log(`[Personalization] rendered_subject=${String(personalizeTemplate(followupCampaign.subject_line, contact, email) || '').slice(0, 200)}`);
    console.log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

    await emailService.sendEmail({
      to: createdLog.email,
      subject: personalizeTemplate(followupCampaign.subject_line, contact, email),
      html: htmlToSend,
      text: plainText,
      campaignId: followupCampaign.id,
      recipientId: contactId,
      trackingId: createdLog.tracking_id,
    });
    sent = true;
    console.log(`[Followup] Follow-up sent to ${createdLog.email} (follow-up campaign: ${followupCampaignId})`);
  } finally {
    if (sent) {
      try {
        await emailLogService.updateEmailLog(createdLog.id, {
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`[Followup] Follow-up delivered but email_log could not be marked sent: ${error.message}`);
      }
    }
  }

  // Keep the follow-up campaign's analytics in sync (best-effort). The
  // delivered/open counts are computed from the follow-up campaign's own
  // email_logs, so they always reflect the actual follow-up recipients.
  try {
    await emailLogService.syncCampaignAnalytics(followupCampaignId);
    const logs = await emailLogService.getLogsByCampaign(followupCampaignId);
    await supabaseService.updateCampaignStatus(followupCampaignId, {
      recipient_count: logs.length,
    });
  } catch (error) {
    console.warn(`[Followup] Analytics sync for follow-up campaign failed (non-fatal): ${error.message}`);
  }

  return createdLog;
}

// ─── Automatic mode ────────────────────────────────────────────────────────

/**
 * Send the follow-up automatically (no cron). Skips when the recipient has
 * already received this follow-up. Marks the log row sent/failed so the
 * Pending Follow-ups tab reflects the outcome.
 */
async function sendAutomaticFollowup(campaignId, contactId, email, followupCampaignId, openedAt) {
  let log = await getExistingLog(campaignId, contactId, followupCampaignId);
  if (log && ['sent', 'already_sent'].includes(log.status)) {
    console.log(`[Followup] Automatic follow-up already sent to ${email} — skipping`);
    return log;
  }
  if (!log) {
    log = await insertPendingLog({ campaignId, contactId, email, followupCampaignId, openedAt });
    if (!log) return null; // concurrent insert won the race
  }

  try {
    await sendFollowupEmail(followupCampaignId, contactId, email);
    const sentAt = new Date().toISOString();
    await updateLogStatus(log.id, { status: 'sent', sent_at: sentAt });
    await recordFollowupHistory({
      campaignId,
      contactId,
      followupCampaignId,
      followupMode: 'automatic',
      status: 'sent',
      openedAt,
      sentAt,
    });
  } catch (error) {
    console.error(`[Followup] Automatic follow-up FAILED for ${email}: ${error.message}`);
    try {
      await updateLogStatus(log.id, { status: 'failed', error_message: error.message });
    } catch (innerError) {
      console.error(`[Followup] Could not mark automatic follow-up failed: ${innerError.message}`);
    }
  }
  return log;
}

/**
 * Entry point called by trackingService.recordOpen after a genuine first open.
 *
 * Manual mode returns the created follow-up log row; automatic mode sends
 * inline and returns null. Never throws — a follow-up failure must not break
 * the open-tracking reply.
 */
export async function handleOpenFollowup(campaignId, contactId, email) {
  if (!campaignId || !contactId || !email) {
    console.warn('[Followup] handleOpenFollowup skipped — missing campaign/contact/email');
    return null;
  }

  const config = await getFollowupConfig(campaignId);
  if (!config || config.is_active !== true || !config.followup_campaign_id) {
    return null; // no follow-up configured for this campaign
  }

  const followupCampaignId = String(config.followup_campaign_id);
  const openedAt = new Date().toISOString();

  // Scheduled follow-ups are delivered by the campaign scheduler at their
  // scheduled times — never on-open (automatic) or queue-on-open (manual).
  if (await isScheduledFollowup(followupCampaignId)) {
    return null;
  }

  if (config.followup_mode === 'automatic') {
    await sendAutomaticFollowup(campaignId, contactId, email, followupCampaignId, openedAt);
    return null;
  }

  return insertPendingLog({ campaignId, contactId, email, followupCampaignId, openedAt });
}

// ─── Opened contacts for a campaign ────────────────────────────────────────

/**
 * List the contacts who actually opened a specific campaign.
 *
 * Reads email_logs rows where campaign_id matches AND opened = true (the open
 * pixel marks these), then decorates each row with the contact's name/company/
 * designation from the contacts table. Contacts who did not open never appear.
 *
 * @param {string} campaignId
 * @returns {Promise<Array<{contact_id, name, email, company, designation, opened_at, campaign_id}>>}
 */
export async function getOpenedContacts(campaignId) {
  if (!campaignId) {
    const err = new Error('campaign_id is required');
    err.status = 400;
    throw err;
  }

  // The synthesized "All" row anchors its send panel to the union of openers
  // across every eligible original campaign.
  if (String(campaignId) === 'all') {
    return getOpenedContactsForAll();
  }

  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .eq('campaign_id', campaignId)
    .eq('opened', true)
    .order('opened_at', { ascending: false });
  if (error) throw toError(error, 'Failed to fetch opened contacts');

  const rows = logs || [];
  if (rows.length === 0) return [];

  let contacts = [];
  try {
    contacts = await supabaseService.fetchContacts();
  } catch (contactError) {
    console.warn(`[Followup] Could not resolve contact names: ${contactError.message}`);
  }
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id)) || {};
    return {
      contact_id: row.contact_id,
      name: contact.full_name || contact.name || '',
      email: row.email || contact.email || '',
      company: contact.company || '',
      designation: contact.designation || '',
      opened_at: row.opened_at,
      campaign_id: row.campaign_id,
    };
  });
}

/**
 * Union of opened contacts across ALL eligible original campaigns, deduped by
 * contact id (fallback: normalized email). Only contacts who opened at least
 * one eligible campaign (email_logs opened=true) appear; a contact who opened
 * several campaigns is listed once, using their latest open.
 *
 * Backs the "All · {N} opened" option in the Follow-ups composer dropdown.
 * Recipients are NEVER the audience/app-wide contact list.
 *
 * @returns {Promise<Array<{contact_id, name, email, company, designation, opened_at, campaign_id}>>}
 */
export async function getOpenedContactsForAll() {
  const eligible = await listEligibleOriginalCampaigns();
  if (eligible.length === 0) return [];

  const ids = eligible.map((c) => String(c.id));
  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .in('campaign_id', ids)
    .eq('opened', true);
  if (error) throw toError(error, 'Failed to fetch opened contacts');

  const byKey = new Map();
  for (const log of logs || []) {
    const key = String(log.contact_id || '') || normalizeEmail(log.email);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || new Date(log.opened_at || 0) > new Date(existing.opened_at || 0)) {
      byKey.set(key, log);
    }
  }

  const rows = [...byKey.values()].sort(
    (a, b) => new Date(b.opened_at || 0) - new Date(a.opened_at || 0)
  );

  let contacts = [];
  try {
    contacts = await supabaseService.fetchContacts();
  } catch (contactError) {
    console.warn(`[Followup] Could not resolve contact names: ${contactError.message}`);
  }
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id)) || {};
    return {
      contact_id: row.contact_id,
      name: contact.full_name || contact.name || '',
      email: row.email || contact.email || '',
      company: contact.company || '',
      designation: contact.designation || '',
      opened_at: row.opened_at,
      campaign_id: row.campaign_id,
    };
  });
}

/**
 * Build the opened-contact map for an "all campaigns" send: every opened
 * email_logs row for the given contact ids across ALL campaigns, collapsed to
 * one entry per contact (latest opened_at wins). Returns a Map keyed by
 * contact id → { contact_id, email, opened_at, campaign_id }.
 */
async function getOpenedAcrossAllCampaigns(contactIds) {
  const { data: openedLogs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .eq('opened', true)
    .in('contact_id', contactIds);
  if (error) throw toError(error, 'Failed to verify opened contacts');

  const byContact = new Map();
  for (const log of openedLogs || []) {
    const key = String(log.contact_id);
    const existing = byContact.get(key);
    if (!existing || new Date(log.opened_at || 0) > new Date(existing.opened_at || 0)) {
      byContact.set(key, log);
    }
  }
  return byContact;
}

/**
 * Record a follow-up outcome into the followup_history audit table.
 * Best-effort — a history insert failure must never fail the send.
 */
async function recordFollowupHistory({
  campaignId,
  contactId,
  followupCampaignId,
  triggerType = TRIGGER_TYPE,
  followupMode = 'manual',
  status,
  openedAt = null,
  sentAt = null,
}) {
  const { error } = await supabase
    .from(HISTORY_TABLE)
    .insert({
      campaign_id: campaignId,
      followup_campaign_id: followupCampaignId,
      contact_id: contactId,
      trigger_type: triggerType,
      followup_mode: followupMode,
      status,
      opened_at: openedAt || null,
      followup_sent_at: sentAt || null,
    });
  if (error && error.code !== '42P01') {
    console.warn(`[Followup] followup_history insert failed (non-fatal): ${error.message}`);
  }
}

/**
 * Send the configured follow-up campaign to a set of selected contacts.
 *
 * Used by MANUAL mode in the Follow-up UI: the user checks opened contacts and
 * clicks Send Follow-up. This sends ONLY to the selected contacts, and only if
 * each one genuinely opened the original campaign (verified against email_logs
 * opened=true — a non-opener is skipped, never emailed).
 *
 * Duplicate protection: a contact whose follow-up already has a 'sent' row in
 * campaign_followup_logs for this (campaign, follow-up campaign) pair is
 * skipped, even if selected. Every outcome is recorded in campaign_followup_logs
 * and followup_history; the email itself is logged in email_logs by
 * sendFollowupEmail.
 *
 * @param {string} campaignId  The ORIGINAL campaign id, or 'all' to verify against
 *                             every eligible campaign (union recipients, deduped).
 * @param {object} payload     { contact_ids: string[], followup_campaign_id: string }
 * @returns {Promise<Array<{contact_id, name, email, status, reason?}>>}
 */
export async function sendFollowupsToSelected(campaignId, payload = {}) {
  if (!campaignId) {
    const err = new Error('campaign_id is required');
    err.status = 400;
    throw err;
  }

  const isAll = String(campaignId) === 'all';
  const contactIds = Array.isArray(payload.contact_ids)
    ? payload.contact_ids.map((id) => String(id))
    : [];
  if (contactIds.length === 0) {
    const err = new Error('Select at least one opened contact');
    err.status = 400;
    throw err;
  }

  const followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id)
    : '';
  if (!followupCampaignId) {
    const err = new Error('Follow-up campaign is required');
    err.status = 400;
    throw err;
  }
  if (!isAll && followupCampaignId === String(campaignId)) {
    const err = new Error('A campaign cannot be its own follow-up campaign');
    err.status = 400;
    throw err;
  }

  // A scheduled follow-up is delivered by the campaign scheduler at its
  // scheduled times — it cannot be sent on-demand via the manual panel.
  if (await isScheduledFollowup(followupCampaignId)) {
    const err = new Error('This follow-up is scheduled — it will be sent automatically at its scheduled time');
    err.status = 400;
    throw err;
  }

  // Verify which selected contacts actually opened the campaign(s). For an
  // "all campaigns" selection, opened contacts are verified across EVERY
  // campaign and collapsed to one entry per contact (latest open wins) so a
  // contact who opened several campaigns is still sent exactly once.
  let openedByContact;
  if (isAll) {
    openedByContact = await getOpenedAcrossAllCampaigns(contactIds);
  } else {
    const { data: openedLogs, error } = await supabase
      .from('email_logs')
      .select('contact_id, email, opened_at')
      .eq('campaign_id', campaignId)
      .eq('opened', true)
      .in('contact_id', contactIds);
    if (error) throw toError(error, 'Failed to verify opened contacts');
    openedByContact = new Map((openedLogs || []).map((l) => [String(l.contact_id), l]));
  }

  let contacts = [];
  try {
    contacts = await supabaseService.fetchContacts();
  } catch (contactError) {
    console.warn(`[Followup] Could not resolve contact names: ${contactError.message}`);
  }
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  const results = [];
  for (const contactId of contactIds) {
    const openedLog = openedByContact.get(String(contactId));
    const contact = contactById.get(String(contactId)) || {};
    const email = (openedLog && openedLog.email) || contact.email || '';
    const name = contact.full_name || contact.name || '';

    if (!openedLog || (isAll && !openedLog.campaign_id)) {
      results.push({ contact_id: contactId, name, email, status: 'skipped', reason: 'not_opened' });
      continue;
    }

    // For "all", the log row is anchored to the campaign where the contact
    // actually opened, preserving the (campaign_id, contact_id, follow-up) key.
    const logCampaignId = isAll ? String(openedLog.campaign_id) : String(campaignId);

    const existing = await getExistingLog(logCampaignId, contactId, followupCampaignId);
    if (existing && ['sent', 'already_sent'].includes(existing.status)) {
      results.push({ contact_id: contactId, name, email, status: 'skipped', reason: 'already_sent' });
      continue;
    }

    try {
      await sendFollowupEmail(followupCampaignId, contactId, email);
      const sentAt = new Date().toISOString();
      if (existing) {
        await updateLogStatus(existing.id, { status: 'sent', sent_at: sentAt });
      } else {
        const inserted = await insertPendingLog({
          campaignId: logCampaignId,
          contactId,
          email,
          followupCampaignId,
          openedAt: openedLog.opened_at || null,
        });
        const row = inserted || (await getExistingLog(logCampaignId, contactId, followupCampaignId));
        if (row) await updateLogStatus(row.id, { status: 'sent', sent_at: sentAt });
      }
      await recordFollowupHistory({
        campaignId: logCampaignId,
        contactId,
        followupCampaignId,
        followupMode: 'manual',
        status: 'sent',
        openedAt: openedLog.opened_at || null,
        sentAt,
      });
      results.push({ contact_id: contactId, name, email, status: 'sent' });
    } catch (error) {
      console.error(`[Followup] Follow-up send FAILED for ${email}: ${error.message}`);
      results.push({ contact_id: contactId, name, email, status: 'failed', reason: error.message });
    }
  }

  return results;
}

// ─── Pending Follow-ups tab ────────────────────────────────────────────────

/**
 * List follow-up log rows (newest first) decorated with campaign and contact
 * names so the Pending Follow-ups tab can render "Recipient / Original
 * Campaign / Follow-up Campaign" columns.
 */
export async function listPendingFollowups() {
  const { data: logs, error } = await supabase
    .from(LOG_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error, 'Failed to fetch follow-up records');

  const rows = logs || [];

  let campaigns = [];
  try {
    campaigns = await supabaseService.listCampaigns();
  } catch (listError) {
    console.warn(`[Followup] Could not resolve campaign names: ${listError.message}`);
  }
  const nameById = new Map(campaigns.map((c) => [String(c.id), c.campaign_name || '']));

  let contacts = [];
  try {
    contacts = await supabaseService.fetchContacts();
  } catch (contactError) {
    console.warn(`[Followup] Could not resolve contact names: ${contactError.message}`);
  }
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id));
    return {
      ...row,
      campaign_name: nameById.get(String(row.campaign_id)) || '—',
      followup_campaign_name: nameById.get(String(row.followup_campaign_id)) || '—',
      recipient_name: contact ? (contact.full_name || contact.name || '') : '',
    };
  });
}

/**
 * Send one pending (or previously failed) follow-up immediately. Used by the
 * "Send Follow-up" button in the Pending Follow-ups tab.
 */
export async function sendPendingFollowup(pendingId) {
  const pending = await getLogRow(pendingId);
  if (!pending) {
    const err = new Error('Follow-up record not found');
    err.status = 404;
    throw err;
  }
  if (pending.status === 'sent' || pending.status === 'already_sent') {
    const err = new Error('This follow-up has already been sent');
    err.status = 400;
    throw err;
  }

  // Re-verify the recipient genuinely opened the original campaign before
  // sending. A follow-up must NEVER go to a non-opener — even via a queued row.
  const { data: openedCheck, error: openedCheckError } = await supabase
    .from('email_logs')
    .select('contact_id')
    .eq('campaign_id', pending.campaign_id)
    .eq('contact_id', pending.contact_id)
    .eq('opened', true)
    .limit(1);
  if (openedCheckError) throw toError(openedCheckError, 'Failed to verify the recipient opened the original campaign');
  if (!openedCheck || openedCheck.length === 0) {
    const err = new Error('Recipient did not open the original campaign — follow-up not sent');
    err.status = 400;
    throw err;
  }

  try {
    await sendFollowupEmail(pending.followup_campaign_id, pending.contact_id, pending.email);
    const sentAt = new Date().toISOString();
    await updateLogStatus(pending.id, { status: 'sent', sent_at: sentAt });
    await recordFollowupHistory({
      campaignId: pending.campaign_id,
      contactId: pending.contact_id,
      followupCampaignId: pending.followup_campaign_id,
      followupMode: 'manual',
      status: 'sent',
      openedAt: pending.opened_at || null,
      sentAt,
    });
    return { id: pending.id, status: 'sent' };
  } catch (error) {
    try {
      await updateLogStatus(pending.id, { status: 'failed', error_message: error.message });
    } catch (innerError) {
      console.error(`[Followup] Could not mark pending follow-up failed: ${innerError.message}`);
    }
    throw error;
  }
}
