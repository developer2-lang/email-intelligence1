/**
 * Background email worker.
 *
 * Processes the email queue for a single campaign in batches:
 *   - Batch size: BATCH_SIZE (env, default 10) emails
 *   - Per-email delay: EMAIL_DELAY_MS (env, default 1000 ms) — paces sends to
 *     ~1 message/second sustained, which is the sending rate Gmail's SMTP is
 *     built for. Bursts (e.g. 20 emails back-to-back) trigger Gmail's rate
 *     limiter ("421 4.7.0") and are more likely to land in Spam, so each
 *     message is spaced out instead of fired in a tight loop.
 *   - Wait: BATCH_DELAY_MS (env, default 5000 ms) between batches
 *   - Retry: up to 3 times with 30 s / 60 s / 120 s delays
 *
 * The API triggers processCampaign() and returns immediately; the worker
 * runs in the background within the same Node.js process.
 */
import { randomUUID } from 'node:crypto';
import * as emailService from '../services/emailService.js';
import * as emailLogService from '../services/emailLogService.js';
import { personalizeTemplate, stripHtml, buildTrackedHtml, decodeHtmlEntities, hasHtmlTags, plainTextToHtml } from '../utils/emailTemplate.js';
import * as supabaseService from '../services/supabaseService.js';
import trackingConfig from '../config/tracking.js';
import trackingEdge from '../config/trackingEdge.js';

const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE, 10) || 10);
const EMAIL_DELAY_MS = Math.max(0, parseInt(process.env.EMAIL_DELAY_MS, 10) || 1000);
const BATCH_DELAY_MS = Math.max(0, parseInt(process.env.BATCH_DELAY_MS, 10) || 5000);
const RETRY_DELAYS = [30, 60, 120]; // seconds after attempt 1, 2, 3

// Campaign ids currently being processed — prevents duplicate workers.
const _processing = new Set();

let _workerStarted = false;
let _trackingEnabled = false;

/**
 * Write a terminal campaign status ONLY while the worker still owns the
 * campaign claim ('sending'). Guarding with status='sending' means a stale
 * finalize can never stomp a campaign that a concurrent scheduler already
 * claimed, advanced to its next recurring occurrence, or finalized.
 */
async function finalizeCampaignStatus(campaignId, updates) {
  const { data, error } = await supabaseService.supabase
    .from('campaigns')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'sending');
  if (error) throw new Error(`Failed to update campaign status: ${error.message}`);
  return data;
}

/**
 * Start the email worker service.
 *
 * The worker itself is event-driven (processCampaign is invoked by the API
 * and by the campaign scheduler), so on startup we resume any campaign that a
 * previous backend process left in "sending"/"pending" after a crash. This
 * guarantees an interrupted send is completed rather than orphaned.
 */
function startEmailWorker() {
  if (_workerStarted) return;
  _workerStarted = true;
  console.log('[Worker] Started — email worker service active');
  void resumeInterruptedCampaigns();
}

/**
 * Find campaigns left in "sending"/"pending" by a previous process and resume
 * them. processCampaign is idempotent for this case: it re-marks the campaign
 * "sending", only inserts missing email_logs, and drains whatever is pending.
 */
async function resumeInterruptedCampaigns() {
  try {
    const { data, error } = await supabaseService.supabase
      .from('campaigns')
      .select('id, campaign_name')
      .in('status', ['sending', 'pending']);

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log('[Worker] No interrupted campaigns to resume');
      return;
    }

    console.log(`[Worker] Resuming ${data.length} interrupted campaign(s) after restart`);
    for (const campaign of data) {
      processCampaign(campaign.id).catch((err) => {
        console.error(`[Worker] Resume failed for campaign ${campaign.id}: ${err.message}`);
      });
    }
  } catch (error) {
    console.error(`[Worker] Failed to check for interrupted campaigns: ${error.message}`);
  }
}

/**
 * Ensure the required Supabase tables exist.
 * Creates email_logs and campaign_contacts if missing.
 */
