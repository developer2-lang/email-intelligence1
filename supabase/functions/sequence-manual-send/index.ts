/**
 * sequence-manual-send — Supabase Edge Function ("Send Now" for a sequence
 * step to selected recipients).
 *
 * Port of backend/services/sequenceService.js manualSendSequence. The React
 * app can no longer reach the local Node backend, and sending needs SMTP
 * (server-side, port 465), so this function performs the send itself using the
 * same self-contained SMTP client + tracking pipeline as the sequence-runner.
 *
 * CONTRACT:
 *   POST {EDGE_FUNCTION_BASE}/sequence-manual-send
 *   body: { sequence_id, step_id, contact_ids: string[] }
 *   response: { results: [{contact_id, status, email_type?, error?, skipped?}],
 *               sent, scheduled, skipped }
 *
 * BATCHING:
 *   Manual sends SHARE the step's batch queue (sequence_step_batch_state) with
 *   the sequence-runner worker. When the sequence has batch_enabled=true:
 *     - recipients in a closed window / a full batch are reported
 *       status='batch_scheduled' (deferred, never sent now);
 *     - everyone inside the open window/capacity is sent, and the queue is
 *       incremented after each provider-confirmed send, so automatic and manual
 *       triggers never double-count slots.
 *
 * SAFETY (never trusts the frontend selection blindly):
 *   - The sequence must be 'active' and NOT in 'automatic'-only send mode.
 *   - Every recipient is re-validated against the canonical branch resolver
 *     (parent-email tracking: opened / not-opened) AND the node's duplicate
 *     guard (UNIQUE (sequence_id, sequence_step_id, contact_id)) BEFORE the
 *     email is handed to SMTP. Ineligible/already-sent recipients are skipped.
 *   - The recipient's branch (opened / not_opened) uses the EXACT same logic
 *     as the automatic worker (sequence-runner).
 *   - After a successful send the enrollment is positioned on the sent node
 *     and branched forward through the same tree walk the worker uses.
 *
 * AUTH:
 *   The app calls supabase.functions.invoke('sequence-manual-send', ...) with
 *   the project anon/publishable key (or a user JWT). The publishable key is a
 *   public client credential already shipped to the browser; SMTP and the
 *   service-role key stay server-side.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { personalizeTemplate } from '../_shared/personalization.ts';
import { toEmailSafeHtml } from '../_shared/email-render.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

const SMTP_HOST = (Deno.env.get('SMTP_HOST') || 'smtp.gmail.com').trim();
const SMTP_PORT = parseInt(Deno.env.get('SMTP_PORT') || '465', 10);
const SMTP_USER = (Deno.env.get('SMTP_USER') || '').trim();
const SMTP_PASSWORD = Deno.env.get('SMTP_PASSWORD') || '';
const SMTP_FROM_NAME = (Deno.env.get('SMTP_FROM_NAME') || '').trim();
const SMTP_FROM_ADDR = (Deno.env.get('SMTP_FROM') || '').trim() || SMTP_USER;
const SMTP_REPLY_TO = (Deno.env.get('SMTP_REPLY_TO') || '').trim() || SMTP_FROM_ADDR;

const EDGE_FUNCTION_BASE =
  (Deno.env.get('EDGE_FUNCTION_URL') || '').trim().replace(/\/+$/, '') ||
  `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;

const DEFAULT_WAIT_HOURS = 24;
const BRANCH_OPENED = 'OPENED';
const BRANCH_NOT_OPENED = 'NOT_OPENED';
const SEND_MODES = ['automatic', 'manual', 'both'];

// CORS — this function is called directly from the browser
// (supabase.functions.invoke('sequence-manual-send')) on http://localhost:5173,
// so every response (success, error AND the OPTIONS preflight) MUST carry these
// headers or the browser blocks the fetch.
//
// Allowed origins: http://localhost:5173 (dev) plus any production frontend
// origin supplied via the CORS_ORIGINS / FRONTEND_URL env secret (comma-
// separated, optional). The request's Origin is echoed back only when allowed;
// otherwise '*' is returned so a valid header is ALWAYS present.
const ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const set = new Set<string>(['http://localhost:5173']);
  const raw = Deno.env.get('CORS_ORIGINS') || Deno.env.get('FRONTEND_URL') || '';
  for (const item of raw.split(',')) {
    const origin = item.trim().replace(/\/+$/, '');
    if (origin) set.add(origin);
  }
  return set;
})();

function corsHeaders(req?: Request): Record<string, string> {
  const origin = req ? req.headers.get('origin') || '' : '';
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function jsonResponse(status: number, body: unknown, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

const CHECK_INTERVAL_MS = 60 * 1000;
const OPEN_DETECTION_WINDOW_MS = Math.max(
  CHECK_INTERVAL_MS,
  parseInt(Deno.env.get('SEQUENCE_OPEN_WINDOW_MS') || '', 10) || 10 * 60 * 1000
);

function log(...args: unknown[]) {
  console.log('[SeqManualSend]', ...args);
}
function logErr(...args: unknown[]) {
  console.error('[SeqManualSend]', ...args);
}

function toError(error: unknown, fallback: string): Error {
  const message = (error && (error as Error).message) || fallback;
  const err = new Error(message);
  (err as any).status = 500;
  return err;
}
function badRequest(message: string): never {
  const err = new Error(message);
  (err as any).status = 400;
  throw err;
}

function waitMsOf(step: any): number {
  const value = Number(step && step.send_after_value);
  const unit = step && step.send_after_unit;
  if (Number.isFinite(value) && value >= 0 && (unit === 'minutes' || unit === 'hours' || unit === 'days')) {
    const perUnit = unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : 86400000;
    return value * perUnit;
  }
  const h = Number(step && step.wait_hours);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_WAIT_HOURS) * 3600000;
}

function childrenOf(steps: any[], stepId: string | null): any[] {
  return (steps || []).filter((s: any) => s.parent_step_id === stepId);
}

function emailTypeForNode(step: any): 'increment' | 'normal' {
  return step && step.parent_branch === BRANCH_NOT_OPENED ? 'increment' : 'normal';
}

function isLinearFromSteps(steps: any[], childStep: any): boolean {
  if (!childStep || !childStep.parent_step_id) return false;
  const siblings = (steps || []).filter((s: any) => s.parent_step_id === childStep.parent_step_id);
  return siblings.length > 0 && siblings.every((s: any) => s.parent_branch === BRANCH_OPENED);
}

// ─── Auth ──────────────────────────────────────────────────────────────────
const ANON_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const runtimeKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  if (runtimeKey) keys.add(runtimeKey);
  return keys;
})();

function presentedKey(req: Request): string {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  return (req.headers.get('apikey') || '').trim();
}

function isValidSupabaseJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    const iss = String(payload.iss || '');
    const url = new URL(supabaseUrl);
    return iss.startsWith(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}

function isAuthorized(req: Request): boolean {
  const key = presentedKey(req);
  if (!key) return false;
  if (ANON_KEYS.has(key)) return true;
  return isValidSupabaseJwt(key);
}

// ─── Tree + eligibility (ported from sequenceWorker.js) ────────────────────

async function loadSequenceContext(sequenceId: string): Promise<{ steps: any[]; startingStep: any | null }> {
  const { data: steps, error } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (error) throw toError(error, 'Failed to fetch sequence steps');
  const stepsList = steps || [];
  const startingStep = stepsList.find((s: any) => s.parent_step_id === null) || stepsList[0] || null;
  return { steps: stepsList, startingStep };
}

async function getStepLog(sequenceId: string, contactId: string, stepId: string | null): Promise<any | null> {
  if (!stepId) return null;
  const { data, error } = await supabase
    .from('sequence_step_logs')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .eq('sequence_step_id', stepId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence step log');
  return data || null;
}

async function getEmailLog(emailLogId: string | null): Promise<any | null> {
  if (!emailLogId) return null;
  const { data, error } = await supabase
    .from('email_logs')
    .select('id, status, opened, opened_at, clicked, clicked_at, sent_at')
    .eq('id', emailLogId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence email log');
  return data || null;
}

async function evaluateNodeEligibility({
  sequenceId,
  contactId,
  step,
}: {
  sequenceId: string;
  contactId: string;
  step: any;
}): Promise<any> {
  if (!step.parent_step_id) {
    return { eligible: true, branch: 'starting', opened: null, opened_at: null, email_status: null, parentSentAt: null, parentEmailLogId: null };
  }
  const parentLog = await getStepLog(sequenceId, contactId, step.parent_step_id);
  if (!parentLog) {
    return { eligible: false, branch: 'none', opened: null, opened_at: null, email_status: null, parentSentAt: null, parentEmailLogId: null, reason: 'parent_not_sent' };
  }
  const emailLog = parentLog.email_log_id ? await getEmailLog(parentLog.email_log_id) : null;
  const sent = !!(emailLog ? emailLog.status === 'sent' : parentLog.status === 'sent');
  const opened = !!(emailLog ? emailLog.opened === true : parentLog.opened === true);
  const openedAt = (emailLog && emailLog.opened_at) || parentLog.opened_at || null;
  const clicked = !!(emailLog ? emailLog.clicked === true : parentLog.clicked === true);
  const clickedAt = (emailLog && emailLog.clicked_at) || parentLog.clicked_at || null;
  const branch = step.parent_branch === BRANCH_NOT_OPENED ? 'not_opened' : 'opened';
  const parentSkipped = parentLog.status === 'skipped';

  let eligible = parentSkipped || (branch === 'not_opened' ? sent && opened === false : opened === true);
  if (!eligible && branch === 'opened' && sent) {
    const { data: siblings } = await supabase
      .from('sequence_steps')
      .select('parent_branch')
      .eq('sequence_id', sequenceId)
      .eq('parent_step_id', step.parent_step_id)
      .is('archived_at', null);
    const list = siblings || [];
    if (list.length > 0 && list.every((s: any) => s.parent_branch === BRANCH_OPENED)) {
      eligible = true;
    }
  }

  return {
    eligible,
    branch,
    opened,
    parent_skipped: parentSkipped,
    opened_at: openedAt,
    email_status: (emailLog && emailLog.status) || parentLog.status || 'sent',
    parentSentAt: parentLog.sent_at || (emailLog && emailLog.sent_at) || null,
    parentEmailLogId: parentLog.email_log_id || null,
    clicked,
    clicked_at: clickedAt,
  };
}

// ─── Per-step batching (cloud-scheduled, same queue as the runner) ──────────
// Manual sends RESPECT batching: they share the step's sequence_step_batch_state
// queue with the sequence-runner worker, so a "Send Now" trigger can never blast
// a batched step. The gate mirrors the runner exactly:
//   * sequence.batch_enabled=false / no state row  -> send immediately
//   * next_batch_at in the future (window closed)  -> defer (batch_scheduled)
//   * batch already full in the open window        -> defer (batch_scheduled)
//   * otherwise the window is open                 -> send, then increment the
//     queue so the batch slot is consumed atomically.

async function loadStepBatchState(sequenceId: string, stepId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('sequence_step_batch_state')
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', stepId)
    .maybeSingle();
  if (error) {
    logErr(`Failed to read batch state for sequence ${sequenceId} step ${stepId}: ${error.message}`);
    return null;
  }
  return data || null;
}

function batchSizeOf(sequence: any): number {
  const value = Number(sequence && sequence.batch_size);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

/** Ensure a step has its batch queue row (the runner also does this lazily). */
async function ensureStepBatchState(sequence: any, step: any): Promise<any | null> {
  const existing = await loadStepBatchState(sequence.id, step.id);
  if (existing) return existing;
  try {
    const { error } = await supabase.rpc('create_sequence_batch_state', {
      p_sequence_id: sequence.id,
      p_sequence_step_id: step.id,
      p_batch_size: batchSizeOf(sequence),
      p_batch_enabled: true,
      p_first_delay: Number(sequence.first_batch_delay_hours) || 0,
      p_subsequent_delay: Number(sequence.subsequent_batch_delay_hours) || 1,
    });
    if (error) logErr(`Failed to create batch state for step ${step.id}: ${error.message}`);
  } catch (error) {
    logErr(`Failed to create batch state for step ${step.id}: ${(error as Error).message}`);
  }
  return loadStepBatchState(sequence.id, step.id);
}

