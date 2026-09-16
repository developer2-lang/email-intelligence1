/**
 * campaign-tracker — Supabase Edge Function open-tracking pixel (test-only).
 *
 * Runs ALONGSIDE the existing Express open tracking (backend/routes/trackingRoutes.js
 * + backend/services/trackingService.js) and never replaces it. The backend
 * embeds this pixel in emails only when TRACKING_MODE=edge (see
 * backend/config/trackingEdge.js).
 *
 * Endpoint:
 *   GET {SUPABASE_EDGE_FUNCTION_URL}/campaign-tracker
 *         ?action=track&campaign_id=<uuid>&contact_email=<email>[&tracking_id=<uuid>]
 *
 * On a track request it:
 *   1. finds the contact by email and sets contacts.email_opened = true,
 *   2. marks the matching email_log row opened = true, opened_at = now() —
 *      EXACTLY one row when `tracking_id` is present (a unique per-log UUID),
 *      otherwise all rows for the (campaign, email) pair (legacy fallback),
 *   3. recomputes campaign_analytics.opened / open_rate from email_logs
 *      (idempotent — safe to run alongside the legacy pixel),
 *   4. always returns a transparent 1x1 GIF so no broken-image icon shows.
 */ import { createClient } from 'npm:@supabase/supabase-js@2';