async function ensureTablesExist() {
  const client = supabaseService.supabase;

  // Check email_logs
  const { error: logsCheck } = await client
    .from('email_logs')
    .select('id')
    .limit(1);

  if (logsCheck && logsCheck.code === '42P01') {
    console.warn('[Worker] email_logs table does not exist. Attempting to create...');
    const { error: createLogs } = await client.rpc('exec_sql', {
      query: `
        CREATE TABLE IF NOT EXISTS email_logs (
          id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          campaign_id    UUID NOT NULL,
          contact_id     UUID NOT NULL,
          email          TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending',
          error_message  TEXT,
          sent_at        TIMESTAMPTZ,
          retry_count    INTEGER DEFAULT 0,
          last_attempt_at TIMESTAMPTZ,
          next_retry_at  TIMESTAMPTZ,
          created_at     TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_email_logs_campaign ON email_logs(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
      `,
    });

    if (createLogs) {
      console.error('[Worker] FAILED to create email_logs table:', createLogs.message);
      console.error('[Worker] Please create the table manually in Supabase Dashboard → SQL Editor:');
      console.error(`[Worker]
CREATE TABLE IF NOT EXISTS email_logs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id    UUID NOT NULL,
  contact_id     UUID NOT NULL,
  email          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  error_message  TEXT,
  sent_at        TIMESTAMPTZ,
  retry_count    INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign ON email_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);`);
      throw new Error(
        'email_logs table does not exist and could not be created automatically. ' +
        'Please create it in Supabase Dashboard → SQL Editor using the SQL shown in this error.'
      );
    }
    console.log('[Worker] email_logs table created successfully');
  } else {
    console.log('[Worker] email_logs table exists');
  }

  // Check campaign_contacts
  const { error: ccCheck } = await client
    .from('campaign_contacts')
    .select('campaign_id')
    .limit(1);

  if (ccCheck && ccCheck.code === '42P01') {
    console.warn('[Worker] campaign_contacts table does not exist. Attempting to create...');
    const { error: createCC } = await client.rpc('exec_sql', {
      query: `
        CREATE TABLE IF NOT EXISTS campaign_contacts (
          campaign_id UUID NOT NULL,
          contact_id  UUID NOT NULL,
          PRIMARY KEY (campaign_id, contact_id)
        );
      `,
    });

    if (createCC) {
      console.error('[Worker] FAILED to create campaign_contacts table:', createCC.message);
      console.error('[Worker] Please create the table manually in Supabase Dashboard → SQL Editor:');
      console.error(`[Worker]
CREATE TABLE IF NOT EXISTS campaign_contacts (
  campaign_id UUID NOT NULL,
  contact_id  UUID NOT NULL,
  PRIMARY KEY (campaign_id, contact_id)
);`);
      throw new Error(
        'campaign_contacts table does not exist and could not be created automatically. ' +
        'Please create it in Supabase Dashboard → SQL Editor using the SQL shown in this error.'
      );
    }
    console.log('[Worker] campaign_contacts table created successfully');
  } else {
    console.log('[Worker] campaign_contacts table exists');
  }

  // Verify email_logs has every core column the worker depends on. A missing
  // column fails later queries with a cryptic 42703, so fail fast and print
  // the fix. The tracking columns below are optional and checked separately.
  const requiredColumns = [
    'id', 'campaign_id', 'contact_id', 'email', 'status',
    'error_message', 'sent_at', 'retry_count', 'last_attempt_at', 'next_retry_at', 'created_at',
  ];
  const { error: colError } = await client
    .from('email_logs')
    .select(requiredColumns.join(','))
    .limit(1);
  if (colError && colError.code === '42703') {
    console.error('[Worker] email_logs table is MISSING required columns.');
    console.error(`[Worker] First missing column error: ${colError.message}`);
    console.error('[Worker] Run this SQL in Supabase Dashboard → SQL Editor:');
    console.error(`[Worker]
ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at    TIMESTAMPTZ;`);
    throw new Error(
      'email_logs table is missing required columns. Run the ALTER SQL printed above ' +
      'in Supabase Dashboard → SQL Editor, then send the campaign again.'
    );
  }
  if (colError) {
    throw new Error(`Failed to verify email_logs schema: ${colError.message}`);
  }

  // Optional open/click tracking columns. When the tracking migration has not
  // been applied, emails still send normally — they just carry no tracking.
  const { error: trackErr } = await client
    .from('email_logs')
    .select('tracking_id, opened, clicked')
    .limit(1);
  if (trackErr && trackErr.code === '42703') {
    _trackingEnabled = false;
    console.warn('[Worker] email_logs tracking columns missing — open/click tracking DISABLED.');
    console.warn('[Worker] To enable tracking, run backend/email_tracking_migration.sql in Supabase SQL Editor.');
  } else if (trackErr) {
    throw new Error(`Failed to verify email_logs tracking columns: ${trackErr.message}`);
  } else {
    _trackingEnabled = true;
    console.log('[Worker] email_logs tracking columns verified OK');
  }
  console.log('[Worker] email_logs column schema verified OK');
}