async function manualBatchGate(sequence: any, step: any): Promise<{ allowed: boolean; reason?: string; deferredTo?: string }> {
  if (!sequence || !step || !sequence.batch_enabled) return { allowed: true };
  const state = await ensureStepBatchState(sequence, step);
  if (!state || !state.batch_enabled) return { allowed: true };
  const nowMs = Date.now();
  const nextAt = state.next_batch_at ? new Date(state.next_batch_at).getTime() : 0;
  if (nextAt > nowMs) {
    return { allowed: false, reason: 'window_closed', deferredTo: new Date(state.next_batch_at).toISOString() };
  }
  if (state.current_batch_number > 0 && state.batch_sent >= state.batch_size) {
    return { allowed: false, reason: 'batch_full' };
  }
  return { allowed: true };
}

/** Call AFTER a provider-confirmed manual send so the queue stays in sync with the runner. */ async function recordStepBatchSend(sequence: any, step: any): Promise<void> {
  if (!sequence || !sequence.batch_enabled || !step) return;
  const { error } = await supabase.rpc('increment_sequence_batch_count', {
    p_sequence_id: sequence.id,
    p_sequence_step_id: step.id,
    p_batch_size: batchSizeOf(sequence),
    p_next_delay_hours: Number(sequence.subsequent_batch_delay_hours) || 1,
  });
  if (error) logErr(`Failed to record batch send for step ${step.id}: ${error.message}`);
}

