/**
 * sequence-runner — Supabase Edge Function (sequence automation worker).
 *
 * Runs the ENTIRE sequence engine serverlessly — no local Node.js backend. It
 * is a faithful Deno/TypeScript port of backend/workers/sequenceWorker.js with
 * the SMTP + personalization + tracking pipeline copied from
 * scheduled-campaign-runner (Deno → smtp.gmail.com:465, implicit TLS).
 *
 * TRIGGERS:
 *   - A Supabase pg_cron job fires it every 30 seconds (see
 *     supabase/sequence-runner-setup.sql) with an `x-cron-secret` header.
 *     The cron interval is ONLY the polling frequency. The worker never adds a
 *     business delay: a step is due exactly when its configured wait has
 *     elapsed (Immediate / wait_hours=0 → next_run_at = NOW(), so the very
 *     next 30-second tick sends it).
 *   - The React app invokes it AFTER activation (and after step edits / manual
 *     sends) with `{ sequenceId }` so Step 1 / new branches are evaluated
 *     immediately instead of waiting for the next cron tick.
 *
 * TREE MODEL (recursive branch tree, sequence_steps is the canonical source):
 *   parent_step_id  -> the exact parent node (NULL = STARTING step / Step 1)
 *   parent_branch   -> 'STARTING' | 'OPENED' | 'NOT_OPENED' (NOT NULL)
 *   step_number     -> display depth only (siblings share numbers)
 *   UNIQUE (sequence_id, parent_step_id, parent_branch) with archived_at null
 *
 * FLOW (per enrolled recipient):
 *   - STARTING node -> sent to EVERY enrolled recipient after activation.
 *   - After a node's email is sent the recipient branches by the ACTUAL open
 *     tracking state of that parent email (re-read on every tick):
 *       opened     -> onto the parent's 'OPENED' child (due next tick).
 *       not opened -> onto the parent's 'NOT_OPENED' child (due after that
 *                     child's wait_hours) — but only if the parent email is
 *                     STILL not opened by then; an open during the wait
 *                     re-routes the recipient to the 'OPENED' child instead.
 *   - BOTH branches ALWAYS send their configured next email. NOT_OPENED never
 *     means STOP. A node with no children keeps the enrollment ACTIVE and
 *     re-checks (auto-recovery); the branch ends after that node's OWN
 *     wait_hours elapse since its email was sent.
 *
 * OPEN DETECTION WINDOW:
 *   The opened/not-opened decision is DEFERRED until the node's own wait_hours
 *   AND at least SEQUENCE_OPEN_WINDOW_MS (default one check interval = 30 s)
 *   have elapsed since the email was sent, so the next cron tick can read real
 *   open events before committing anyone to NOT_OPENED. For wait_hours=0 the
 *   decision resolves on the next runner cycle (~30 s later), never minutes.
 *   An open recorded during the window advances the recipient to the OPENED
 *   child immediately (via the email-open-tracker function).
 *
 * DUPLICATE SEND PROTECTION (idempotent under cron + triggered invokes):
 *   - sequence_step_logs UNIQUE (sequence_id, sequence_step_id, contact_id)
 *     is the authoritative guard.
 *   - Enrollments are CLAIMED atomically: next_run_at is pushed into the
 *     future (SEQUENCE_CLAIM_LOCK_MS) so a concurrent tick's `<= now` WHERE
 *     clause skips the row. The real next_run_at is written when processing
 *     finishes (send or reschedule).
 *   - Failed sends are marked 'failed' on the email_log and retried
 *     SEQUENCE_RETRY_DELAY_SECONDS later.
 *
 * TRACKING:
 *   Each sent sequence email embeds the email-open-tracker Edge Function pixel
 *   (marks email_logs.opened + opened_at, syncs sequence_step_logs, and
 *   advances the OPENED branch immediately) and rewrites links through the
 *   click-tracker Edge Function — both reachable with the laptop OFF.
 *
 * AUTH (no secrets in the frontend):
 *   The cron call carries the shared CRON_SECRET in `x-cron-secret`. The app
 *   call carries the project anon/publishable key (or a user JWT). Either is
 *   accepted; SMTP + service-role stay server-side.
 */ import { createClient } from 'npm:@supabase/supabase-js@2';
