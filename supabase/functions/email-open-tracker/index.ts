/**
 * email-open-tracker — Supabase Edge Function open-tracking pixel for SEQUENCE
 * emails (serverless — laptop OFF).
 *
 * Endpoint (loaded by email clients via <img>, so no Authorization header):
 *   GET {EDGE_FUNCTION_BASE}/email-open-tracker
 *         ?action=track&email_log_id=<uuid>&contact_email=<email>[&tracking_id=<uuid>]
 *   (legacy: ?action=track&campaign_id=<uuid>&contact_email=<email>[&tracking_id=<uuid>])
 *
 * On a track request it:
 *   1. marks the contact `email_opened = true`,
 *   2. marks the matching `email_logs` row `opened = true, opened_at = now()`
 *      — EXACTLY one row when `email_log_id` is present (sequence emails carry
 *      their email_log id; no campaign record is involved), otherwise the
 *      unique `tracking_id`, otherwise the (campaign, email) pair (legacy
 *      fallback),
 *   3. syncs the linked `sequence_step_logs` flags so the Logs API / any direct
 *      read mirrors the authoritative email_log open,
 *   4. advances the recipient's enrollment onto the step's 'OPENED' child
 *      IMMEDIATELY (port of backend sequenceWorker.handleStepOpened) so the
 *      OPENED branch does not wait for the next cron tick — idempotent,
 *      best-effort, never throws,
 *   5. always returns a transparent 1x1 GIF so no broken-image icon shows.
 *
 * Anti-bot grace period: default 0 = DISABLED (Gmail/Outlook image proxies
 * fetch each pixel exactly once, seconds after delivery, and serve the cached
 * image to the human later — any grace period would lose real opens). Set
 * TRACKING_MIN_OPEN_DELAY=<seconds> only if you explicitly want to filter.
 */ import { createClient } from 'npm:@supabase/supabase-js@2';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