function resolveStepContent(step: any, emailType: 'increment' | 'normal') {
  if (emailType === 'increment' && step.increment_subject && step.increment_body) {
    return { subject: step.increment_subject, body: step.increment_body };
  }
  return { subject: step.normal_subject, body: step.normal_body };
}

async function sendStepEmail({
  enrollment,
  step,
  emailType,
  contact,
  attachments,
}: {
  enrollment: any;
  step: any;
  emailType: 'increment' | 'normal';
  contact: any;
  attachments: MimeAttachment[];
}): Promise<{ log: any; result: any }> {
  const { subject, body } = resolveStepContent(step, emailType);
  const decoded = decodeHtmlEntities(personalizeTemplate(body || '', contact));
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);
  const subjectLine = personalizeTemplate(subject || '', contact);
  const trackingId = crypto.randomUUID();

  const { data: logRow, error: createError } = await supabase
    .from('email_logs')
    .insert({
      campaign_id: null,
      contact_id: enrollment.contact_id,
      email: contact.email,
      status: 'pending',
      retry_count: 0,
      tracking_id: trackingId,
    })
    .select('*')
    .single();
  if (createError) {
    if (createError.code === '42703') {
      const { data: logRow2, error: createError2 } = await supabase
        .from('email_logs')
        .insert({
          campaign_id: null,
          contact_id: enrollment.contact_id,
          email: contact.email,
          status: 'pending',
          retry_count: 0,
        })
        .select('*')
        .single();
      if (createError2) throw toError(createError2, 'Failed to create email log for sequence send');
      return sendAndUpdate(enrollment, subjectLine, personalizedHtml, plainText, logRow2, trackingId, contact, attachments);
    }
    throw toError(createError, 'Failed to create email log for sequence send');
  }
  return sendAndUpdate(enrollment, subjectLine, personalizedHtml, plainText, logRow, trackingId, contact, attachments);
}