const supabaseUrl = Deno.env.get('R_SUPABASE_URL');
const supabaseKey = Deno.env.get('R_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
// Transparent 1x1 GIF.
const GIF_BASE64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const GIF_BODY = Uint8Array.from(atob(GIF_BASE64), (c)=>c.charCodeAt(0));
/**
 * Anti-bot grace period (seconds): an open is only recorded when the pixel is
 * fetched at least this long after the email was sent.
 *
 * IMPORTANT: default is 0 = DISABLED. Gmail's image proxy and Outlook prefetch
 * request each pixel URL exactly ONCE, seconds after delivery, and then serve
 * the cached image to the human later — so they never re-request the URL. Any
 * grace period here therefore means "Gmail/Outlook recipients are NEVER
 * recorded as opened" and the OPENED branch never fills. Counting the prefetch
 * as an open is the industry standard (every commercial ESP does it).
 *
 * Set `supabase secrets set TRACKING_MIN_OPEN_DELAY=<seconds>` only if you
 * explicitly want to filter — and be aware real Gmail/Outlook opens will be
 * lost.
 */ const MIN_OPEN_DELAY_SECONDS = (()=>{
  const value = Number(Deno.env.get('TRACKING_MIN_OPEN_DELAY'));
  return Number.isFinite(value) && value >= 0 ? value : 0;
})();
function isAutoOpen(sentAt) {
  if (!sentAt) return false; // legacy rows with no sent_at cannot be gated
  const sentMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentMs)) return false;
  return Date.now() - sentMs < MIN_OPEN_DELAY_SECONDS * 1000;
}
function log(...args) {
  console.log('[campaign-tracker]', ...args);
}
async function updateContact(email) {
  const { data: matches } = await supabase.from('contacts').select('id, email').eq('email', email).limit(1);
  const contact = matches?.[0];
  if (!contact) {
    log('Contact Updated — none found for', email);
    return;
  }
  const { error } = await supabase.from('contacts').update({
    email_opened: true
  }).eq('id', contact.id);
  if (error) {
    log('Contact Updated — FAILED', email, `code=${error.code}`, error.message);
    if (String(error.code).startsWith('PGRST')) {
      log('Hint: missing column contacts.email_opened? Run supabase/edge-tracking-setup.sql');
    }
    return;
  }
  log('Contact Updated —', contact.id, email);
}
async function findEmailLog(campaignId, email, trackingId) {
  // Locate the EXACT row first. tracking_id is unique per email_log and is the
  // primary identifier; campaign+email is only a legacy fallback for logs that
  // predate the tracking columns. Never use a broad match when tracking_id
  // exists.
  let find;
  if (trackingId) {
    find = supabase.from('email_logs').select('id, campaign_id, email, opened, sent_at').eq('tracking_id', trackingId).limit(1);
  } else {
    find = supabase.from('email_logs').select('id, campaign_id, email, opened, sent_at').eq('campaign_id', campaignId).eq('email', email).order('created_at', {
      ascending: true
    }).limit(1);
  }
  const { data: matches, error: readError } = await find;
  if (readError) {
    log('Email Log Read — FAILED', `code=${readError.code}`, readError.message);
    return null;
  }
  const row = matches?.[0];
  if (!row) {
    log('Email Log — NO MATCH', `campaign_id=${campaignId}`, `email=${email}`, trackingId ? `tracking_id=${trackingId}` : '(matched by campaign+email)');
    return null;
  }
  return row;
}
async function updateEmailLog(row) {
  const openedBefore = row.opened === true;
  if (!openedBefore) {
    const { error } = await supabase.from('email_logs').update({
      opened: true,
      opened_at: new Date().toISOString()
    }).eq('id', row.id);
    if (error) {
      log('Email Log Updated — FAILED', `code=${error.code}`, error.message);
      return null;
    }
  }
  // Keep the linked sequence_step_log(s) tracking flags in line with this
  // authoritative email_log record (matches the backend trackingService
  // behaviour), so the sequence Logs API / eligibility fallbacks and any direct
  // DB reads see the real open. Best-effort — never blocks the pixel reply.
  await syncStepLogFromEmailLog(row.id);
  log('Email Log Updated —', `log_id=${row.id}`, `campaign_id=${row.campaign_id}`, `email=${row.email}`, `opened before=${openedBefore}`, 'opened after=true');
  return row.campaign_id;
}
async function syncStepLogFromEmailLog(emailLogId) {
  const { error } = await supabase.from('sequence_step_logs').update({
    opened: true,
    opened_at: new Date().toISOString()
  }).eq('email_log_id', emailLogId);
  if (error) {
    log('Step Log Sync — FAILED', `code=${error.code}`, error.message);
  } else {
    log('Step Log Sync — OK', `email_log_id=${emailLogId}`);
  }
}
async function updateAnalytics(campaignId) {
  const { data: logs, error: logsError } = await supabase.from('email_logs').select('status, opened').eq('campaign_id', campaignId);
  if (logsError) {
    log('Analytics Updated — FAILED reading email_logs', `code=${logsError.code}`, logsError.message);
    return;
  }
  const rows = logs ?? [];
  const total = rows.length;
  const delivered = rows.filter((r)=>r.status === 'sent').length;
  const opened = rows.filter((r)=>r.opened === true).length;
  const openRate = delivered > 0 ? Math.round(opened / delivered * 1000) / 10 : 0;
  const { data: existing } = await supabase.from('campaign_analytics').select('*').eq('campaign_id', campaignId).maybeSingle();
  const row = {
    campaign_id: campaignId,
    total_recipients: existing?.total_recipients ?? total,
    delivered: existing?.delivered ?? delivered,
    opened,
    clicked: existing?.clicked ?? 0,
    open_rate: openRate,
    click_rate: existing?.click_rate ?? 0
  };
  const { error } = await supabase.from('campaign_analytics').upsert(row, {
    onConflict: 'campaign_id'
  });
  if (error) {
    log('Analytics Updated — FAILED', `code=${error.code}`, error.message);
    if (String(error.code) === '55000' || /cannot (update|insert into) view/i.test(error.message ?? '')) {
      log('Hint: campaign_analytics is a read-only VIEW — make it a table (see backend/email_tracking_migration.sql)');
    }
    return;
  }
  log('Analytics Updated — opened =', opened, 'open_rate =', openRate);
}
Deno.serve(async (req)=>{
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const campaignId = url.searchParams.get('campaign_id');
  const contactEmail = url.searchParams.get('contact_email');
  const trackingId = url.searchParams.get('tracking_id');
  const pixelUrl = url.toString();
  log('Pixel Requested —', pixelUrl);
  log('Campaign ID —', campaignId ?? '(missing)');
  log('Contact Email —', contactEmail ?? '(missing)');
  log('Tracking ID —', trackingId ?? '(missing)');
  if (action === 'track' && campaignId && contactEmail) {
    const row = await findEmailLog(campaignId, contactEmail, trackingId);
    if (row && isAutoOpen(row.sent_at)) {
      log('Open IGNORED — pixel auto-loaded by provider/scanner too soon after send', `log_id=${row.id}`, `sent_at=${row.sent_at}`, `min_delay=${MIN_OPEN_DELAY_SECONDS}s`);
    } else {
      await updateContact(contactEmail);
      const logCampaignId = row ? await updateEmailLog(row) : null;
      await updateAnalytics(logCampaignId ?? campaignId);
    }
  } else {
    log('Skipped — expected ?action=track&campaign_id=<uuid>&contact_email=<email>');
  }
  return new Response(GIF_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF_BODY.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    }
  });
});