const GIF_BASE64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const GIF_BODY = Uint8Array.from(atob(GIF_BASE64), (c)=>c.charCodeAt(0));
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const MIN_OPEN_DELAY_SECONDS = (()=>{
  const value = Number(Deno.env.get('TRACKING_MIN_OPEN_DELAY'));
  return Number.isFinite(value) && value >= 0 ? value : 0;
})();
function log(...args) {
  console.log('[email-open-tracker]', ...args);
}
function isAutoOpen(sentAt) {
  if (!sentAt) return false;
  const sentMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentMs)) return false;
  return Date.now() - sentMs < MIN_OPEN_DELAY_SECONDS * 1000;
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
    return;
  }
  log('Contact Updated —', contact.id, email);
}
async function findEmailLog(campaignId, email, trackingId) {
  let find;
  if (trackingId) {
    find = supabase.from('email_logs').select('id, campaign_id, email, opened, sent_at').eq('tracking_id', trackingId).limit(1);
  } else {
    find = supabase.from('email_logs').select('id, campaign_id, email, opened, sent_at').eq('campaign_id', campaignId).eq('email', email).order('created_at', {
      ascending: true
    }).limit(1);
  }
  const { data: matches, error } = await find;
  if (error) {
    log('Email Log Read — FAILED', `code=${error.code}`, error.message);
    return null;
  }
  const row = matches?.[0];
  if (!row) {
    log('Email Log — NO MATCH', `campaign_id=${campaignId}`, `email=${email}`, trackingId ? `tracking_id=${trackingId}` : '(matched by campaign+email)');
    return null;
  }
  return row;
}
/** Match the email_log directly by its primary key (sequence emails have no campaign). */ async function getEmailLogById(emailLogId) {
  if (!emailLogId) return null;
  const { data: matches, error } = await supabase.from('email_logs').select('id, campaign_id, email, opened, sent_at').eq('id', emailLogId).limit(1);
  if (error) {
    log('Email Log Read — FAILED', `code=${error.code}`, error.message);
    return null;
  }
  const row = matches?.[0];
  if (!row) {
    log('Email Log — NO MATCH', `email_log_id=${emailLogId}`);
    return null;
  }
  return row;
}
async function updateEmailLog(row) {
  if (row.opened !== true) {
    const { error } = await supabase.from('email_logs').update({
      opened: true,
      opened_at: new Date().toISOString()
    }).eq('id', row.id);
    if (error) {
      log('Email Log Updated — FAILED', `code=${error.code}`, error.message);
    } else {
      log('Email Log Updated —', `log_id=${row.id}`, 'opened=true');
    }
  }
  // Keep the linked sequence_step_log(s) flags in line with this email_log.
  const { error: syncError } = await supabase.from('sequence_step_logs').update({
    opened: true,
    opened_at: new Date().toISOString()
  }).eq('email_log_id', row.id);
  if (syncError) {
    log('Step Log Sync — FAILED', `code=${syncError.code}`, syncError.message);
  } else {
    log('Step Log Sync — OK', `email_log_id=${row.id}`);
  }
}
/**
 * Port of backend sequenceWorker.handleStepOpened: advance the recipient onto
 * the opened step's 'OPENED' child immediately (email due after that child's
 * OWN wait_hours; wait 0 = due next tick). Best-effort + idempotent.
 */ async function advanceOpenedBranch(emailLogId) {
  try {
    const { data: stepLog } = await supabase.from('sequence_step_logs').select('sequence_id, sequence_step_id, contact_id').eq('email_log_id', emailLogId).maybeSingle();
    if (!stepLog) {
      log('Advance skipped — no step_log for email_log', emailLogId);
      return;
    }
    const sequenceId = stepLog.sequence_id;
    const contactId = stepLog.contact_id;
    const { data: openedChild } = await supabase.from('sequence_steps').select('*').eq('sequence_id', sequenceId).eq('parent_step_id', stepLog.sequence_step_id).eq('parent_branch', 'OPENED').is('archived_at', null).limit(1).maybeSingle();
    if (!openedChild) {
      log(`No opened child for parent ${stepLog.sequence_step_id}`);
      return;
    }
    const { data: enrollment, error: enrollmentError } = await supabase.from('sequence_enrollments').select('id, sequence_id, contact_id, status, current_step_id').eq('sequence_id', sequenceId).eq('contact_id', contactId).maybeSingle();
    if (enrollmentError || !enrollment || enrollment.status !== 'active') {
      log(`Enrollment missing/inactive contact=${contactId}`);
      return;
    }
    const { data: notOpenedChild } = await supabase.from('sequence_steps').select('id').eq('sequence_id', sequenceId).eq('parent_step_id', stepLog.sequence_step_id).eq('parent_branch', 'NOT_OPENED').is('archived_at', null).limit(1).maybeSingle();
    const onOpenedStep = enrollment.current_step_id === stepLog.sequence_step_id;
    const onNotOpenedChild = !!notOpenedChild && enrollment.current_step_id === notOpenedChild.id;
    if (!onOpenedStep && !onNotOpenedChild) {
      log(`Not on opened/not_opened node: enrollment=${enrollment.current_step_id} step=${stepLog.sequence_step_id}`);
      return;
    }
    const { data: existing } = await supabase.from('sequence_step_logs').select('id').eq('sequence_id', sequenceId).eq('sequence_step_id', openedChild.id).eq('contact_id', contactId).maybeSingle();
    if (existing) {
      log(`Step log already exists for opened child ${openedChild.id} — no re-advance`);
      return;
    }
    const waitMsOf = (step)=>{
      const value = Number(step && step.send_after_value);
      const unit = step && step.send_after_unit;
      if (Number.isFinite(value) && value >= 0 && (unit === 'minutes' || unit === 'hours' || unit === 'days')) {
        const perUnit = unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : 86400000;
        return value * perUnit;
      }
      const h = Number(step && step.wait_hours);
      return (Number.isFinite(h) && h >= 0 ? h : 24) * 3600000;
    };
    const dueAt = new Date(Date.now() + waitMsOf(openedChild)).toISOString();
    const { error: updateError } = await supabase.from('sequence_enrollments').update({
      current_step_id: openedChild.id,
      current_step: Number(openedChild.step_number),
      current_email_type: 'normal',
      status: 'active',
      next_run_at: dueAt,
      updated_at: new Date().toISOString()
    }).eq('id', enrollment.id);
    if (updateError) {
      log(`Advance FAILED for enrollment ${enrollment.id}: ${updateError.message}`);
      return;
    }
    log(`Open on step ${stepLog.sequence_step_id} for contact ${contactId} — advanced to opened child step ${openedChild.step_number}, due ${dueAt}`);
  } catch (error) {
    log('Advance failed (non-fatal):', error.message);
  }
}
Deno.serve(async (req)=>{
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: corsHeaders
    });
  }
  const action = url.searchParams.get('action');
  const campaignId = url.searchParams.get('campaign_id');
  const contactEmail = url.searchParams.get('contact_email');
  const trackingId = url.searchParams.get('tracking_id');
  const emailLogId = url.searchParams.get('email_log_id');
  log('Pixel Requested —', url.toString());
  if (action === 'track' && contactEmail && (emailLogId || campaignId)) {
    const row = emailLogId ? await getEmailLogById(emailLogId) : await findEmailLog(campaignId, contactEmail, trackingId);
    if (row && isAutoOpen(row.sent_at)) {
      log('Open IGNORED — pixel auto-loaded by provider/scanner too soon after send', `log_id=${row.id}`);
    } else {
      await updateContact(contactEmail);
      if (row) {
        await updateEmailLog(row);
        await advanceOpenedBranch(row.id);
      }
    }
  } else {
    log('Skipped — expected ?action=track&email_log_id=<uuid>&contact_email=<email> (or legacy ?action=track&campaign_id=<uuid>&contact_email=<email>)');
  }
  return new Response(GIF_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(GIF_BODY.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      ...corsHeaders
    }
  });
});