async function sendAndUpdate(
  enrollment: any,
  subjectLine: string,
  personalizedHtml: string,
  plainText: string,
  logRow: any,
  trackingId: string,
  contact: any,
  attachments: MimeAttachment[]
): Promise<{ log: any; result: any }> {
  let html = rewriteLinksForTracking(personalizedHtml, trackingId, EDGE_FUNCTION_BASE);
  html = appendOpenPixel(html, logRow.id, contact.email, trackingId);
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(html));

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  log(`[Personalization] recipient=${contact.email}`);
  log(`[Personalization] contact_id=${contact.id || logRow.contact_id || '(none)'}`);
  log(`[Personalization] full_name=${contact.full_name || ''}`);
  log(`[Personalization] company=${contact.company || ''}`);
  log(`[Personalization] designation=${contact.designation || ''}`);
  log(`[Personalization] rendered_subject=${String(subjectLine || '').slice(0, 200)}`);
  log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  try {
    const result = await sendSmtp({ to: contact.email, subject: subjectLine, html: docHtml, text: plainText, attachments });
    await supabase
      .from('email_logs')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', logRow.id);
    if (attachments.length > 0) {
      log(`[Sequence Attachment] Email sent with ${attachments.length} attachment(s) → ${contact.email}`);
    }
    return { log: logRow, result };
  } catch (error) {
    const message = (error as Error).message || String(error);
    try {
      await supabase
        .from('email_logs')
        .update({ status: 'failed', error_message: `[SEND_FAILED] ${message}`, last_attempt_at: new Date().toISOString() })
        .eq('id', logRow.id);
    } catch (updateError) {
      log(`Failed to mark email log ${logRow.id} failed after send error: ${(updateError as Error).message}`);
    }
    throw error;
  }
}

async function insertStepLog({ enrollment, step, emailLog }: { enrollment: any; step: any; emailLog: any }) {
  if (!emailLog || !emailLog.id) {
    throw new Error('Cannot log sequence step without an email_log_id');
  }
  const { error } = await supabase.from('sequence_step_logs').insert({
    sequence_id: enrollment.sequence_id,
    sequence_step_id: step.id,
    contact_id: enrollment.contact_id,
    email_log_id: emailLog.id,
    sent_at: new Date().toISOString(),
    opened: false,
    clicked: false,
    status: 'sent',
  });
  if (error && error.code === '23505') {
    await supabase
      .from('sequence_step_logs')
      .update({ email_log_id: emailLog.id })
      .eq('sequence_id', enrollment.sequence_id)
      .eq('sequence_step_id', step.id)
      .eq('contact_id', enrollment.contact_id)
      .is('email_log_id', null);
  }
  return error;
}

async function moveEnrollmentTo(enrollmentId: string, step: any, atIso: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('sequence_enrollments')
    .update({
      current_step_id: step.id,
      current_step: Number(step.step_number),
      current_email_type: emailTypeForNode(step),
      status: 'active',
      next_run_at: atIso,
      updated_at: nowIso,
    })
    .eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to advance sequence enrollment');
}

async function completeEnrollment(enrollmentId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from('sequence_enrollments')
    .update({ status: 'completed', next_run_at: null, current_email_type: 'normal', updated_at: nowIso })
    .eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to complete sequence enrollment');
}