import { personalizeTemplate } from '../_shared/personalization.ts';
import { toEmailSafeHtml } from '../_shared/email-render.ts';
const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
const supabase = createClient(supabaseUrl, supabaseKey);
// ─── Configuration (env) ───────────────────────────────────────────────────
const CRON_SECRET = (Deno.env.get('CRON_SECRET') || '').trim();
const SMTP_HOST = (Deno.env.get('SMTP_HOST') || 'smtp.gmail.com').trim();
const SMTP_PORT = parseInt(Deno.env.get('SMTP_PORT') || '465', 10);
const SMTP_USER = (Deno.env.get('SMTP_USER') || '').trim();
const SMTP_PASSWORD = Deno.env.get('SMTP_PASSWORD') || '';
const SMTP_FROM_NAME = (Deno.env.get('SMTP_FROM_NAME') || '').trim();
const SMTP_FROM_ADDR = (Deno.env.get('SMTP_FROM') || '').trim() || SMTP_USER;
const SMTP_REPLY_TO = (Deno.env.get('SMTP_REPLY_TO') || '').trim() || SMTP_FROM_ADDR;
const EDGE_FUNCTION_BASE = (Deno.env.get('EDGE_FUNCTION_URL') || '').trim().replace(/\/+$/, '') || `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;
// Worker tuning. The cron polls every 30 seconds; the worker must never add a
// business delay of its own — a step's configured wait (wait_hours /
// send_after_*) is the ONLY thing that schedules next_run_at into the future.
const CHECK_INTERVAL_MS = 30 * 1000;
// Claim lock: how long a claimed enrollment is parked before another tick may
// claim it again (idempotency under overlapping cron ticks). NOT a business
// delay — a normal run overwrites it with the real next_run_at immediately.
// Old default was 5 minutes (parked failed/crashed rows for 5 min) — removed.
const CLAIM_LOCK_MS = Math.max(60 * 1000, parseInt(Deno.env.get('SEQUENCE_CLAIM_LOCK_MS') || '', 10) || 60 * 1000);
// Retry delay after a FAILED provider send. Old default was 300 s (5 min) —
// removed. Short so a transient SMTP failure is retried on the next cycles.
const RETRY_DELAY_SECONDS = Math.max(30, parseInt(Deno.env.get('SEQUENCE_RETRY_DELAY_SECONDS') || '', 10) || 60);
const SEND_DELAY_MS = (()=>{
  const value = parseInt(Deno.env.get('SEQUENCE_SEND_DELAY_MS') || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
})();
const DEFAULT_WAIT_HOURS = 24;
const RECHECK_OPENED_MS = 30 * 1000;
const OPEN_DETECTION_WINDOW_MS = Math.max(CHECK_INTERVAL_MS, parseInt(Deno.env.get('SEQUENCE_OPEN_WINDOW_MS') || '', 10) || CHECK_INTERVAL_MS);
const MAX_CHAIN_DEPTH = 100;
// NO enrollment batch cap on purpose: an "Immediate" (wait_hours=0) step must
// send to EVERY due enrollment in the same tick. checkDueEnrollments() drains
// until no due enrollment remains (or the time budget is spent) and relies on
// the atomic next_run_at claim for cross-tick idempotency — never on leaving
// recipients behind for a later batch. Pace is handled by SEND_DELAY_MS, not
// by a fixed batch size.
const TIME_BUDGET_MS = Math.max(1000, parseInt(Deno.env.get('SEQUENCE_TIME_BUDGET_MS') || '', 10) || 100000);
const BRANCH_STARTING = 'STARTING';
const BRANCH_OPENED = 'OPENED';
const BRANCH_NOT_OPENED = 'NOT_OPENED';
// CORS — the React app invokes this function directly from the browser after
// activation / step edits, so every response must carry these headers.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
function log(...args) {
  console.log('[SeqRunner]', ...args);
}
function logErr(...args) {
  console.error('[SeqRunner]', ...args);
}
function toError(error, fallback) {
  const message = error && error.message || fallback;
  return new Error(message);
}
/** Delay (ms) before a node's email is due (send_after config, else wait_hours). */ function waitMsOf(step) {
  const value = Number(step && step.send_after_value);
  const unit = step && step.send_after_unit;
  if (Number.isFinite(value) && value >= 0 && (unit === 'minutes' || unit === 'hours' || unit === 'days')) {
    const perUnit = unit === 'minutes' ? 60 * 1000 : unit === 'hours' ? 3600 * 1000 : 24 * 3600 * 1000;
    return value * perUnit;
  }
  const h = Number(step && step.wait_hours);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_WAIT_HOURS) * 3600 * 1000;
}
function childrenOf(steps, stepId) {
  return (steps || []).filter((s)=>s.parent_step_id === stepId);
}
/** Which email variant a node uses: NOT_OPENED nodes use their INCREMENT content. */ function emailTypeForNode(step) {
  return step && step.parent_branch === BRANCH_NOT_OPENED ? 'increment' : 'normal';
}
function isLinearFromSteps(steps, childStep) {
  if (!childStep || !childStep.parent_step_id) return false;
  const siblings = (steps || []).filter((s)=>s.parent_step_id === childStep.parent_step_id);
  return siblings.length > 0 && siblings.every((s)=>s.parent_branch === BRANCH_OPENED);
}
// ─── Auth ──────────────────────────────────────────────────────────────────
const ANON_KEYS = (()=>{
  const keys = new Set();
  const runtimeKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  if (runtimeKey) keys.add(runtimeKey);
  return keys;
})();
function presentedKey(req) {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  return (req.headers.get('apikey') || '').trim();
}
function isValidSupabaseJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    const iss = String(payload.iss || '');
    const url = new URL(supabaseUrl);
    return iss.startsWith(`${url.protocol}//${url.host}`);
  } catch  {
    return false;
  }
}
// ─── Discovery + claiming (ported from sequenceWorker.js) ──────────────────
async function getActiveSequenceIds(onlyId) {
  let query = supabase.from('sequences').select('id').eq('status', 'active');
  if (onlyId) query = query.eq('id', onlyId);
  const { data, error } = await query;
  if (error) throw toError(error, 'Failed to list active sequences');
  return (data || []).map((s)=>s.id);
}
async function getDueEnrollments(sequenceIds) {
  if (sequenceIds.length === 0) return [];
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase.from('sequence_enrollments').select('*, sequences(id, campaign_id, name, status, recipient_type, send_mode), ' + 'contacts(*)').in('sequence_id', sequenceIds).eq('status', 'active').lte('next_run_at', nowIso).order('next_run_at', {
    ascending: true
  });
  if (error) throw toError(error, 'Failed to fetch due sequence enrollments');
  return data || [];
}
async function reloadEnrollment(enrollmentId) {
  const { data, error } = await supabase.from('sequence_enrollments').select('*, sequences(id, campaign_id, name, status, recipient_type, send_mode), ' + 'contacts(*)').eq('id', enrollmentId).maybeSingle();
  if (error) throw toError(error, 'Failed to reload sequence enrollment');
  return data || null;
}
async function resumeCompletedEnrollments(sequenceIds) {
  if (!sequenceIds || sequenceIds.length === 0) return 0;
  const { data: sequences, error: seqError } = await supabase.from('sequences').select('id, status, send_mode').in('id', sequenceIds);
  if (seqError) throw toError(seqError, 'Failed to list sequences for resume');
  const activeAuto = (sequences || []).filter((s)=>s.status === 'active' && s.send_mode !== 'manual');
  if (activeAuto.length === 0) return 0;
  const activeIds = activeAuto.map((s)=>s.id);
  const { data: steps, error: stepsError } = await supabase.from('sequence_steps').select('id, sequence_id, parent_step_id, step_number, created_at, archived_at').in('sequence_id', activeIds);
  if (stepsError) throw toError(stepsError, 'Failed to fetch sequence steps for resume');
  const stepById = new Map();
  const latestChildByStep = new Map();
  for (const step of steps || []){
    stepById.set(step.id, step);
    if (step.parent_step_id && !step.archived_at) {
      const existing = latestChildByStep.get(step.parent_step_id);
      if (!existing || step.created_at > existing) {
        latestChildByStep.set(step.parent_step_id, step.created_at);
      }
    }
  }
  if (stepById.size === 0 || latestChildByStep.size === 0) return 0;
  const activeAncestor = (stepId, seen = new Set())=>{
    if (!stepId || seen.has(stepId)) return null;
    seen.add(stepId);
    const step = stepById.get(stepId);
    if (!step) return null;
    if (!step.archived_at) return step;
    return activeAncestor(step.parent_step_id, seen);
  };
  const { data: enrollments, error: enrollError } = await supabase.from('sequence_enrollments').select('id, contact_id, sequence_id, current_step_id, updated_at').in('sequence_id', activeIds).eq('status', 'completed').not('current_step_id', 'is', null);
  if (enrollError) throw toError(enrollError, 'Failed to fetch completed sequence enrollments');
  const nowIso = new Date().toISOString();
  let revived = 0;
  for (const enrollment of enrollments || []){
    const currentStep = stepById.get(enrollment.current_step_id);
    const anchor = currentStep && !currentStep.archived_at ? currentStep : activeAncestor(enrollment.current_step_id);
    if (!anchor) continue;
    const childCreated = latestChildByStep.get(anchor.id);
    if (!childCreated) continue;
    const completedAt = enrollment.updated_at ? new Date(enrollment.updated_at).getTime() : 0;
    if (completedAt >= new Date(childCreated).getTime()) continue;
    const reparent = anchor.id !== enrollment.current_step_id;
    const { error: upError } = await supabase.from('sequence_enrollments').update(reparent ? {
      status: 'active',
      current_step_id: anchor.id,
      current_step: Number(anchor.step_number),
      current_email_type: emailTypeForNode(anchor),
      next_run_at: nowIso,
      updated_at: nowIso
    } : {
      status: 'active',
      next_run_at: nowIso,
      updated_at: nowIso
    }).eq('id', enrollment.id).eq('status', 'completed');
    if (upError) {
      logErr(`Failed to revive enrollment ${enrollment.id}: ${upError.message}`);
      continue;
    }
    revived += 1;
    log(reparent ? `Revived + re-parented completed enrollment ${enrollment.id} — archived step ${enrollment.current_step_id} → live step ${anchor.id}` : `Revived completed enrollment ${enrollment.id} — step ${enrollment.current_step_id} gained children after completion`);
  }
  return revived;
}
/**
 * Repair stale scheduling on existing ACTIVE enrollments that the old 5-minute
 * claim/retry logic parked in the future. The step's OWN configured wait is the
 * source of truth:
 *   - A STARTING step (Step 1) with an Immediate wait must always be due NOW,
 *     so its next_run_at is pulled to the current time and the next 30-second
 *     cron tick sends it.
 *   - Any step with a real wait keeps its future due time untouched — a 1h+ or
 *     branch-parked enrollment is never blindly made Immediate.
 * No enrollments are deleted or recreated.
 */