/**
 * Resolve the HTML body for a campaign send: when the campaign references a
 * template (template_id), the ORIGINAL template HTML is fetched from the
 * templates table / Storage at send time so template edits propagate to the
 * send (the stored html_content is only a copy). Falls back to the stored
 * html_content when there is no template reference or the fetch fails.
 */
async function resolveCampaignBodyHtml(campaign) {
  if (campaign && campaign.template_id) {
    try {
      const html = await supabaseService.fetchTemplateHtml(campaign.template_id);
      if (html && String(html).trim()) {
        console.log(
          `[Worker] Campaign ${campaign.id} uses template ${campaign.template_id} — ` +
          `fetched ORIGINAL template HTML (${html.length} chars).`
        );
        return html;
      }
    } catch (err) {
      console.warn(
        `[Worker] Failed to fetch template ${campaign.template_id} for campaign ${campaign.id}: ` +
        `${err.message} — falling back to stored body.`
      );
    }
  }
  return (campaign && campaign.html_content) || '';
}

/**
 * Send one email, personalise the template, handle errors.
 */
async function sendOneEmail(log, campaign, contactMap, index = 0, total = 0) {
  const contact = contactMap.get(log.contact_id) || {};

  // The composer is a plain-text editor, so the stored body is plain text with
  // {{placeholder}} tags. Pipeline: 1) replace placeholders with recipient
  // data, 2) decode any legacy escaped markup from older rich-text campaigns,
  // 3) convert the plain text into clean HTML (paragraphs, <br>, lists, escaped
  // entities) — or pass pre-existing HTML through untouched for backward
  // compatibility. Tracking (open pixel + click links) is added afterwards.
  const bodyHtml = await resolveCampaignBodyHtml(campaign);
  const decoded = decodeHtmlEntities(
    personalizeTemplate(bodyHtml, contact, log.email)
  );
  const personalizedHtml = hasHtmlTags(decoded)
    ? decoded
    : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);

  // Tracking: each email_log row carries a unique tracking_id embedded in the
  // open pixel and click links. This only runs when the tracking migration has
  // been applied AND a live public TRACKING_BASE_URL is configured; otherwise
  // emails go out without the legacy pixel and sending still works normally.
  // (The legacy pixel/click URLs are dead weight when baseUrl is empty or
  // points to an expired tunnel — see config/tracking.js.)
  let htmlToSend = personalizedHtml;
  if (_trackingEnabled && trackingConfig.baseUrl) {
    let trackingId = log.tracking_id || null;
    if (!trackingId) {
      trackingId = randomUUID();
      await emailLogService.updateEmailLog(log.id, { tracking_id: trackingId });
      log.tracking_id = trackingId;
      console.log(`[Worker] Generated tracking_id for existing log row: ${trackingId}`);
    }
    htmlToSend = buildTrackedHtml(
      personalizedHtml,
      trackingId,
      trackingConfig.baseUrl,
      campaign.id,
      log.contact_id
    );
  } else if (_trackingEnabled) {
    console.warn(`[Worker] TRACKING_BASE_URL not set — legacy pixel/link rewrite skipped for ${log.email}`);
    console.warn(`[Worker] Open tracking for this email is handled by the Supabase Edge Function pixel (TRACKING_MODE=${trackingEdge.isEdge ? 'edge' : 'legacy'}).`);
  }

  // EDGE-mode (test-only): when TRACKING_MODE=edge, ALSO append the Supabase
  // Edge Function tracking pixel alongside the legacy pixel. Additive only —
  // the legacy tracking_id flow above is untouched and still runs. The pixel
  // carries this email_log's tracking_id so the Edge Function marks exactly
  // this recipient's log opened.
  if (trackingEdge.isEdge) {
    const { html: withEdgePixel, pixelUrl } = trackingEdge.appendEdgeTrackingPixel(
      htmlToSend,
      campaign.id,
      log.email,
      log.tracking_id || null
    );
    htmlToSend = withEdgePixel;
    console.log(`[Worker] Edge tracking — campaign_id: ${campaign.id} contact_email: ${log.email}`);
    console.log(`[Worker] Edge tracking pixel URL: ${pixelUrl}`);
  }

  const recipientLabel = total > 0 ? `[${index}/${total}] ` : '';
  console.log(`[Worker] Sending email ${recipientLabel}to: ${log.email}`);
  console.log(`[Worker] Subject: ${personalizeTemplate(campaign.subject_line, contact, log.email)}`);
  console.log(`[Worker] HTML length: ${htmlToSend.length} chars${_trackingEnabled ? ' (tracked)' : ' (no tracking)'}`);
  if (_trackingEnabled) {
    console.log(`[Worker] Tracking id: ${log.tracking_id}`);
    console.log(`[Worker] First tracked link: ${htmlToSend.match(/api\/tracking\/click\/[^"'\s>]+/i)?.[0] || '(none)'}`);
    console.log(`[Worker] Open pixel URL: ${trackingConfig.baseUrl}/api/tracking/open/${log.tracking_id}`);
  }

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  console.log(`[Personalization] recipient=${log.email}`);
  console.log(`[Personalization] contact_id=${contact.id || log.contact_id || '(none)'}`);
  console.log(`[Personalization] full_name=${contact.full_name || ''}`);
  console.log(`[Personalization] company=${contact.company || ''}`);
  console.log(`[Personalization] designation=${contact.designation || ''}`);
  console.log(`[Personalization] rendered_subject=${String(personalizeTemplate(campaign.subject_line, contact, log.email) || '').slice(0, 200)}`);
  console.log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  const result = await emailService.sendEmail({
    to: log.email,
    subject: personalizeTemplate(campaign.subject_line, contact, log.email),
    html: htmlToSend,
    text: plainText,
    campaignId: campaign.id,
    recipientId: log.contact_id,
    trackingId: log.tracking_id,
  });

  console.log(`[Worker] Email sent successfully to: ${log.email}`);
  console.log(`[Worker] SMTP ACCEPTED — messageId: ${result.messageId}`);
  console.log(`[Worker] SMTP response: ${String(result.response || '').replace(/\s+/g, ' ').trim()}`);
  return result;
}