async function advanceAfterSend({ enrollment, sequence, contact }: {
  enrollment: any;
  sequence: any;
  contact: any;
}): Promise<any> {
  const { steps } = await loadSequenceContext(sequence.id);
  const currentStep = steps.find((s: any) => s.id === enrollment.current_step_id) || null;
  if (!currentStep) {
    await completeEnrollment(enrollment.id);
    return { completed: true };
  }

  const stepLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
  const emailLog = stepLog && stepLog.email_log_id ? await getEmailLog(stepLog.email_log_id) : null;
  const opened = !!(emailLog ? emailLog.opened === true : stepLog && stepLog.opened === true);
  const nowMs = Date.now();
  const sentMs = stepLog && stepLog.sent_at ? new Date(stepLog.sent_at).getTime() : nowMs;
  const openedMs = emailLog && emailLog.opened_at
    ? new Date(emailLog.opened_at).getTime()
    : stepLog && stepLog.opened_at
      ? new Date(stepLog.opened_at).getTime()
      : sentMs;
  const recipient = (contact && contact.email) || enrollment.contact_id;

  const children = childrenOf(steps, currentStep.id);
  const openedChild = children.find((c: any) => c.parent_branch === BRANCH_OPENED) || null;
  const notOpenedChild = children.find((c: any) => c.parent_branch === BRANCH_NOT_OPENED) || null;

  if (openedChild || notOpenedChild) {
    if (opened && openedChild) {
      const atMs = openedMs + waitMsOf(openedChild);
      const atIso = new Date(atMs).toISOString();
      await moveEnrollmentTo(enrollment.id, openedChild, atIso);
      return { advancedTo: openedChild.step_number, advancedToId: openedChild.id, branch: 'opened', scheduled_for: atIso };
    }
    // BRANCH DECISION IS DEFERRED — a manual send just happened, so the open /
    // not-opened branch may not be known for the open-detection window. Park on
    // this node and let the automatic worker (sequence-runner cron) decide once
    // the window has elapsed — the recipient is never classified "not opened"
    // at send time.
    const decisionAtMs = nowMs + Math.max(waitMsOf(currentStep), OPEN_DETECTION_WINDOW_MS);
    const atIso = new Date(Math.min(decisionAtMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
    await moveEnrollmentTo(enrollment.id, currentStep, atIso);
    return { waiting: true, scheduled_for: atIso };
  }

  if (opened && openedChild) {
    const atMs = openedMs + waitMsOf(openedChild);
    await moveEnrollmentTo(enrollment.id, openedChild, new Date(atMs).toISOString());
    return { advancedTo: openedChild.step_number, advancedToId: openedChild.id, branch: 'opened' };
  }
  if (notOpenedChild) {
    const atMs = sentMs + waitMsOf(notOpenedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, notOpenedChild, atIso);
    return { advancedTo: notOpenedChild.step_number, advancedToId: notOpenedChild.id, branch: 'not_opened', scheduled_for: atIso };
  }
  if (openedChild) {
    const atMs = sentMs + waitMsOf(openedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, openedChild, atIso);
    return { advancedTo: openedChild.step_number, advancedToId: openedChild.id, branch: 'opened', scheduled_for: atIso };
  }

  await completeEnrollment(enrollment.id);
  log(`${recipient} step ${currentStep.step_number} — leaf, sequence completed`);
  return { completed: true };
}

async function ensureEnrollmentAndAdvance({ sequenceId, contactId, sequence, contact, step }: {
  sequenceId: string;
  contactId: string;
  sequence: any;
  contact: any;
  step: any;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await supabase
    .from('sequence_enrollments')
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('contact_id', contactId)
    .maybeSingle();

  let enrollment: any;
  if (existing) {
    const { data, error } = await supabase
      .from('sequence_enrollments')
      .update({
        current_step_id: step.id,
        current_step: Number(step.step_number),
        current_email_type: emailTypeForNode(step),
        status: 'active',
        updated_at: nowIso,
      })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to update sequence enrollment');
    enrollment = data;
  } else {
    const { data, error } = await supabase
      .from('sequence_enrollments')
      .insert({
        sequence_id: sequenceId,
        contact_id: contactId,
        current_step_id: step.id,
        current_step: Number(step.step_number),
        current_email_type: emailTypeForNode(step),
        status: 'active',
        enrolled_at: nowIso,
        next_run_at: nowIso,
        updated_at: nowIso,
      })
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to create sequence enrollment');
    enrollment = data;
  }

  await advanceAfterSend({ enrollment, sequence, contact });
}

// ─── SMTP + personalization + tracking (ported from sequence-runner) ───────
// Merge tags resolve against the actual recipient row from public.contacts via
// the shared _shared/personalization.ts helper (no hard-coded placeholder list).

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(html: string): string {
  return String(html || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

function hasHtmlTags(str: string): boolean {
  return /<\s*(\/)?\s*[a-zA-Z][^>]*>/.test(String(str || ''));
}

function plainTextToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let openList: string | null = null;
  let paragraph: string[] = [];
  const closeList = () => {
    if (openList) {
      out.push(`</${openList}>`);
      openList = null;
    }
  };
  const emitParagraph = () => {
    if (paragraph.length) {
      closeList();
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      emitParagraph();
      closeList();
      continue;
    }
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || number) {
      emitParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (openList !== type) {
        closeList();
        out.push(`<${type}>`);
        openList = type;
      }
      out.push(`<li>${(bullet ? bullet[2] : number![2]).trim()}</li>`);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  emitParagraph();
  closeList();
  return out.join('\n');
}

function wrapHtmlDocument(html: string): string {
  const value = String(html || '');
  if (!value.trim()) return value;
  if (/<!doctype\b|<\s*html\b|<\s*head\b/i.test(value)) return value;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>img{border:0;max-width:100%;}a{color:#1a73e8;}table{border-collapse:collapse;}</style>',
    '</head>',
    '<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#333333;">',
    value,
    '</body>',
    '</html>',
  ].join('\n');
}

function rewriteLinksForTracking(html: string, trackingId: string, baseUrl: string): string {
  const clickUrl = (url: string) =>
    `${baseUrl}/click-tracker?tracking_id=${encodeURIComponent(trackingId)}&url=${encodeURIComponent(url)}`;
  const HREF_RE = /(\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)(["'])/gi;
  const TOKEN_RE = /(<[^>]*>)|(https?:\/\/[^\s<>"']+)/gi;
  return String(html || '').replace(TOKEN_RE, (match, tag: string, bareUrl: string) => {
    if (tag) {
      return tag.replace(HREF_RE, (m, p: string, q: string, url: string, q2: string) => {
        if (url.includes('/click-tracker')) return m;
        return `${p}${q}${clickUrl(url)}${q2}`;
      });
    }
    const clean = bareUrl.replace(/[\.,;:!?\)\]\}]+$/, '');
    if (!/^https?:\/\//i.test(clean)) return match;
    const punct = bareUrl.slice(clean.length);
    return `<a href="${clickUrl(clean)}">${clean}</a>${punct}`;
  });
}

function appendOpenPixel(html: string, emailLogId: string, contactEmail: string, trackingId: string): string {
  const params = new URLSearchParams({
    action: 'track',
    email_log_id: emailLogId,
    contact_email: contactEmail,
    tracking_id: trackingId,
  });
  const pixelUrl = `${EDGE_FUNCTION_BASE}/email-open-tracker?${params.toString()}`;
  const pixel =
    `<img src="${pixelUrl}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}\n</body>`) : `${html}\n${pixel}`;
}

function b64EncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64EncodeUtf8(text: string): string {
  return b64EncodeBytes(new TextEncoder().encode(text));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP operation timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function encodeHeader(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${b64EncodeUtf8(value)}?=`;
}

class SmtpSession {
  private conn!: Deno.Conn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';
  private readonly timeoutMs: number;
  constructor(timeoutMs: number) { this.timeoutMs = timeoutMs; }
  async connect(hostname: string, port: number): Promise<void> {
    this.conn = await withTimeout(Deno.connectTls({ hostname, port }), this.timeoutMs);
    this.reader = this.conn.readable.getReader();
    await this.readReply([220]);
  }
  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf('\n');
      if (idx !== -1) {
        const line = this.buf.slice(0, idx).replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        return line;
      }
      const chunk = await withTimeout(this.reader.read(), this.timeoutMs);
      if (chunk.done) throw new Error('SMTP connection closed unexpectedly');
      this.buf += new TextDecoder().decode(chunk.value);
    }
  }
  private async readReply(expected: number[]): Promise<void> {
    let lastCode = 0;
    let text = '';
    while (true) {
      const line = await this.readLine();
      lastCode = parseInt(line.slice(0, 3), 10);
      text = line.slice(4);
      if (line.length < 4 || line[3] !== '-') break;
    }
    if (!expected.includes(lastCode)) throw new Error(`SMTP error ${lastCode}: ${text}`);
  }
  private async cmd(line: string): Promise<void> {
    await withTimeout(this.conn.write(new TextEncoder().encode(line + '\r\n')), this.timeoutMs);
  }
  async ehlo(domain: string): Promise<void> { await this.cmd(`EHLO ${domain}`); await this.readReply([250]); }
  async authPlain(user: string, pass: string): Promise<void> {
    const payload = new Uint8Array(user.length + pass.length + 2);
    let i = 0;
    payload[i++] = 0;
    for (let j = 0; j < user.length; j++) payload[i++] = user.charCodeAt(j);
    payload[i++] = 0;
    for (let j = 0; j < pass.length; j++) payload[i++] = pass.charCodeAt(j);
    await this.cmd(`AUTH PLAIN ${b64EncodeBytes(payload)}`);
    await this.readReply([235]);
  }
  async mailFrom(from: string): Promise<void> { await this.cmd(`MAIL FROM:<${from}>`); await this.readReply([250]); }
  async rcptTo(to: string): Promise<void> { await this.cmd(`RCPT TO:<${to}>`); await this.readReply([250, 251]); }
  async data(lines: string[]): Promise<void> {
    await this.cmd('DATA');
    await this.readReply([354]);
    for (const line of lines) { await this.cmd(/^\./.test(line) ? '.' + line : line); }
    await this.cmd('.');
    await this.readReply([250]);
  }
  async quit(): Promise<void> {
    try { await this.cmd('QUIT'); } catch { /* ignore */ }
    try { this.conn.close(); } catch { /* ignore */ }
  }
}

interface MimeAttachment {
  file_name: string;
  file_type: string;
  data: Uint8Array;
}

/** Load the attachment metadata rows saved against ONE sequence step. */
async function loadStepAttachments(stepId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('sequence_step_attachments')
    .select('*')
    .eq('sequence_step_id', stepId)
    .order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01') {
      log('[Sequence Attachment] sequence_step_attachments table missing (42P01) — sending without attachments');
      return [];
    }
    throw new Error(`Failed to fetch attachments: ${error.message}`);
  }
  return data || [];
}

/**
 * Download one attachment's bytes from Storage with the server-side Supabase
 * client. Throws with the EXACT bucket/path on failure so a missing file is
 * never silently sent without its attachment.
 */
async function downloadAttachment(att: any): Promise<MimeAttachment> {
  const bucket = String(att.storage_bucket || 'sequence-attachments');
  const path = String(att.storage_path || '');
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `Failed to download attachment "${att.file_name || path}" from Storage — bucket="${bucket}" path="${path}"${error ? `: ${error.message}` : ' (empty response)'}`
    );
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  log(`[Sequence Attachment] Downloaded from Storage: ${bucket}/${path}`);
  return {
    file_name: att.file_name || 'attachment',
    file_type: att.file_type || 'application/octet-stream',
    data: bytes,
  };
}

/**
 * Load every attachment record for the step and download all the files from
 * Storage, ready to embed in the MIME message. If any file cannot be downloaded
 * the send aborts with a clear error instead of mailing the step without its
 * attachment.
 */
async function loadAndDownloadStepAttachments(stepId: string): Promise<MimeAttachment[]> {
  const records = await loadStepAttachments(stepId);
  if (records.length === 0) {
    log(`[Sequence Attachment] Loading attachments for step ${stepId}: none found`);
    return [];
  }
  log(`[Sequence Attachment] Loading attachments for step ${stepId}: ${records.length} record(s)`);
  const mime: MimeAttachment[] = [];
  for (const att of records) {
    mime.push(await downloadAttachment(att));
  }
  log(`[Sequence Attachment] Sending ${mime.length} attachment(s) with this step's email`);
  return mime;
}

/**
 * Resolve the sequence_branch_steps row id that mirrors a sequence_steps node
 * (same sequence_id + step_number + parent_branch). Sequence Builder
 * attachments are keyed by that branch-step id, so this is how a node being
 * sent finds its OWN builder attachments — never another branch's files.
 */
async function resolveBranchStepId(sequenceId: string, step: any): Promise<number | null> {
  if (!step || step.step_number == null || !step.parent_branch) return null;
  const { data, error } = await supabase
    .from('sequence_branch_steps')
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('step', Number(step.step_number))
    .eq('parent_branch', step.parent_branch)
    .maybeSingle();
  if (error) return null;
  return data ? data.id : null;
}

/** Load the attachment metadata rows saved against ONE sequence branch step. */
async function loadBranchStepAttachments(branchStepId: number): Promise<any[]> {
  const { data, error } = await supabase
    .from('sequence_branch_step_attachments')
    .select('*')
    .eq('branch_step_id', branchStepId)
    .order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01') {
      log('[Sequence Attachment] sequence_branch_step_attachments table missing (42P01) — sending without branch attachments');
      return [];
    }
    throw new Error(`Failed to fetch branch step attachments: ${error.message}`);
  }
  return data || [];
}

/**
 * Load every attachment record for the branch step and download all the files
 * from Storage, ready to embed in the MIME message. Only the files belonging to
 * this EXACT branch step are returned.
 */
async function loadAndDownloadBranchStepAttachments(branchStepId: number): Promise<MimeAttachment[]> {
  const records = await loadBranchStepAttachments(branchStepId);
  if (records.length === 0) {
    log(`[Sequence Attachment] Loading attachments for branch step ${branchStepId}: none found`);
    return [];
  }
  log(`[Sequence Attachment] Loading attachments for branch step ${branchStepId}: ${records.length} record(s)`);
  const mime: MimeAttachment[] = [];
  for (const att of records) {
    mime.push(await downloadAttachment(att));
  }
  log(`[Sequence Attachment] Sending ${mime.length} branch step attachment(s) with this step's email`);
  return mime;
}

/** Base64 in 76-char lines (RFC 2045) so long attachments wrap correctly. */
function b64Lines(bytes: Uint8Array): string[] {
  const b64 = b64EncodeBytes(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines;
}

/** ASCII-safe filename for the MIME Content-Disposition / Content-Type name. */
function safeAttachmentName(value: string): string {
  return String(value || 'file')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim() || 'file';
}

function buildMimeMessage(opts: {
  from: string; to: string; subject: string; html: string; text: string;
  replyTo: string; listUnsubscribe: string; messageId: string;
  attachments?: MimeAttachment[];
}): string[] {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  lines.push(`Reply-To: ${encodeHeader(opts.replyTo)}`);
  lines.push(`Message-ID: ${opts.messageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`List-Unsubscribe: ${opts.listUnsubscribe}`);

  const attachments = opts.attachments || [];

  // No attachments → keep the exact legacy multipart/alternative message.
  if (attachments.length === 0) {
    const boundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(opts.text || '');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(opts.html || '');
    lines.push(`--${boundary}--`);
    lines.push('');
    return lines;
  }

  // With attachments the body becomes an inner multipart/alternative inside an
  // outer multipart/mixed, and each file is an independent base64 part.
  const outerBoundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
  const innerBoundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${outerBoundary}"`);
  lines.push('');
  lines.push(`--${outerBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${innerBoundary}"`);
  lines.push('');
  lines.push(`--${innerBoundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(opts.text || '');
  lines.push(`--${innerBoundary}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(opts.html || '');
  lines.push(`--${innerBoundary}--`);
  lines.push('');
  for (const att of attachments) {
    const safeName = safeAttachmentName(att.file_name);
    lines.push(`--${outerBoundary}`);
    lines.push(`Content-Type: ${att.file_type || 'application/octet-stream'}; name="${safeName}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${safeName}"`);
    lines.push('');
    lines.push(...b64Lines(att.data));
    lines.push('');
  }
  lines.push(`--${outerBoundary}--`);
  lines.push('');
  return lines;
}

async function sendSmtp(opts: { to: string; subject: string; html: string; text: string; attachments?: MimeAttachment[] }): Promise<{ messageId: string }> {
  if (!SMTP_USER || !SMTP_PASSWORD) throw new Error('SMTP_USER / SMTP_PASSWORD secrets are not configured');
  if (SMTP_PORT !== 465) throw new Error('Supabase Edge Functions only allow outbound SMTP on port 465 (implicit TLS)');
  const fromName = SMTP_FROM_NAME ? `${encodeHeader(SMTP_FROM_NAME)} ` : '';
  const from = fromName ? `${fromName}<${SMTP_FROM_ADDR}>` : SMTP_FROM_ADDR;
  const messageId = `<${crypto.randomUUID()}@gmail.com>`;
  const listUnsubscribe = `mailto:${SMTP_FROM_ADDR}?subject=Unsubscribe`;
  const session = new SmtpSession(30000);
  try {
    await session.connect(SMTP_HOST, SMTP_PORT);
    await session.ehlo('supabase.co');
    await session.authPlain(SMTP_USER, SMTP_PASSWORD);
    await session.mailFrom(SMTP_FROM_ADDR);
    await session.rcptTo(opts.to);
    const lines = buildMimeMessage({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text, replyTo: SMTP_REPLY_TO, listUnsubscribe, messageId, attachments: opts.attachments });
    await session.data(lines);
    await session.quit();
    return { messageId };
  } catch (error) {
    try { session.quit(); } catch { /* ignore */ }
    throw error;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { success: false, error: 'Method not allowed' }, req);
  }
  if (!isAuthorized(req)) {
    return jsonResponse(401, {
      success: false,
      error: 'Unauthorized: send a valid Supabase JWT or the project anon/publishable key',
    }, req);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(400, { success: false, error: 'Invalid JSON body' }, req);
  }

  const respond = (status: number, body: unknown): Response => jsonResponse(status, body, req);

  try {
    const sequenceId = String(payload.sequence_id || payload.sequenceId || '').trim();
    const stepId = String(payload.step_id || '').trim();
    const rawContactIds = Array.isArray(payload.contact_ids) ? payload.contact_ids : [];
    if (!sequenceId) badRequest('sequence_id is required');
    if (!stepId) badRequest('step_id is required');
    if (rawContactIds.length === 0) badRequest('contact_ids must be a non-empty array');
    const contactIds = [...new Set(rawContactIds.map((v: unknown) => String(v).trim()).filter(Boolean))];

    const { data: sequence, error: seqError } = await supabase
      .from('sequences')
      .select('*')
      .eq('id', sequenceId)
      .maybeSingle();
    if (seqError) throw toError(seqError, 'Failed to fetch sequence');
    if (!sequence) return respond(404, { success: false, error: `Sequence not found: ${sequenceId}` });
    if (sequence.status !== 'active') badRequest('Sequence must be active before sending manually');
    if (sequence.send_mode === 'automatic') badRequest('This sequence is set to Automatic sending only — manual send is disabled');

    const { steps } = await loadSequenceContext(sequenceId);
    const step = steps.find((s: any) => s.id === stepId) || null;
    if (!step) return respond(404, { success: false, error: `Step not found: ${stepId}` });

    // Enrolled contacts (for contact lookups).
    const { data: enrolled } = await supabase
      .from('sequence_enrollments')
      .select('contact_id, contacts(*)')
      .eq('sequence_id', sequenceId);
    const recipientById = new Map<string, any>();
    for (const row of enrolled || []) {
      if (row.contacts) recipientById.set(row.contact_id, row.contacts);
    }

    // Already sent for this node (duplicate protection).
    const { data: sentLogs, error: sentLogsError } = await supabase
      .from('sequence_step_logs')
      .select('contact_id')
      .eq('sequence_id', sequenceId)
      .eq('sequence_step_id', stepId);
    if (sentLogsError) throw toError(sentLogsError, 'Failed to fetch sent step logs');
    const alreadySent = new Set<string>((sentLogs || []).map((l: any) => l.contact_id));

    // Load the step's own attachments ONCE — every selected recipient gets the
    // SAME step email, and each step's files must only ever ride with that step.
    // The Sequence Builder attachments live against the branch-step row that
    // mirrors this node, so those files are loaded from THAT branch step only.
    const branchStepId = await resolveBranchStepId(sequenceId, step);
    const stepAttachments = await loadAndDownloadStepAttachments(stepId);
    const branchAttachments = branchStepId != null
      ? await loadAndDownloadBranchStepAttachments(branchStepId)
      : [];
    const attachments = [...stepAttachments, ...branchAttachments];

    const results: any[] = [];

    for (const contactId of contactIds) {
      const contact = recipientById.get(contactId);
      if (!contact) {
        results.push({ contact_id: contactId, status: 'ineligible', skipped: true });
        continue;
      }
      if (alreadySent.has(contactId)) {
        results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
        continue;
      }

      // Re-check branch eligibility at send time (same rule as the worker).
      const elig = await evaluateNodeEligibility({ sequenceId, contactId, step });
      if (!elig.eligible) {
        results.push({
          contact_id: contactId,
          status: 'ineligible',
          recipient_status: elig.opened === true ? 'opened' : 'not_opened',
          skipped: true,
        });
        continue;
      }

      // Race guard against a concurrent automatic-worker send.
      const { data: raceLog } = await supabase
        .from('sequence_step_logs')
        .select('id')
        .eq('sequence_id', sequenceId)
        .eq('sequence_step_id', step.id)
        .eq('contact_id', contactId)
        .maybeSingle();
      if (raceLog) {
        alreadySent.add(contactId);
        results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
        continue;
      }

      // Per-step batching gate — manual sends respect the step's batch queue.
      // A closed window / full batch defers this recipient (status
      // 'batch_scheduled'); the automatic worker delivers them at the next
      // window, matching the cloud-scheduled behavior of the runner.
      const batchGate = await manualBatchGate(sequence, step);
      if (!batchGate.allowed) {
        results.push({
          contact_id: contactId,
          status: 'batch_scheduled',
          skipped: true,
          reason: batchGate.reason,
          next_batch_at: batchGate.deferredTo || null,
        });
        continue;
      }

      try {
        const enrollment = { sequence_id: sequenceId, contact_id: contactId };
        const emailType = emailTypeForNode(step);
        const { log: emailLog } = await sendStepEmail({ enrollment, step, emailType, contact, attachments });

        const insertError = await insertStepLog({ enrollment, step, emailLog });
        if (insertError && insertError.code === '23505') {
          results.push({ contact_id: contactId, status: 'already_sent', skipped: true });
          continue;
        }
        if (insertError) throw toError(insertError, 'Failed to log sequence step');

        await ensureEnrollmentAndAdvance({ sequenceId, contactId, sequence, contact, step });
        // Consume the batch slot only after the provider confirmed the send.
        await recordStepBatchSend(sequence, step);
        alreadySent.add(contactId);
        results.push({ contact_id: contactId, status: 'sent', email_type: emailType });
        log(`Sent step ${step.step_number} (${emailType}) to ${contact.email}`);
      } catch (error) {
        logErr(`Manual send failed for contact ${contactId} (step ${step.step_number}): ${(error as Error).message}`);
        results.push({ contact_id: contactId, status: 'failed', error: (error as Error).message });
      }
    }

    const sent = results.filter((r: any) => r.status === 'sent').length;
    const scheduled = results.filter((r: any) => r.status === 'increment_scheduled' || r.status === 'batch_scheduled').length;
    const skipped = results.filter((r: any) => r.skipped).length;

    return respond(200, { success: true, data: { results, sent, scheduled, skipped } });
  } catch (error) {
    const status = (error as any).status || 400;
    logErr(`Manual send failed: ${(error as Error).message}`);
    return respond(status, { success: false, error: (error as Error).message });
  }
});