async function repairStaleImmediateEnrollments(sequenceIds) {
  if (!sequenceIds || sequenceIds.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const { data: enrollments, error } = await supabase.from('sequence_enrollments').select('id, sequence_id, current_step_id, next_run_at').in('sequence_id', sequenceIds).eq('status', 'active').not('next_run_at', 'is', null).gt('next_run_at', nowIso);
  if (error) throw toError(error, 'Failed to list enrollments for scheduling repair');
  if (!enrollments || enrollments.length === 0) return 0;
  const stepsBySeq = new Map();
  for (const seqId of sequenceIds){
    const { data: steps, error: sErr } = await supabase.from('sequence_steps').select('id, parent_step_id, wait_hours, send_after_value, send_after_unit').eq('sequence_id', seqId).is('archived_at', null);
    if (sErr) throw toError(sErr, 'Failed to list steps for scheduling repair');
    stepsBySeq.set(seqId, steps || []);
  }
  let repaired = 0;
  for (const enrollment of enrollments || []){
    const steps = stepsBySeq.get(enrollment.sequence_id) || [];
    const step = steps.find((s)=>s.id === enrollment.current_step_id);
    if (!step || step.parent_step_id) continue;
    if (waitMsOf(step) > 0) continue;
    const { error: upErr } = await supabase.from('sequence_enrollments').update({
      next_run_at: nowIso,
      updated_at: nowIso
    }).eq('id', enrollment.id);
    if (upErr) {
      logErr(`Scheduling repair failed for enrollment ${enrollment.id}: ${upErr.message}`);
      continue;
    }
    repaired += 1;
    log(`[SEQUENCE WORKER] repair — immediate starting-step enrollment ${enrollment.id} made due now (was ${enrollment.next_run_at})`);
  }
  return repaired;
}
/** Atomically claim a due enrollment (only one tick ever sends its current step). */ async function claimEnrollment(enrollmentId) {
  const nowIso = new Date().toISOString();
  const lockUntil = new Date(Date.now() + CLAIM_LOCK_MS).toISOString();
  const { data, error } = await supabase.from('sequence_enrollments').update({
    next_run_at: lockUntil,
    updated_at: nowIso
  }).eq('id', enrollmentId).eq('status', 'active').lte('next_run_at', nowIso).select('id').maybeSingle();
  if (error) throw toError(error, 'Failed to claim sequence enrollment');
  return data != null;
}
// ─── Context + tree helpers ────────────────────────────────────────────────
async function loadSequenceContext(enrollment) {
  const { data: steps, error } = await supabase.from('sequence_steps').select('*').eq('sequence_id', enrollment.sequence_id).is('archived_at', null).order('step_number', {
    ascending: true
  });
  if (error) throw toError(error, 'Failed to fetch sequence steps');
  const stepsList = steps || [];
  const startingStep = stepsList.find((s)=>s.parent_step_id === null) || stepsList[0] || null;
  let currentStep = null;
  if (enrollment.current_step_id) {
    currentStep = stepsList.find((s)=>s.id === enrollment.current_step_id) || null;
  }
  if (!currentStep) {
    const stepNumber = Number(enrollment.current_step);
    currentStep = stepsList.find((s)=>Number(s.step_number) === stepNumber) || startingStep;
  }
  return {
    steps: stepsList,
    startingStep,
    currentStep
  };
}
async function getStepLog(sequenceId, contactId, stepId) {
  if (!stepId) return null;
  const { data, error } = await supabase.from('sequence_step_logs').select('*').eq('sequence_id', sequenceId).eq('contact_id', contactId).eq('sequence_step_id', stepId).maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence step log');
  return data || null;
}
async function getEmailLog(emailLogId) {
  if (!emailLogId) return null;
  const { data, error } = await supabase.from('email_logs').select('id, status, opened, opened_at, clicked, clicked_at, sent_at').eq('id', emailLogId).maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence email log');
  return data || null;
}
/** CENTRAL node eligibility — the single source of truth for branch membership. */ async function evaluateNodeEligibility({ sequenceId, contactId, step }) {
  if (!step.parent_step_id) {
    return {
      eligible: true,
      branch: 'starting',
      opened: null,
      opened_at: null,
      email_status: null,
      parentSentAt: null,
      parentEmailLogId: null
    };
  }
  const parentLog = await getStepLog(sequenceId, contactId, step.parent_step_id);
  if (!parentLog) {
    return {
      eligible: false,
      branch: 'none',
      opened: null,
      opened_at: null,
      email_status: null,
      parentSentAt: null,
      parentEmailLogId: null,
      reason: 'parent_not_sent'
    };
  }
  const emailLog = parentLog.email_log_id ? await getEmailLog(parentLog.email_log_id) : null;
  const sent = !!(emailLog ? emailLog.status === 'sent' : parentLog.status === 'sent');
  const opened = !!(emailLog ? emailLog.opened === true : parentLog.opened === true);
  const openedAt = emailLog && emailLog.opened_at || parentLog.opened_at || null;
  const clicked = !!(emailLog ? emailLog.clicked === true : parentLog.clicked === true);
  const clickedAt = emailLog && emailLog.clicked_at || parentLog.clicked_at || null;
  const branch = step.parent_branch === BRANCH_NOT_OPENED ? 'not_opened' : 'opened';
  const parentSkipped = parentLog.status === 'skipped';
  let eligible = parentSkipped || (branch === 'not_opened' ? sent && opened === false : opened === true);
  // Linear time-based chain: the OPENED child becomes eligible as soon as the
  // parent email is sent when it is the parent's only child.
  if (!eligible && branch === 'opened' && sent && await isLinearChild(sequenceId, step)) {
    eligible = true;
  }
  return {
    eligible,
    branch,
    opened,
    parent_skipped: parentSkipped,
    opened_at: openedAt,
    email_status: emailLog && emailLog.status || parentLog.status || 'sent',
    parentSentAt: parentLog.sent_at || emailLog && emailLog.sent_at || null,
    parentEmailLogId: parentLog.email_log_id || null,
    clicked,
    clicked_at: clickedAt
  };
}
async function isLinearChild(sequenceId, step) {
  if (!step || !step.parent_step_id) return false;
  const { data: siblings } = await supabase.from('sequence_steps').select('parent_branch').eq('sequence_id', sequenceId).eq('parent_step_id', step.parent_step_id).is('archived_at', null);
  const list = siblings || [];
  return list.length > 0 && list.every((s)=>s.parent_branch === BRANCH_OPENED);
}
// ─── Per-step batching (cloud-scheduled) ──────────────────────────────────
// Every step owns an INDEPENDENT batch queue: sequence_step_batch_state row per
// (sequence_id, sequence_step_id) holds that step's batch_size/counters and its
// own next_batch_at. The shared sequences.batch_* columns are the single
// user-facing configuration; the runtime queue paces each step autonomously.
//
// GATE RULE (single source of truth — checked at the START of processStepSend,
// so the DESTINATION step's queue paces the send):
//   * sequence.batch_enabled=false OR no batch state row  -> send immediately
//   * next_batch_at in the future (first-batch or between-batch window) ->
//     DEFER the enrollment: next_run_at = next_batch_at. The cloud cron keeps
//     ticking (laptop off); when the window opens the due enrollment re-enters
//     the drain loop and is sent. A browser/laptop timer is never the agent.
//   * otherwise the window is open -> send (increment_sequence_batch_count
//     records the send atomically and rolls into the next batch when full).
async function loadStepBatchState(sequenceId, stepId) {
  if (!stepId) return null;
  const { data, error } = await supabase.from('sequence_step_batch_state').select('*').eq('sequence_id', sequenceId).eq('sequence_step_id', stepId).maybeSingle();
  if (error) {
    logErr(`[BATCH] Failed to read batch state for sequence ${sequenceId} step ${stepId}: ${error.message}`);
    return null;
  }
  return data || null;
}

/** Ensure a step has its batch queue row (defensive — the API also creates rows on activation/config save). */ async function ensureStepBatchState(sequence, step) {
  const existing = await loadStepBatchState(sequence.id, step.id);
  if (existing) return existing;
  try {
    const { error } = await supabase.rpc('create_sequence_batch_state', {
      p_sequence_id: sequence.id,
      p_sequence_step_id: step.id,
      p_batch_size: batchSizeOf(sequence),
      p_batch_enabled: true,
      p_first_delay: Number(sequence.first_batch_delay_hours) || 0,
      p_subsequent_delay: Number(sequence.subsequent_batch_delay_hours) || 1
    });
    if (error) logErr(`[BATCH] Failed to create batch state for step ${step.id}: ${error.message}`);
  } catch (error) {
    logErr(`[BATCH] Failed to create batch state for step ${step.id}: ${error.message}`);
  }
  return loadStepBatchState(sequence.id, step.id);
}

/** Batch gate: { allowed } or { allowed:false, deferredTo } where deferredTo is the next batch window. */ async function stepBatchGate(sequence, step) {
  if (!sequence || !step || !sequence.batch_enabled) return {
    allowed: true
  };
  const state = await ensureStepBatchState(sequence, step);
  if (!state || !state.batch_enabled) return {
    allowed: true
  };
  const nextAt = state.next_batch_at ? new Date(state.next_batch_at).getTime() : 0;
  if (nextAt > Date.now()) {
    return {
      allowed: false,
      deferredTo: new Date(state.next_batch_at).toISOString()
    };
  }
  return {
    allowed: true
  };
}

/** Call AFTER a provider-confirmed send to record the batch slot (atomic, rolls into the next scheduled batch when full). */ async function recordStepBatchSend(sequence, step) {
  if (!sequence || !sequence.batch_enabled || !step) return;
  try {
    const { data, error } = await supabase.rpc('increment_sequence_batch_count', {
      p_sequence_id: sequence.id,
      p_sequence_step_id: step.id,
      p_batch_size: batchSizeOf(sequence),
      p_next_delay_hours: Number(sequence.subsequent_batch_delay_hours) || 1
    });
    if (error) {
      logErr(`[BATCH] Failed to record step send for step ${step.id}: ${error.message}`);
      return;
    }
    const first = data && data[0];
    if (first && first.scheduled) {
      log(`[BATCH] step ${step.id}/${step.step_number} — batch ${first.batch_number - 1} filled (${batchSizeOf(sequence)} sent), next batch window ${first.next_batch_at} (cloud-scheduled)`);
    }
  } catch (error) {
    logErr(`[BATCH] Failed to record step send for step ${step.id}: ${error.message}`);
  }
}

/**
 * End-of-tick pass: mark a step's batch queue COMPLETED once every enrollment
 * that was positioned on it has moved on (i.e. all eligible sends for the step
 * are delivered). Only steps that already STARTED are considered (a fresh
 * branch could still receive enrollments), and any later send clears
 * completed_at via the increment, so late branch arrivals stay consistent.
 */
async function completeDrainedStepBatches(sequenceIds) {
  for (const sequenceId of sequenceIds || []){
    try {
      const { data: states, error: stateError } = await supabase.from('sequence_step_batch_state').select('*').eq('sequence_id', sequenceId);
      if (stateError) continue;
      for (const state of states || []){
        if (state.completed_at || state.current_batch_number <= 0) continue;
        const { count } = await supabase.from('sequence_enrollments').select('id', {
          count: 'exact',
          head: true
        }).eq('sequence_id', sequenceId).eq('status', 'active').eq('current_step_id', state.sequence_step_id);
        if (count === 0) {
          await supabase.rpc('complete_sequence_batch_state', {
            p_sequence_id: sequenceId,
            p_sequence_step_id: state.sequence_step_id
          });
          log(`[BATCH] step ${state.sequence_step_id} queue fully drained — marked completed`);
        }
      }
    } catch (error) {
      logErr(`[BATCH] completion pass failed for sequence ${sequenceId}: ${error.message}`);
    }
  }
}
function batchSizeOf(sequence) {
  const value = Number(sequence && sequence.batch_size);
  return Number.isFinite(value) && value > 0 ? value : 30;
}
// ─── Sending ──────────────────────────────────────────────────────────────
function resolveStepContent(step, emailType) {
  if (emailType === 'increment' && step.increment_subject && step.increment_body) {
    return {
      subject: step.increment_subject,
      body: step.increment_body
    };
  }
  return {
    subject: step.normal_subject,
    body: step.normal_body
  };
}
// ─── Attachment cache ──────────────────────────────────────────────────────
// Attachments belong to the step, so all recipients sent the same step in one
// tick share the same files. Cache the downloaded bytes per step id (short TTL)
// so a step sent to many recipients isn't re-downloaded for each email.
const STEP_ATTACHMENT_CACHE = new Map();
const STEP_ATTACHMENT_CACHE_TTL_MS = 5 * 60 * 1000;
async function cachedStepAttachments(sequenceId, step) {
  // Sequence Builder attachments live against the branch-step row that mirrors
  // this sequence_steps node — resolve it so those files ride with the send too.
  const branchStepId = await resolveBranchStepId(sequenceId, step);
  const cacheKey = `${step.id}:${branchStepId ?? 'none'}`;
  const cached = STEP_ATTACHMENT_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < STEP_ATTACHMENT_CACHE_TTL_MS) {
    return cached.items;
  }
  const stepItems = await loadAndDownloadStepAttachments(step.id);
  const branchItems = branchStepId != null ? await loadAndDownloadBranchStepAttachments(branchStepId) : [];
  const items = [
    ...stepItems,
    ...branchItems
  ];
  STEP_ATTACHMENT_CACHE.set(cacheKey, {
    at: Date.now(),
    items
  });
  return items;
}
/**
 * Prepare ONE sequence step email: personalise the step's configured database
 * subject/body and create a PENDING email_log row (tracking_id). The actual
 * SMTP hand-off happens in sendPreparedEmail — the caller links the step log to
 * this email_log BETWEEN these two steps so a provider failure is recorded
 * (Failed count + the real error) instead of leaving the recipient pending.
 */ async function prepareStepEmail({ enrollment, step, emailType, contact }) {
  const { subject, body } = resolveStepContent(step, emailType);
  const decoded = decodeHtmlEntities(personalizeTemplate(body || '', contact));
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);
  const subjectLine = personalizeTemplate(subject || '', contact);
  const trackingId = crypto.randomUUID();
  const { data: emailLog, error: createError } = await supabase.from('email_logs').insert({
    campaign_id: null,
    contact_id: enrollment.contact_id,
    email: contact.email,
    status: 'pending',
    retry_count: 0,
    tracking_id: trackingId
  }).select('*').single();
  if (createError) {
    if (createError.code === '42703') {
      const { data: emailLog2, error: createError2 } = await supabase.from('email_logs').insert({
        campaign_id: null,
        contact_id: enrollment.contact_id,
        email: contact.email,
        status: 'pending',
        retry_count: 0
      }).select('*').single();
      if (createError2) throw toError(createError2, 'Failed to create email log for sequence send');
      return {
        subjectLine,
        personalizedHtml,
        plainText,
        emailLog: emailLog2,
        trackingId
      };
    }
    throw toError(createError, 'Failed to create email log for sequence send');
  }
  return {
    subjectLine,
    personalizedHtml,
    plainText,
    emailLog,
    trackingId
  };
}
/**
 * Send the prepared sequence email over SMTP and mark its email_log sent /
 * failed. Attachment loading happens here — if an attachment cannot be loaded
 * the send aborts and the email_log is marked failed with the real error
 * (never silently sent without its files, never left pending).
 */ async function sendPreparedEmail({ enrollment, step, contact, prepared }) {
  const { subjectLine, personalizedHtml, plainText, emailLog, trackingId } = prepared;
  // Click tracking: rewrite every link to the click-tracker Edge Function.
  let html = rewriteLinksForTracking(personalizedHtml, trackingId, EDGE_FUNCTION_BASE);
  // Always embed the email-open-tracker Edge Function pixel — reachable even
  // when the laptop is off and marks this exact email_log opened.
  html = appendOpenPixel(html, emailLog.id, contact.email, trackingId);
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(html));
  const attachments = await cachedStepAttachments(enrollment.sequence_id, step);
  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  log(`[Personalization] recipient=${contact.email}`);
  log(`[Personalization] contact_id=${contact.id || enrollment.contact_id || '(none)'}`);
  log(`[Personalization] full_name=${contact.full_name || ''}`);
  log(`[Personalization] company=${contact.company || ''}`);
  log(`[Personalization] designation=${contact.designation || ''}`);
  log(`[Personalization] rendered_subject=${String(subjectLine || '').slice(0, 200)}`);
  log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);
  try {
    const result = await sendSmtp({
      to: contact.email,
      subject: subjectLine,
      html: docHtml,
      text: plainText,
      attachments
    });
    await supabase.from('email_logs').update({
      status: 'sent',
      sent_at: new Date().toISOString()
    }).eq('id', emailLog.id);
    if (attachments.length > 0) {
      log(`[Sequence Attachment] Email sent with ${attachments.length} attachment(s) → ${contact.email}`);
    }
    return {
      emailLog,
      result
    };
  } catch (error) {
    const message = error.message || String(error);
    try {
      const { error: updateError } = await supabase.from('email_logs').update({
        status: 'failed',
        error_message: `[SEND_FAILED] ${message}`,
        last_attempt_at: new Date().toISOString()
      }).eq('id', emailLog.id);
      if (updateError) {
        logErr(`Failed to mark email log ${emailLog.id} failed after send error: ${updateError.message}`);
      }
    } catch (updateError) {
      logErr(`Failed to mark email log ${emailLog.id} failed after send error: ${updateError.message}`);
    }
    throw error;
  }
}
async function insertStepLog({ enrollment, step, emailLog }) {
  if (!emailLog || !emailLog.id) {
    throw new Error('Cannot log sequence step without an email_log_id — aborting to avoid a broken branch link');
  }
  // The step log is created in 'pending' state and linked to the email_log
  // BEFORE the provider send so a failure can be recorded against it. It is
  // only flipped to 'sent' (with sent_at) AFTER the SMTP provider confirms a
  // successful delivery — a failed send is never marked sent.
  const { error } = await supabase.from('sequence_step_logs').insert({
    sequence_id: enrollment.sequence_id,
    sequence_step_id: step.id,
    contact_id: enrollment.contact_id,
    email_log_id: emailLog.id,
    sent_at: null,
    opened: false,
    clicked: false,
    status: 'pending'
  });
  if (error && error.code === '23505') {
    await supabase.from('sequence_step_logs').update({
      email_log_id: emailLog.id,
      status: 'pending',
      sent_at: null
    }).eq('sequence_id', enrollment.sequence_id).eq('sequence_step_id', step.id).eq('contact_id', enrollment.contact_id).is('email_log_id', null);
  }
  return error;
}
/** Mark a step log 'sent' + timestamp ONLY after the SMTP provider confirmed delivery. */ async function markStepLogSent({ enrollment, step, sentAtIso }) {
  const { error } = await supabase.from('sequence_step_logs').update({
    status: 'sent',
    sent_at: sentAtIso
  }).eq('sequence_id', enrollment.sequence_id).eq('sequence_step_id', step.id).eq('contact_id', enrollment.contact_id);
  if (error) logErr(`Failed to mark sequence step log ${step.id}/${step.step_number} sent: ${error.message}`);
}
/** Mark a step log 'failed' on a provider send error (sent_at stays NULL — never counted as sent). */ async function markStepLogFailed({ enrollment, step }) {
  const { error } = await supabase.from('sequence_step_logs').update({
    status: 'failed',
    sent_at: null
  }).eq('sequence_id', enrollment.sequence_id).eq('sequence_step_id', step.id).eq('contact_id', enrollment.contact_id);
  if (error) logErr(`Failed to mark sequence step log ${step.id}/${step.step_number} failed: ${error.message}`);
}
async function insertSkippedStepLog({ enrollment, step }) {
  const { error } = await supabase.from('sequence_step_logs').insert({
    sequence_id: enrollment.sequence_id,
    sequence_step_id: step.id,
    contact_id: enrollment.contact_id,
    email_log_id: null,
    sent_at: new Date().toISOString(),
    opened: false,
    clicked: false,
    status: 'skipped'
  });
  return error;
}
// ─── State advancement (branch tree) ───────────────────────────────────────
async function moveEnrollmentTo(enrollmentId, step, atIso) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('sequence_enrollments').update({
    current_step_id: step.id,
    current_step: Number(step.step_number),
    current_email_type: emailTypeForNode(step),
    status: 'active',
    next_run_at: atIso,
    updated_at: nowIso
  }).eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to advance sequence enrollment');
  log('[SCHEDULED]', `enrollment=${enrollmentId} step=${step.id}/${step.step_number} (${step.parent_branch || 'STARTING'}) due ${atIso}`);
}
async function completeEnrollment(enrollmentId) {
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('sequence_enrollments').update({
    status: 'completed',
    next_run_at: null,
    current_email_type: 'normal',
    updated_at: nowIso
  }).eq('id', enrollmentId);
  if (error) throw toError(error, 'Failed to complete sequence enrollment');
}
async function advanceSkippedStep({ enrollment, sequence, context, currentStep, contact }) {
  const children = childrenOf(context.steps, currentStep.id);
  const openedChild = children.find((c)=>c.parent_branch === BRANCH_OPENED) || null;
  const recipient = contact && contact.email || enrollment.contact_id;
  if (!openedChild) {
    await completeEnrollment(enrollment.id);
    log(`${recipient} skipped step ${currentStep.step_number} (no next step) — sequence completed`);
    return {
      completed: true,
      skipped: true
    };
  }
  const atMs = Date.now() + waitMsOf(openedChild);
  const atIso = new Date(atMs).toISOString();
  await moveEnrollmentTo(enrollment.id, openedChild, atIso);
  log(`${recipient} skipped step ${currentStep.step_number} — advancing to step ${openedChild.step_number} (send after delay), due ${atIso}`);
  return {
    skipped: true,
    advancedTo: openedChild.step_number,
    scheduled_for: atIso
  };
}
async function advanceAfterSend({ enrollment, sequence, contact }) {
  const context = await loadSequenceContext(enrollment);
  const currentStep = context.currentStep;
  if (!currentStep) {
    await completeEnrollment(enrollment.id);
    return {
      completed: true
    };
  }
  const stepLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
  const emailLog = stepLog && stepLog.email_log_id ? await getEmailLog(stepLog.email_log_id) : null;
  const opened = !!(emailLog ? emailLog.opened === true : stepLog && stepLog.opened === true);
  const nowMs = Date.now();
  const sentMs = stepLog && stepLog.sent_at ? new Date(stepLog.sent_at).getTime() : nowMs;
  const openedMs = emailLog && emailLog.opened_at ? new Date(emailLog.opened_at).getTime() : stepLog && stepLog.opened_at ? new Date(stepLog.opened_at).getTime() : sentMs;
  const recipient = contact && contact.email || enrollment.contact_id;
  const children = childrenOf(context.steps, currentStep.id);
  const openedChild = children.find((c)=>c.parent_branch === BRANCH_OPENED) || null;
  const notOpenedChild = children.find((c)=>c.parent_branch === BRANCH_NOT_OPENED) || null;
  // OPENED FAST PATH — an open already recorded on this node's OWN email
  // (edge-mode tracking writes email_logs directly; legacy tracking
  // additionally fires handleStepOpened) advances the recipient to the OPENED
  // child NOW instead of waiting out the whole open-detection window. The
  // child's email is due at (open time + child.wait_hours), so wait_hours=0
  // sends immediately.
  if (opened && openedChild) {
    const atMs = openedMs + waitMsOf(openedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, openedChild, atIso);
    log(`step ${currentStep.step_number} opened (recorded within detection window) — advancing to step ${openedChild.step_number} (opened), due ${atIso}`);
    return {
      advancedTo: openedChild.step_number,
      advancedToId: openedChild.id,
      branch: 'opened',
      scheduled_for: atIso
    };
  }
  if (opened) {
    // Opened but no 'OPENED' child exists yet — auto-recovery: keep the
    // enrollment ACTIVE and re-check so a child added later resumes the chain.
    return leafRecheck({
      enrollment,
      step: currentStep,
      sentMs,
      branch: 'opened',
      nowMs,
      recipient,
      stepNumber: currentStep.step_number
    });
  }
  // BRANCH DECISION IS DEFERRED — never decide in the same tick the email was
  // sent. The recipient stays PARKED ON THE NOT_OPENED CHILD (visible pending
  // state, no email sent) until its own wait period AND the open-detection
  // window have elapsed since the send, then the ACTUAL open tracking state is
  // read and the NOT_OPENED email is sent on its own due time. An open recorded
  // during the parked window re-routes the recipient immediately via
  // email-open-tracker (advanceOpenedBranch). This also stops wait-0 children
  // from firing the whole chain in a single tick.
  if (notOpenedChild) {
    const decisionAtMs = sentMs + Math.max(waitMsOf(currentStep), OPEN_DETECTION_WINDOW_MS);
    if (nowMs < decisionAtMs) {
      const atIso = new Date(Math.min(decisionAtMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
      await moveEnrollmentTo(enrollment.id, notOpenedChild, atIso);
      log(`${recipient} step ${currentStep.step_number} email sent — waiting for open tracking, parked on step ${notOpenedChild.step_number} (not opened), branch decision due ${atIso}`);
      return {
        waiting: true,
        advancedTo: notOpenedChild.step_number,
        advancedToId: notOpenedChild.id,
        branch: 'not_opened',
        scheduled_for: atIso
      };
    }
    // Decision window elapsed AND still not opened — the NOT_OPENED branch is
    // ready. The child's email is due after its OWN wait_hours (0 = next tick).
    const atMs = sentMs + waitMsOf(notOpenedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, notOpenedChild, atIso);
    log(`${recipient} did not open step ${currentStep.step_number} — advancing to step ${notOpenedChild.step_number} (not opened), due ${atIso}`);
    return {
      advancedTo: notOpenedChild.step_number,
      advancedToId: notOpenedChild.id,
      branch: 'not_opened',
      scheduled_for: atIso
    };
  }
  if (openedChild) {
    const atMs = sentMs + waitMsOf(openedChild);
    const atIso = new Date(atMs).toISOString();
    await moveEnrollmentTo(enrollment.id, openedChild, atIso);
    log(`${recipient} step ${currentStep.step_number} — linear sequence, advancing to step ${openedChild.step_number} (send after delay), due ${atIso}`);
    return {
      advancedTo: openedChild.step_number,
      advancedToId: openedChild.id,
      branch: 'opened',
      scheduled_for: atIso
    };
  }
  return leafRecheck({
    enrollment,
    step: currentStep,
    sentMs,
    branch: 'not_opened',
    nowMs,
    recipient,
    stepNumber: currentStep.step_number
  });
}
async function leafRecheck({ enrollment, step, sentMs, branch, nowMs, recipient, stepNumber }) {
  const deadline = sentMs + waitMsOf(step);
  if (nowMs >= deadline) {
    await completeEnrollment(enrollment.id);
    log(`${recipient} step ${stepNumber} (${branch}) has no matching child within the re-check window — branch ends (completed)`);
    return {
      completed: true,
      branch
    };
  }
  const atIso = new Date(Math.max(nowMs, sentMs) + RECHECK_OPENED_MS).toISOString();
  await moveEnrollmentTo(enrollment.id, step, atIso);
  log(`${recipient} step ${stepNumber} (${branch}) has no matching child yet — keeping active, re-check ${atIso}`);
  return {
    waiting: true,
    branch,
    scheduled_for: atIso
  };
}
// ─── Per-enrollment processing ─────────────────────────────────────────────
async function handleNotEligible({ enrollment, sequence, context, currentStep, elig, contact }) {
  const nowMs = Date.now();
  const recipient = contact && contact.email || enrollment.contact_id;
  if (elig.branch === 'not_opened' && elig.parentSentAt) {
    const parentSentMs = new Date(elig.parentSentAt).getTime();
    const atMs = parentSentMs + waitMsOf(currentStep);
    if (elig.opened === true) {
      const parent = context.steps.find((s)=>s.id === currentStep.parent_step_id) || null;
      const openedChild = parent ? childrenOf(context.steps, parent.id).find((c)=>c.parent_branch === BRANCH_OPENED) || null : null;
      if (openedChild) {
        await moveEnrollmentTo(enrollment.id, openedChild, new Date(nowMs).toISOString());
        log(`${recipient} opened during the wait — re-routing to step ${openedChild.step_number} (opened)`);
        return {
          rerouted: true,
          to: openedChild.step_number,
          branch: 'opened'
        };
      }
      if (parent) {
        const atIso = new Date(nowMs + RECHECK_OPENED_MS).toISOString();
        await moveEnrollmentTo(enrollment.id, parent, atIso);
        log(`${recipient} opened during the wait — parent step ${parent.step_number} has no OPENED child yet; keeping active, re-check ${atIso}`);
        return {
          waiting: true,
          parked_on: parent.step_number,
          scheduled_for: atIso
        };
      }
      await completeEnrollment(enrollment.id);
      return {
        completed: true,
        reason: 'opened_no_opened_child'
      };
    }
    const atIso = new Date(Math.max(atMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
    await moveEnrollmentTo(enrollment.id, currentStep, atIso);
    log(`${recipient} waiting for step ${currentStep.step_number} (not opened) — re-check ${atIso}`);
    return {
      waiting: true,
      scheduled_for: atIso
    };
  }
  if (elig.branch === 'opened' && elig.eligible) {
    const eventMs = elig.opened_at ? new Date(elig.opened_at).getTime() : elig.parentSentAt ? new Date(elig.parentSentAt).getTime() : nowMs;
    const atMs = eventMs + waitMsOf(currentStep);
    const atIso = new Date(Math.max(atMs, nowMs + CHECK_INTERVAL_MS)).toISOString();
    await moveEnrollmentTo(enrollment.id, currentStep, atIso);
    log(`${recipient} waiting for step ${currentStep.step_number} (opened) — re-check ${atIso}`);
    return {
      waiting: true,
      scheduled_for: atIso
    };
  }
  const atIso = new Date(nowMs + RECHECK_OPENED_MS).toISOString();
  await moveEnrollmentTo(enrollment.id, currentStep, atIso);
  return {
    waiting: true,
    scheduled_for: atIso
  };
}
async function processDueEnrollment(enrollment) {
  const sequence = enrollment.sequences;
  if (!sequence) return {
    skipped: true
  };
  if (sequence.send_mode === 'manual') {
    return {
      skipped: true,
      reason: 'manual_sequence_user_triggered'
    };
  }
  const context = await loadSequenceContext(enrollment);
  const currentStep = context.currentStep;
  if (!currentStep) {
    logErr(`Enrollment ${enrollment.id} has no current step node — marking completed`);
    await completeEnrollment(enrollment.id);
    return {
      completed: true
    };
  }
  log(`[SEQUENCE SEND] wait_hours=${currentStep.wait_hours ?? 'null'}`);
  const contact = enrollment.contacts || {};
  if (currentStep.send_action === 'skip') {
    const skipLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
    if (!skipLog) {
      const skipError = await insertSkippedStepLog({
        enrollment,
        step: currentStep
      });
      if (skipError && skipError.code !== '23505') {
        throw toError(skipError, 'Failed to log skipped sequence step');
      }
    }
    return advanceSkippedStep({
      enrollment,
      sequence,
      context,
      currentStep,
      contact
    });
  }
  const existingStepLog = await getStepLog(sequence.id, enrollment.contact_id, currentStep.id);
  if (existingStepLog) {
    const linkedEmailLog = existingStepLog.email_log_id ? await getEmailLog(existingStepLog.email_log_id) : null;
    const sentOk = linkedEmailLog ? linkedEmailLog.status === 'sent' : existingStepLog.status === 'sent';
    const skipped = existingStepLog.status === 'skipped';
    if (sentOk || skipped) {
      return advanceAfterSend({
        enrollment,
        sequence,
        contact
      });
    }
    // A previous provider attempt for this step is pending/failed — re-send it.
    // The step log row is reused (email_log_id updated) so the recipient is
    // never left silently pending and the real provider error stays visible.
    log(`[SEQUENCE SEND] step ${currentStep.step_number} previous attempt status=${linkedEmailLog ? linkedEmailLog.status : existingStepLog.status} — re-sending`);
    return processStepSend({
      enrollment,
      sequence,
      context,
      currentStep,
      contact,
      existingStepLog
    });
  }
  if (!currentStep.parent_step_id) {
    return processStepSend({
      enrollment,
      sequence,
      context,
      currentStep,
      contact
    });
  }
  const elig = await evaluateNodeEligibility({
    sequenceId: sequence.id,
    contactId: enrollment.contact_id,
    step: currentStep
  });
  log('[SEQUENCE]', sequence.id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[PARENT]', currentStep.parent_step_id, '[BRANCH]', currentStep.parent_branch, '[WAIT_HOURS]', currentStep.wait_hours, '[ELIGIBLE]', elig.eligible, '[ALREADY_SENT]', !!existingStepLog, '[READY_TO_SEND]', elig.eligible && !existingStepLog, '[RECIPIENT]', enrollment.contact_id, contact && contact.email || '');
  if (elig.branch === 'not_opened') {
    const parentSentMs = elig.parentSentAt ? new Date(elig.parentSentAt).getTime() : Date.now();
    const atMs = parentSentMs + waitMsOf(currentStep);
    const eligibleNow = elig.eligible && atMs <= Date.now();
    if (!eligibleNow) {
      return handleNotEligible({
        enrollment,
        sequence,
        context,
        currentStep,
        elig,
        contact
      });
    }
    return processStepSend({
      enrollment,
      sequence,
      context,
      currentStep,
      contact
    });
  }
  if (elig.eligible) {
    const eventMs = elig.opened_at ? new Date(elig.opened_at).getTime() : elig.parentSentAt ? new Date(elig.parentSentAt).getTime() : Date.now();
    const atMs = eventMs + waitMsOf(currentStep);
    if (atMs > Date.now()) {
      return handleNotEligible({
        enrollment,
        sequence,
        context,
        currentStep,
        elig,
        contact
      });
    }
    return processStepSend({
      enrollment,
      sequence,
      context,
      currentStep,
      contact
    });
  }
  return handleNotEligible({
    enrollment,
    sequence,
    context,
    currentStep,
    elig,
    contact
  });
}
async function processEnrollmentChain(initial) {
  let enrollment = initial;
  for(let depth = 0; depth < MAX_CHAIN_DEPTH; depth++){
    const result = await processDueEnrollment(enrollment);
    if (result.skipped || result.failed || result.completed) return result;
    const fresh = await reloadEnrollment(enrollment.id);
    if (!fresh || fresh.status !== 'active') return result;
    const dueMs = fresh.next_run_at ? new Date(fresh.next_run_at).getTime() : 0;
    if (dueMs > Date.now()) return result;
    enrollment = fresh;
  }
  log(`Chain walk for enrollment ${initial.id} hit MAX_CHAIN_DEPTH — leaving to next tick`);
  return {
    looped: true
  };
}
async function processStepSend({ enrollment, sequence, context, currentStep, contact, existingStepLog }) {
  // Per-step batching gate — the DESTINATION step's own queue decides whether
  // this recipient may be sent NOW. A closed window defers the enrollment by
  // pushing next_run_at to next_batch_at; the cloud cron re-arms it when the
  // window opens (laptop can stay closed). Nothing else runs in here.
  const gate = await stepBatchGate(sequence, currentStep);
  if (!gate.allowed && gate.deferredTo) {
    await supabase.from('sequence_enrollments').update({
      next_run_at: gate.deferredTo,
      updated_at: new Date().toISOString()
    }).eq('id', enrollment.id);
    log(`[BATCH] step ${currentStep.id}/${currentStep.step_number} window not open (next ${gate.deferredTo}) — deferred enrollment ${enrollment.id}`);
    return {
      deferred: true,
      deferredTo: gate.deferredTo
    };
  }
  const emailType = emailTypeForNode(currentStep);
  try {
    log('[SENDING]', contact && contact.email || enrollment.contact_id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[PARENT]', currentStep.parent_step_id, '[BRANCH]', currentStep.parent_branch, '[SEQUENCE]', sequence.id);
    const prepared = await prepareStepEmail({
      enrollment,
      step: currentStep,
      emailType,
      contact
    });
    // Link the step log to this email_log BEFORE the provider send so a failure
    // is recorded (Failed count + the real provider error) instead of leaving
    // the recipient silently pending forever. The step log stays 'pending'
    // (never 'sent', sent_at stays NULL) until the SMTP provider confirms the
    // send actually succeeded.
    if (existingStepLog) {
      const { error: upErr } = await supabase.from('sequence_step_logs').update({
        email_log_id: prepared.emailLog.id,
        status: 'pending',
        sent_at: null
      }).eq('id', existingStepLog.id);
      if (upErr) throw toError(upErr, 'Failed to update sequence step log on re-send');
    } else {
      const insertError = await insertStepLog({
        enrollment,
        step: currentStep,
        emailLog: prepared.emailLog
      });
      if (insertError && insertError.code === '23505') {
        log(`Step ${currentStep.step_number} already logged for ${enrollment.contact_id} (unique guard) — pointing at the latest email log`);
        await supabase.from('sequence_step_logs').update({
          email_log_id: prepared.emailLog.id,
          status: 'pending',
          sent_at: null
        }).eq('sequence_id', enrollment.sequence_id).eq('sequence_step_id', currentStep.id).eq('contact_id', enrollment.contact_id);
      } else if (insertError) {
        throw toError(insertError, 'Failed to log sequence step');
      }
    }
    log(`[SEQUENCE SEND] provider send started`);
    const { emailLog } = await sendPreparedEmail({
      enrollment,
      step: currentStep,
      contact,
      prepared
    });
    log(`[SEQUENCE SEND] provider send success`);
    // SMTP confirmed delivery — ONLY now mark the step sent and timestamp it.
    await markStepLogSent({
      enrollment,
      step: currentStep,
      sentAtIso: new Date().toISOString()
    });
    // Record the send in the step's batch queue (atomic; rolls into the next
    // scheduled batch when it fills). Never called for failed sends, so a
    // provider failure never burns a batch slot.
    await recordStepBatchSend(sequence, currentStep);
    log('[SENT]', contact && contact.email || enrollment.contact_id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[SEQUENCE]', sequence.id);
    const advanced = await advanceAfterSend({
      enrollment,
      sequence,
      contact
    });
    log('[NEXT_CHILD]', JSON.stringify({
      sequence: sequence.id,
      fromStep: `${currentStep.id}/${currentStep.step_number}`,
      branch: advanced.branch || null,
      childId: advanced.advancedToId || null,
      childNumber: advanced.advancedTo || null,
      status: advanced.completed ? 'completed' : advanced.waiting ? `waiting until ${advanced.scheduled_for}` : 'advanced'
    }));
    log(`Sent step ${currentStep.step_number} (${emailType}) to ${contact && contact.email || enrollment.contact_id} — ` + (advanced.completed ? 'branch ends (completed)' : advanced.waiting ? `parked on step ${currentStep.step_number} until ${advanced.scheduled_for}` : `next step ${advanced.advancedTo} (${advanced.branch})`));
    return {
      sent: true,
      emailType,
      ...advanced
    };
  } catch (error) {
    const message = error.message || String(error);
    log(`[SEQUENCE SEND] provider send FAILED: ${message}`);
    log('[FAILED]', contact && contact.email || enrollment.contact_id, '[STEP]', `${currentStep.id}/${currentStep.step_number}`, '[ERROR]', message);
    logErr(`FAILED to send step ${currentStep.step_number} (${emailType}) to ${contact && contact.email || enrollment.contact_id}: ${message}`);
    // Record the failure state on the step log too (sent_at stays NULL, so the
    // recipient is never counted as sent and never advances to a child branch).
    await markStepLogFailed({
      enrollment,
      step: currentStep
    });
    await supabase.from('sequence_enrollments').update({
      next_run_at: new Date(Date.now() + RETRY_DELAY_SECONDS * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', enrollment.id);
    return {
      failed: true
    };
  }
}
// ─── Tick ──────────────────────────────────────────────────────────────────
async function logBranchSnapshot(sequenceId) {
  try {
    const { steps } = await loadSequenceContext({
      sequence_id: sequenceId
    });
    if (!steps || steps.length === 0) return;
    const { data: enr } = await supabase.from('sequence_enrollments').select('contact_id').eq('sequence_id', sequenceId);
    const enrolled = [
      ...new Set((enr || []).map((e)=>e.contact_id))
    ];
    const { data: logs } = await supabase.from('sequence_step_logs').select('sequence_step_id, contact_id, email_log_id, status').eq('sequence_id', sequenceId);
    const stepLogs = logs || [];
    const emailLogIds = [
      ...new Set(stepLogs.map((l)=>l.email_log_id).filter(Boolean))
    ];
    const emailMap = new Map();
    if (emailLogIds.length > 0) {
      const { data: emails } = await supabase.from('email_logs').select('id, status, opened').in('id', emailLogIds);
      for (const e of emails || [])emailMap.set(e.id, {
        status: e.status,
        opened: e.opened === true
      });
    }
    // A recipient counts as SENT only when the linked email_log has been
    // confirmed 'sent' by the SMTP provider (fallback: step log status when no
    // email log is linked) — never from a pre-send 'pending'/'sent' flag.
    const trulySent = (l)=>l.email_log_id ? emailMap.get(l.email_log_id)?.status === 'sent' : l.status === 'sent';
    const logsByStep = new Map();
    for (const l of stepLogs){
      if (!logsByStep.has(l.sequence_step_id)) logsByStep.set(l.sequence_step_id, []);
      logsByStep.get(l.sequence_step_id).push(l);
    }
    const label = (step)=>step.parent_branch === BRANCH_NOT_OPENED ? `${step.step_number}A` : String(step.step_number);
    const fmt = (ids)=>`[${[
        ...new Set(ids)
      ].join(', ')}]`;
    for (const step of steps){
      const logs = logsByStep.get(step.id) || [];
      const sent = logs.filter(trulySent).map((l)=>l.contact_id);
      const opened = logs.filter((l)=>trulySent(l) && emailMap.get(l.email_log_id)?.opened === true).map((l)=>l.contact_id);
      const notOpened = logs.filter((l)=>trulySent(l) && emailMap.get(l.email_log_id)?.opened !== true).map((l)=>l.contact_id);
      let eligible = [];
      if (!step.parent_step_id) {
        eligible = enrolled;
      } else {
        for (const pl of logsByStep.get(step.parent_step_id) || []){
          const parentEmail = emailMap.get(pl.email_log_id);
          const parentOpened = parentEmail ? parentEmail.opened === true : false;
          const parentSent = parentEmail ? parentEmail.status === 'sent' : pl.status === 'sent';
          const qualifies = step.parent_branch === BRANCH_NOT_OPENED ? parentSent && parentOpened !== true : parentOpened === true;
          if (qualifies) eligible.push(pl.contact_id);
        }
      }
      log(`[BRANCH] STEP ${label(step)} ELIGIBLE: recipient IDs = ${fmt(eligible)}`);
      log(`[BRANCH] STEP ${label(step)} SENT: recipient IDs = ${fmt(sent)}`);
      log(`[BRANCH] STEP ${label(step)} OPENED: recipient IDs = ${fmt(opened)}`);
      log(`[BRANCH] STEP ${label(step)} NOT_OPENED: recipient IDs = ${fmt(notOpened)}`);
    }
  } catch (error) {
    logErr(`[BRANCH] snapshot failed for sequence ${sequenceId}: ${error.message}`);
  }
}
/**
 * Short human label for a per-enrollment outcome so the logs show exactly what
 * happened (sent / completed / waiting-until / advanced-to / failed / …).
 */
function outcomeLabel(result) {
  if (!result) return 'done';
  if (result.sent) return 'sent';
  if (result.deferred) return `deferred-until-${result.deferredTo || 'next-batch'}`;
  if (result.failed) return 'failed';
  if (result.completed) return 'completed';
  if (result.skipped) return 'skipped';
  if (result.rerouted) return `rerouted-to-step-${result.to ?? '?'} (${result.branch || '?'})`;
  if (result.advancedTo) return `advanced-to-step-${result.advancedTo} (${result.branch || '?'})`;
  if (result.waiting) return `waiting-until-${result.scheduled_for || '?'}`;
  return 'processed';
}

/**
 * Claim one due enrollment atomically, then process its current step. Every
 * enrollment is handled INDEPENDENTLY — one recipient's send/advance never
 * blocks or marks another as pending. Logs the full lifecycle for each row:
 * enrollment id, contact id, current step, next_run_at, due-ness, claim
 * outcome, send outcome, resulting status and resulting next_run_at.
 */
async function processDueEnrollmentLogged(enrollment, summary) {
  const nowMs = Date.now();
  const contactId = enrollment.contact_id;
  const stepId = enrollment.current_step_id || null;
  const stepNumber = enrollment.current_step ?? '?';
  const nextRunAt = enrollment.next_run_at;
  const due = nextRunAt ? new Date(nextRunAt).getTime() <= nowMs : true;

  log(`[DUE] enrollment=${enrollment.id} sequence=${enrollment.sequence_id} contact=${contactId} step=${stepId || 'null'}/#${stepNumber} next_run_at=${nextRunAt || 'null'} due=${due}`);
  log(`[SEQUENCE SEND] enrollment_id=${enrollment.id}`);
  log(`[SEQUENCE SEND] step_id=${stepId || 'null'}`);
  log(`[SEQUENCE SEND] next_run_at=${nextRunAt || 'null'}`);
  log(`[SEQUENCE SEND] database_now=${new Date().toISOString()}`);
  log(`[SEQUENCE SEND] is_due=${due}`);

  let claimed = false;
  try {
    claimed = await claimEnrollment(enrollment.id);
  } catch (error) {
    logErr(`[CLAIM_FAILED] enrollment=${enrollment.id} contact=${contactId} step=#${stepNumber} error=${error.message || String(error)}`);
  }
  log(`[CLAIM] enrollment=${enrollment.id} contact=${contactId} step=#${stepNumber} claimed=${claimed}`);
  if (!claimed) {
    summary.skipped++;
    return;
  }

  try {
    const result = await processEnrollmentChain(enrollment);
    let fresh = null;
    try {
      fresh = await reloadEnrollment(enrollment.id);
    } catch (error) {
      logErr(`[STATE_READ_FAILED] enrollment=${enrollment.id} error=${error.message || String(error)}`);
    }
    summary.processed++;
    log(`[DONE] enrollment=${enrollment.id} contact=${contactId} step=#${stepNumber} outcome=${outcomeLabel(result)} status=${(fresh && fresh.status) || 'unknown'} next_run_at=${(fresh && fresh.next_run_at) || 'null'}`);
  } catch (error) {
    summary.failed++;
    logErr(`[SEND_FAILED] enrollment=${enrollment.id} contact=${contactId} step=#${stepNumber} error=${error.message || String(error)}`);
  }
}

async function checkDueEnrollments(sequenceIdsOverride) {
  const summary = {
    revived: 0,
    repaired: 0,
    due: 0,
    processed: 0,
    failed: 0,
    skipped: 0
  };
  const start = Date.now();
  log('Checking due sequence enrollments');
  log(`[SEQUENCE WORKER] started`);
  log(`[SEQUENCE WORKER] database_now=${new Date().toISOString()}`);
  const sequenceIds = sequenceIdsOverride || await getActiveSequenceIds();
  summary.revived = await resumeCompletedEnrollments(sequenceIds);
  if (summary.revived > 0) {
    log(`Revived ${summary.revived} completed enrollment(s) that gained children — resuming`);
  }
  summary.repaired = await repairStaleImmediateEnrollments(sequenceIds);
  if (summary.repaired > 0) {
    log(`[SEQUENCE WORKER] repair — ${summary.repaired} immediate starting-step enrollment(s) made due now`);
  }

  // DRAIN LOOP — process EVERY due enrollment for this run, never a fixed
  // batch. getDueEnrollments() carries no limit and claimEnrollment() pushes
  // each claimed row's next_run_at atomically into the future, so a follow-up
  // query naturally skips rows this run already claimed. The loop only repeats
  // when NEW enrollments became due mid-run; it stops when nothing is due, no
  // progress was made, or the time budget is spent (the next cron tick picks
  // up whatever is left).
  const seenDue = new Set();
  const seenSequences = new Set();
  while (true) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    const due = await getDueEnrollments(sequenceIds);
    if (due.length === 0) break;
    log(`[SEQUENCE WORKER] due enrollments=${due.length}`);
    log(`Drain pass — ${due.length} due enrollment(s)`);
    let progress = 0;
    let passHandled = 0;
    for (const enrollment of due){
      if (Date.now() - start > TIME_BUDGET_MS) {
        log(`Time budget reached — ${due.length - passHandled} due enrollment(s) left for the next tick`);
        break;
      }
      if (!seenDue.has(enrollment.id)) {
        seenDue.add(enrollment.id);
        summary.due++;
      }
      seenSequences.add(enrollment.sequence_id);
      const before = summary.processed + summary.skipped;
      await processDueEnrollmentLogged(enrollment, summary);
      progress += summary.processed + summary.skipped - before;
      passHandled++;
      if (SEND_DELAY_MS > 0) {
        await new Promise((resolve)=>setTimeout(resolve, SEND_DELAY_MS));
      }
    }
    if (progress === 0) break;
  }

  await completeDrainedStepBatches([
    ...seenSequences
  ]);

  log(`Summary — due=${summary.due} processed=${summary.processed} revived=${summary.revived} repaired=${summary.repaired} skipped=${summary.skipped} failed=${summary.failed}`);
  if (sequenceIdsOverride) {
    for (const sid of sequenceIds)await logBranchSnapshot(sid);
  } else if (seenSequences.size > 0) {
    for (const sid of seenSequences)await logBranchSnapshot(sid);
  }
  return summary;
}
// ─── SMTP client + personalization + tracking (ported from scheduler) ──────
function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function stripHtml(html) {
  return String(html || '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function decodeHtmlEntities(html) {
  return String(html || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}
function hasHtmlTags(str) {
  return /<\s*(\/)?\s*[a-zA-Z][^>]*>/.test(String(str || ''));
}
function plainTextToHtml(text) {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/);
  const out = [];
  let openList = null;
  let paragraph = [];
  const closeList = ()=>{
    if (openList) {
      out.push(`</${openList}>`);
      openList = null;
    }
  };
  const emitParagraph = ()=>{
    if (paragraph.length) {
      closeList();
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  for (const raw of lines){
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
      out.push(`<li>${(bullet ? bullet[2] : number[2]).trim()}</li>`);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  emitParagraph();
  closeList();
  return out.join('\n');
}
function wrapHtmlDocument(html) {
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
    '</html>'
  ].join('\n');
}
function rewriteLinksForTracking(html, trackingId, baseUrl) {
  const clickUrl = (url)=>`${baseUrl}/click-tracker?tracking_id=${encodeURIComponent(trackingId)}&url=${encodeURIComponent(url)}`;
  const HREF_RE = /(\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)(["'])/gi;
  const TOKEN_RE = /(<[^>]*>)|(https?:\/\/[^\s<>"']+)/gi;
  return String(html || '').replace(TOKEN_RE, (match, tag, bareUrl)=>{
    if (tag) {
      return tag.replace(HREF_RE, (m, p, q, url, q2)=>{
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
/** Open pixel handled by the email-open-tracker Edge Function. */ function appendOpenPixel(html, emailLogId, contactEmail, trackingId) {
  const params = new URLSearchParams({
    action: 'track',
    email_log_id: emailLogId,
    contact_email: contactEmail,
    tracking_id: trackingId
  });
  const pixelUrl = `${EDGE_FUNCTION_BASE}/email-open-tracker?${params.toString()}`;
  const pixel = `<img src="${pixelUrl}" ` + `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}\n</body>`) : `${html}\n${pixel}`;
}
function b64EncodeBytes(bytes) {
  let bin = '';
  for(let i = 0; i < bytes.length; i++)bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64EncodeUtf8(text) {
  return b64EncodeBytes(new TextEncoder().encode(text));
}
function withTimeout(promise, ms) {
  return new Promise((resolve, reject)=>{
    const timer = setTimeout(()=>reject(new Error('SMTP operation timed out')), ms);
    promise.then((v)=>{
      clearTimeout(timer);
      resolve(v);
    }, (e)=>{
      clearTimeout(timer);
      reject(e);
    });
  });
}
function encodeHeader(value) {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${b64EncodeUtf8(value)}?=`;
}
class SmtpSession {
  conn;
  reader;
  buf = '';
  timeoutMs;
  constructor(timeoutMs){
    this.timeoutMs = timeoutMs;
  }
  async connect(hostname, port) {
    this.conn = await withTimeout(Deno.connectTls({
      hostname,
      port
    }), this.timeoutMs);
    this.reader = this.conn.readable.getReader();
    await this.readReply([
      220
    ]);
  }
  async readLine() {
    while(true){
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
  async readReply(expected) {
    let lastCode = 0;
    let text = '';
    while(true){
      const line = await this.readLine();
      lastCode = parseInt(line.slice(0, 3), 10);
      text = line.slice(4);
      if (line.length < 4 || line[3] !== '-') break;
    }
    if (!expected.includes(lastCode)) {
      throw new Error(`SMTP error ${lastCode}: ${text}`);
    }
  }
  async cmd(line) {
    await withTimeout(this.conn.write(new TextEncoder().encode(line + '\r\n')), this.timeoutMs);
  }
  async ehlo(domain) {
    await this.cmd(`EHLO ${domain}`);
    await this.readReply([
      250
    ]);
  }
  async authPlain(user, pass) {
    const payload = new Uint8Array(user.length + pass.length + 2);
    let i = 0;
    payload[i++] = 0;
    for(let j = 0; j < user.length; j++)payload[i++] = user.charCodeAt(j);
    payload[i++] = 0;
    for(let j = 0; j < pass.length; j++)payload[i++] = pass.charCodeAt(j);
    await this.cmd(`AUTH PLAIN ${b64EncodeBytes(payload)}`);
    await this.readReply([
      235
    ]);
  }
  async mailFrom(from) {
    await this.cmd(`MAIL FROM:<${from}>`);
    await this.readReply([
      250
    ]);
  }
  async rcptTo(to) {
    await this.cmd(`RCPT TO:<${to}>`);
    await this.readReply([
      250,
      251
    ]);
  }
  async data(lines) {
    await this.cmd('DATA');
    await this.readReply([
      354
    ]);
    for (const line of lines){
      await this.cmd(/^\./.test(line) ? '.' + line : line);
    }
    await this.cmd('.');
    await this.readReply([
      250
    ]);
  }
  async quit() {
    try {
      await this.cmd('QUIT');
    } catch  {}
    try {
      this.conn.close();
    } catch  {}
  }
}
/** Load the attachment metadata rows saved against ONE sequence step. */ async function loadStepAttachments(stepId) {
  const { data, error } = await supabase.from('sequence_step_attachments').select('*').eq('sequence_step_id', stepId).order('created_at', {
    ascending: true
  });
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
 */ async function downloadAttachment(att) {
  const bucket = String(att.storage_bucket || 'sequence-attachments');
  const path = String(att.storage_path || '');
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`Failed to download attachment "${att.file_name || path}" from Storage — bucket="${bucket}" path="${path}"${error ? `: ${error.message}` : ' (empty response)'}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  log(`[Sequence Attachment] Downloaded from Storage: ${bucket}/${path}`);
  return {
    file_name: att.file_name || 'attachment',
    file_type: att.file_type || 'application/octet-stream',
    data: bytes
  };
}
/**
 * Load every attachment record for the step and download all the files from
 * Storage, ready to embed in the MIME message. If any file cannot be downloaded
 * the send aborts with a clear error instead of mailing the step without its
 * attachment.
 */ async function loadAndDownloadStepAttachments(stepId) {
  const records = await loadStepAttachments(stepId);
  if (records.length === 0) {
    log(`[Sequence Attachment] Loading attachments for step ${stepId}: none found`);
    return [];
  }
  log(`[Sequence Attachment] Loading attachments for step ${stepId}: ${records.length} record(s)`);
  const mime = [];
  for (const att of records){
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
 */ async function resolveBranchStepId(sequenceId, step) {
  if (!step || step.step_number == null || !step.parent_branch) return null;
  const { data, error } = await supabase.from('sequence_branch_steps').select('id').eq('sequence_id', sequenceId).eq('step', Number(step.step_number)).eq('parent_branch', step.parent_branch).maybeSingle();
  if (error) return null;
  return data ? data.id : null;
}
/** Load the attachment metadata rows saved against ONE sequence branch step. */ async function loadBranchStepAttachments(branchStepId) {
  const { data, error } = await supabase.from('sequence_branch_step_attachments').select('*').eq('branch_step_id', branchStepId).order('created_at', {
    ascending: true
  });
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
 */ async function loadAndDownloadBranchStepAttachments(branchStepId) {
  const records = await loadBranchStepAttachments(branchStepId);
  if (records.length === 0) {
    log(`[Sequence Attachment] Loading attachments for branch step ${branchStepId}: none found`);
    return [];
  }
  log(`[Sequence Attachment] Loading attachments for branch step ${branchStepId}: ${records.length} record(s)`);
  const mime = [];
  for (const att of records){
    mime.push(await downloadAttachment(att));
  }
  log(`[Sequence Attachment] Sending ${mime.length} branch step attachment(s) with this step's email`);
  return mime;
}
/** Base64 in 76-char lines (RFC 2045) so long attachments wrap correctly. */ function b64Lines(bytes) {
  const b64 = b64EncodeBytes(bytes);
  const lines = [];
  for(let i = 0; i < b64.length; i += 76)lines.push(b64.slice(i, i + 76));
  return lines;
}
/** ASCII-safe filename for the MIME Content-Disposition / Content-Type name. */ function safeAttachmentName(value) {
  return String(value || 'file').replace(/[\r\n"]/g, '').replace(/[^\x20-\x7E]/g, '_').trim() || 'file';
}
function buildMimeMessage(opts) {
  const lines = [];
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
  for (const att of attachments){
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
async function sendSmtp(opts) {
  if (!SMTP_USER || !SMTP_PASSWORD) {
    throw new Error('SMTP_USER / SMTP_PASSWORD secrets are not configured');
  }
  if (SMTP_PORT !== 465) {
    throw new Error('Supabase Edge Functions only allow outbound SMTP on port 465 (implicit TLS)');
  }
  log(`SMTP config: host=${SMTP_HOST} port=${SMTP_PORT} user=${SMTP_USER} passwordSet=${Boolean(SMTP_PASSWORD)} tls=implicit(465)`);
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
    const lines = buildMimeMessage({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: SMTP_REPLY_TO,
      listUnsubscribe,
      messageId,
      attachments: opts.attachments
    });
    await session.data(lines);
    await session.quit();
    return {
      messageId
    };
  } catch (error) {
    try {
      session.quit();
    } catch  {}
    throw error;
  }
}
// ─── Main entry ────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  const start = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      status: 200,
      headers: corsHeaders
    });
  }
  const secret = req.headers.get('x-cron-secret') || '';
  const key = presentedKey(req);
  const isCron = Boolean(CRON_SECRET) && secret === CRON_SECRET;
  const isApp = !isCron && Boolean(key) && (ANON_KEYS.has(key) || isValidSupabaseJwt(key));
  if (!isCron && !isApp) {
    logErr('Unauthorized — missing/invalid x-cron-secret or project key');
    return jsonResponse(401, {
      success: false,
      error: 'Unauthorized'
    });
  }
  let onlyId = null;
  if (!isCron && req.method === 'POST') {
    try {
      const body = await req.json();
      if (body && body.sequenceId) onlyId = String(body.sequenceId);
    } catch  {
    // No/invalid body — run the full tick.
    }
  }
  try {
    const override = onlyId ? [
      onlyId
    ] : undefined;
    const summary = await checkDueEnrollments(override);
    log(`Done in ${Date.now() - start}ms — due=${summary.due} processed=${summary.processed} revived=${summary.revived} skipped=${summary.skipped} failed=${summary.failed}`);
    return jsonResponse(200, {
      success: true,
      ...summary
    });
  } catch (error) {
    logErr(`Sequence runner tick failed: ${error.message}`);
    return jsonResponse(500, {
      success: false,
      error: error.message
    });
  }
});