/**
 * Classify a nodemailer/socket error into the stable audit buckets recorded per
 * recipient:
 *   SEND_REJECTED — the server returned an explicit 4xx/5xx SMTP response.
 *   SEND_TIMEOUT  — the connection / mail transaction timed out.
 *   SEND_FAILED   — everything else (auth failure, DNS, socket, transport).
 */
function classifySmtpResult(error) {
  const responseCode = Number(error && error.responseCode);
  const response = String((error && error.response) || '');
  const code = String((error && error.code) || '');
  const message = String((error && error.message) || '');

  if (responseCode >= 400 || /^[45]\d{2}\b/.test(response)) {
    return 'SEND_REJECTED';
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKET' ||
    code === 'ECONNECTION' ||
    /timed?\s*out|timeout/i.test(message)
  ) {
    return 'SEND_TIMEOUT';
  }
  return 'SEND_FAILED';
}

/**
 * Process the email queue for a single campaign until no pending emails remain.
 *
 * @param {string} campaignId
 * @returns {Promise<{sent: number, failed: number, total: number}>}
 */
async function processCampaign(campaignId) {
  console.log(`\n[Worker] ═══════════════════════════════════════════════════════`);
  console.log(`[Worker] processCampaign START — campaign: ${campaignId}`);
  console.log(`[Worker] ═══════════════════════════════════════════════════════`);

  if (_processing.has(campaignId)) {
    console.log(`[Worker] Campaign ${campaignId} already processing — skipping`);
    return { sent: 0, failed: 0, total: 0, skipped: true };
  }
  _processing.add(campaignId);

  try {
    // Step 0: Ensure tables exist.
    console.log(`[Worker] STEP 0: Checking Supabase tables...`);
    await ensureTablesExist();
    console.log(`[Worker] STEP 0: Tables OK`);

    // Step 1: Mark as sending.
    console.log(`[Worker] STEP 1: Marking campaign ${campaignId} as "sending"...`);
    await supabaseService.updateCampaignStatus(campaignId, { status: 'sending' });
    console.log(`[Worker] STEP 1: Done`);

    // Step 2: Fetch campaign from Supabase.
    console.log(`[Worker] STEP 2: Fetching campaign from Supabase...`);
    const campaign = await supabaseService.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found in Supabase`);
    console.log(`[Worker] STEP 2: Campaign found`);
    console.log(`[Worker]   name: "${campaign.campaign_name}"`);
    console.log(`[Worker]   segment: "${campaign.audience_segment}"`);
    console.log(`[Worker]   subject: "${campaign.subject_line}"`);
    console.log(`[Worker]   html_content length: ${(campaign.html_content || '').length}`);

    // Step 3: Resolve contacts. resolveContactsForCampaign applies the strict
    // follow-up rule: if this campaign is itself a follow-up campaign, ONLY the
    // contacts who opened its ORIGINAL campaign are eligible — never the full
    // audience segment. If nobody opened, the follow-up gets 0 recipients.
    console.log(`[Worker] STEP 3: Resolving contacts for segment "${campaign.audience_segment}"...`);
    const contacts = await supabaseService.resolveContactsForCampaign(campaignId, campaign.audience_segment);
    const followupInfo = await supabaseService.resolveFollowupRecipients(campaignId);
    console.log(`[Worker] STEP 3: Found ${contacts.length} valid contacts`);
    if (contacts.length === 0) {
      const reason = followupInfo.isFollowup
        ? `follow-up of ${followupInfo.sourceCampaignId} has no opened recipients`
        : `no deliverable contacts for segment "${campaign.audience_segment}"`;
      console.warn(`[Worker] STEP 3: ZERO recipients — ${reason}.`);
      console.warn(`[Worker] STEP 3: NOT sending. Marking campaign "${campaign.campaign_name}" (${campaignId}) as "failed" so it never falsely reports "sent".`);
      await finalizeCampaignStatus(campaignId, {
        status: 'failed',
        recipient_count: 0,
      });
      console.log(`[Worker] STEP 3: Campaign ${campaignId} marked "failed" (0 recipients).`);
      return { sent: 0, failed: 0, total: 0 };
    }
    if (followupInfo.isFollowup) {
      console.log(`[Worker] STEP 3: Follow-up recipients (openers only): ${contacts.map((c) => c.email).join(', ')}`);
    } else {
      console.log(`[Worker] STEP 3: Contact emails: ${contacts.map((c) => c.email).join(', ')}`);
    }

    const contactMap = new Map(contacts.map((c) => [c.id, c]));

    // ─── Batch-aware processing ───────────────────────────────────────────
    let batchRecordForThisRun = null;
    let batchContacts = contacts;
    let campaignBatchSize = BATCH_SIZE;
    let campaignBatchDelayMs = BATCH_DELAY_MS;

    if (campaign.send_in_batches) {
      campaignBatchSize = campaign.batch_size || 30;
      campaignBatchDelayMs = (campaign.subsequent_batch_delay_hours || 1) * 3600_000;

      const { data: existingBatches } = await supabaseService.supabase
        .from('campaign_batches')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('batch_number', { ascending: true });

      if (!existingBatches || existingBatches.length === 0) {
        const batchSize = campaignBatchSize;
        const firstDelay = campaign.first_batch_delay_hours || 2;
        const subsequentDelay = campaign.subsequent_batch_delay_hours || 1;
        const totalBatches = Math.ceil(contacts.length / batchSize);
        const nowTs = Date.now();

        await supabaseService.supabase.from('campaign_batches').delete().eq('campaign_id', campaignId);

        const batchRecords = [];
        for (let bn = 1; bn <= totalBatches; bn++) {
          const si = (bn - 1) * batchSize;
          const ei = Math.min(si + batchSize, contacts.length);
          let scheduledAt;
          if (bn === 1) {
            scheduledAt = new Date(nowTs);
          } else if (bn === 2) {
            scheduledAt = new Date(nowTs + firstDelay * 3600_000);
          } else {
            scheduledAt = new Date(nowTs + firstDelay * 3600_000 + (bn - 2) * subsequentDelay * 3600_000);
          }
          batchRecords.push({
            campaign_id: campaignId,
            batch_number: bn,
            batch_size: ei - si,
            start_index: si,
            end_index: ei - 1,
            recipient_count: ei - si,
            status: bn === 1 ? 'processing' : 'pending',
            scheduled_at: scheduledAt.toISOString(),
            next_batch_at: bn < totalBatches
              ? new Date(scheduledAt.getTime() + (bn === 1 ? firstDelay : subsequentDelay) * 3600_000).toISOString()
              : null,
            sent_count: 0,
            failed_count: 0,
          });
        }
        await supabaseService.supabase.from('campaign_batches').insert(batchRecords);
        console.log(`[Worker] Created ${totalBatches} batch record(s) for campaign ${campaignId}`);

        const { data: refetched } = await supabaseService.supabase
          .from('campaign_batches')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('batch_number', { ascending: true });
        const batches = refetched || batchRecords;
        const nowIso = new Date().toISOString();
        batchRecordForThisRun = batches.find((b) => b.status === 'pending' && b.scheduled_at <= nowIso)
          || batches.find((b) => b.status === 'pending');
      } else {
        const nowIso = new Date().toISOString();
        batchRecordForThisRun = existingBatches.find((b) => b.status === 'pending' && b.scheduled_at <= nowIso)
          || existingBatches.find((b) => b.status === 'pending');
      }

      if (!batchRecordForThisRun) {
        console.log(`[Worker] Campaign ${campaignId} is batched but no batch is due — skipping this tick.`);
        await finalizeCampaignStatus(campaignId, { status: 'scheduled', recipient_count: contacts.length });
        return { sent: 0, failed: 0, total: 0 };
      }

      batchContacts = contacts.slice(batchRecordForThisRun.start_index, batchRecordForThisRun.end_index + 1);
      console.log(`[Worker] Batch ${batchRecordForThisRun.batch_number}: ${batchContacts.length} recipient(s)`);

      await supabaseService.supabase
        .from('campaign_batches')
        .update({ status: 'processing', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('campaign_id', campaignId)
        .eq('batch_number', batchRecordForThisRun.batch_number);
    }

    // Step 4: Create email_logs for contacts not yet queued.
    console.log(`[Worker] STEP 4: Creating email_logs entries...`);
    const existingLogs = await emailLogService.getLogsByCampaign(campaignId);
    const alreadyQueued = new Set(existingLogs.map((l) => l.contact_id));
    const newContacts = batchContacts.filter((c) => !alreadyQueued.has(c.id));
    console.log(`[Worker] STEP 4: ${existingLogs.length} existing logs, ${newContacts.length} new contacts to queue`);

    if (newContacts.length > 0) {
      const logsToCreate = newContacts.map((c) => ({
        campaign_id: campaignId,
        contact_id: c.id,
        email: c.email,
        status: 'pending',
      }));
      console.log(`[Worker] STEP 4: Creating ${logsToCreate.length} email log entries...`);
      const createdLogs = await emailLogService.createEmailLogs(logsToCreate);
      console.log(`[Worker] STEP 4: Email logs created: ${createdLogs.length}`);
      for (const row of createdLogs) {
        console.log(`[Worker]   created email_log — id=${row.id} campaign_id=${row.campaign_id} contact_id=${row.contact_id} email=${row.email} tracking_id=${row.tracking_id}`);
      }
    }

    // Step 5: Process queue in batches.
    console.log(`[Worker] STEP 5: Processing email queue...`);
    let batchNum = 0;
    let totalSent = 0;
    let totalFailed = 0;

    while (true) {
      const pending = await emailLogService.getPendingEmailLogs(campaignId, campaignBatchSize);
      if (pending.length === 0) {
        console.log(`[Worker] STEP 5: No more pending emails`);
        break;
      }

      batchNum++;
      console.log(`[Worker] STEP 5: Batch ${batchNum} — ${pending.length} emails to send`);

      for (let i = 0; i < pending.length; i++) {
        const log = pending[i];
        // Pace each message ~1/sec so Gmail's SMTP rate limit is never hit
        // (bursts of fast sends trigger "421 Try again later" + Spam placement).
        if (i > 0 && EMAIL_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, EMAIL_DELAY_MS));
        }
        const emailNumber = totalSent + totalFailed + 1;
        try {
          const result = await sendOneEmail(log, campaign, contactMap, emailNumber, batchContacts.length);
          await emailLogService.updateEmailLog(log.id, {
            status: 'sent',
            sent_at: new Date().toISOString(),
          });
          totalSent++;
          console.log(`[Worker] STEP 5: ✓ Sent to ${log.email} (${totalSent} sent total)`);
          console.log(
            `[Worker] STEP 5: SMTP audit — recipient=${log.email} log_id=${log.id} tracking_id=${log.tracking_id} ` +
            `attempt=${emailNumber}/${contacts.length} result=SMTP_ACCEPTED final_status=sent ` +
            `messageId=${result.messageId} response=${String(result.response || '').replace(/\s+/g, ' ').trim()}`
          );
        } catch (error) {
          const smtpResult = classifySmtpResult(error);
          console.error(`[Worker] STEP 5: ✗ FAILED to send to ${log.email}`);
          console.error(`[Worker] Error message: ${error.message}`);
          console.error(`[Worker] Error stack: ${error.stack}`);

          const retryCount = (log.retry_count || 0) + 1;

          if (retryCount > RETRY_DELAYS.length) {
            console.error(`[Worker] STEP 5: Max retries reached for ${log.email} — marking as "failed"`);
            await emailLogService.updateEmailLog(log.id, {
              status: 'failed',
              error_message: `[${smtpResult}] ${error.message}`,
              retry_count: retryCount,
              last_attempt_at: new Date().toISOString(),
            });
            totalFailed++;
            console.log(
              `[Worker] STEP 5: SMTP audit — recipient=${log.email} log_id=${log.id} tracking_id=${log.tracking_id} ` +
              `attempt=${emailNumber}/${contacts.length} result=${smtpResult} final_status=failed ` +
              `error=${String(error.message).replace(/\s+/g, ' ').trim()}`
            );
          } else {
            const delaySec = RETRY_DELAYS[retryCount - 1];
            console.log(`[Worker] STEP 5: Scheduling retry ${retryCount} for ${log.email} in ${delaySec}s`);
            await emailLogService.updateEmailLog(log.id, {
              retry_count: retryCount,
              last_attempt_at: new Date().toISOString(),
              next_retry_at: new Date(Date.now() + delaySec * 1000).toISOString(),
              error_message: `[${smtpResult}] ${error.message}`,
            });
          }
        }
      }

      // Wait between batches (skip delay on the final batch).
      if (pending.length === campaignBatchSize) {
        console.log(`[Worker] STEP 5: Waiting ${campaignBatchDelayMs}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, campaignBatchDelayMs));
      }
    }

    // ─── Batch finalization ──────────────────────────────────────────────
    if (campaign.send_in_batches && batchRecordForThisRun) {
      const batchContactIds = new Set(batchContacts.map((c) => c.id));
      const { data: batchLogs } = await supabaseService.supabase
        .from('email_logs')
        .select('status')
        .eq('campaign_id', campaignId)
        .in('contact_id', Array.from(batchContactIds));
      const batchDelivered = (batchLogs || []).filter((l) => l.status === 'sent').length;
      const batchFailed    = (batchLogs || []).filter((l) => l.status === 'failed').length;
      const batchPending   = (batchLogs || []).filter((l) => l.status === 'pending' || l.status === 'sending').length;

      await supabaseService.supabase
        .from('campaign_batches')
        .update({
          status: batchPending > 0 ? 'processing' : 'completed',
          sent_count: batchDelivered,
          failed_count: batchFailed,
          completed_at: batchPending === 0 ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('campaign_id', campaignId)
        .eq('batch_number', batchRecordForThisRun.batch_number);

      console.log(`[Worker] Batch ${batchRecordForThisRun.batch_number} finalized: sent=${batchDelivered} failed=${batchFailed} pending=${batchPending}`);

      try { await emailLogService.syncCampaignAnalytics(campaignId); } catch { /* non-fatal */ }

      const { data: allBatches } = await supabaseService.supabase
        .from('campaign_batches')
        .select('batch_number, status, sent_count')
        .eq('campaign_id', campaignId)
        .order('batch_number', { ascending: true });

      const remainingPending = (allBatches || []).filter((b) => b.status === 'pending' || b.status === 'processing');

      if (remainingPending.length > 0) {
        await finalizeCampaignStatus(campaignId, { status: 'scheduled', recipient_count: contacts.length });
        console.log(`[Worker] Campaign ${campaignId} still has batch(es) pending — returned to "scheduled".`);
      } else {
        const totalDelivered = (allBatches || []).reduce((s, b) => s + (b.sent_count || 0), 0);
        if (totalDelivered > 0) {
          await finalizeCampaignStatus(campaignId, { status: 'sent', sent_at: new Date().toISOString(), recipient_count: contacts.length });
          console.log(`[Worker] Campaign ${campaignId} all batches complete — marked "sent" (${totalDelivered} delivered).`);
        } else {
          await finalizeCampaignStatus(campaignId, { status: 'failed', recipient_count: contacts.length });
          console.error(`[Worker] Campaign ${campaignId} all batches complete — 0 delivered, marked "failed".`);
        }
      }

      return { sent: totalSent, failed: totalFailed, total: contacts.length };
    }

    // Step 6: Finalize campaign.
    console.log(`[Worker] STEP 6: Finalizing campaign...`);
    const stats = await emailLogService.getLogsStats(campaignId);
    console.log(`[Worker] STEP 6: Stats — sent: ${stats.sent}, failed: ${stats.failed}, total: ${stats.total}`);

    // Seed / refresh the campaign_analytics row now that delivery is done.
    // This is best-effort: if it fails (analytics table missing, transient
    // Supabase error) it must NOT abort finalization — emails are already
    // delivered and the campaign still has to be marked "sent".
    console.log(`[Worker] STEP 6: Syncing campaign_analytics...`);
    try {
      const analytics = await emailLogService.syncCampaignAnalytics(campaignId);
      console.log(`[Worker] STEP 6: campaign_analytics synced: ${JSON.stringify(analytics)}`);
    } catch (analyticsError) {
      console.error(`[Worker] STEP 6: campaign_analytics sync FAILED (non-fatal): ${analyticsError.message}`);
    }

    // Mark the campaign "sent" (only when at least one email was actually
    // delivered) or "failed" (all recipients permanently failed). Guarded so a
    // stale finalize never stomps a claim the other scheduler now owns. Retry
    // once on a transient failure; never cascade into the outer catch, which
    // would otherwise overwrite a successfully delivered campaign.
    const deliveredCount = Number(stats.delivered) || 0;
    const finalStatus = deliveredCount > 0 ? 'sent' : 'failed';
    const finalUpdates = finalStatus === 'sent'
      ? { status: 'sent', sent_at: new Date().toISOString(), recipient_count: stats.total }
      : { status: 'failed', recipient_count: stats.total };
    let finalizedAsSent = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await finalizeCampaignStatus(campaignId, finalUpdates);
        finalizedAsSent = true;
        break;
      } catch (statusError) {
        console.error(`[Worker] STEP 6: marking "${finalStatus}" FAILED (attempt ${attempt}): ${statusError.message}`);
      }
    }
    if (finalizedAsSent) {
      console.log(`[Worker] STEP 6: Campaign ${campaignId} marked as "${finalStatus}"`);
    } else {
      console.error(`[Worker] STEP 6: WARNING — emails were delivered but campaign could not be finalized.`);
      console.error(`[Worker] STEP 6: Leaving status as-is; it will NOT be set to "failed".`);
    }

    console.log(`[Worker] ═══════════════════════════════════════════════════════`);
    console.log(`[Worker] processCampaign DONE — campaign: ${campaignId}`);
    console.log(`[Worker] ═══════════════════════════════════════════════════════\n`);

    return { sent: stats.sent, failed: stats.failed, total: stats.total };
  } catch (error) {
    console.error(`\n[Worker] ═══════════════════════════════════════════════════════`);
    console.error(`[Worker] FATAL ERROR for campaign ${campaignId}`);
    console.error(`[Worker] ═══════════════════════════════════════════════════════`);
    console.error(`[Worker] Error: ${error.message}`);
    console.error(`[Worker] Stack: ${error.stack}`);
    console.error(`[Worker] ═══════════════════════════════════════════════════════\n`);

    // Only mark the campaign "failed" when email sending itself failed — i.e.
    // zero emails were delivered. Any error that happens AFTER emails were sent
    // (analytics sync, final status write, post-send cleanup) must never
    // downgrade a campaign that already delivered emails.
    try {
      const stats = await emailLogService.getLogsStats(campaignId);
      if ((stats.delivered || 0) > 0) {
        console.warn(
          `[Worker] ${stats.delivered} email(s) already delivered before this error — NOT marking campaign "failed". ` +
          `Finalizing as "sent" so the delivered campaign shows the correct status.`
        );
        try {
          await finalizeCampaignStatus(campaignId, {
            status: 'sent',
            sent_at: new Date().toISOString(),
            recipient_count: stats.total,
          });
          console.log(`[Worker] Campaign ${campaignId} finalized as "sent" after error`);
        } catch (finalizeErr) {
          console.error(`[Worker] Could not finalize campaign as "sent": ${finalizeErr.message}`);
        }
      } else {
        await finalizeCampaignStatus(campaignId, { status: 'failed', recipient_count: stats.total || 0 });
        console.log(`[Worker] Campaign ${campaignId} marked as "failed"`);
      }
    } catch (statsError) {
      // Cannot determine the send state (e.g. Supabase unreachable). Never
      // guess "failed" — that could corrupt a campaign whose emails all went out.
      console.error(`[Worker] Could not determine send state before setting status: ${statsError.message}`);
      console.error(`[Worker] Leaving campaign ${campaignId} status as-is.`);
    }
    throw error;
  } finally {
    _processing.delete(campaignId);
  }
}

export { startEmailWorker, processCampaign };
