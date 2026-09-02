/**
 * Sequence / Drip automation API — serverless edition.
 *
 * This client no longer talks to the local Express backend (localhost:5000).
 * Every sequence operation talks DIRECTLY to Supabase (the same anon-key
 * pattern the rest of the app already uses), and the two operations that need
 * server-side sending (SMTP) are delegated to Supabase Edge Functions:
 *
 *   - supabase.functions.invoke('sequence-runner')       → automatic worker
 *   - supabase.functions.invoke('sequence-manual-send')  → "Send Now"
 *
 * Logic (validation, audience resolution, branch eligibility, steps_progress,
 * engagement, overview) is ported 1:1 from
 * backend/services/sequenceService.js + backend/workers/sequenceWorker.js so
 * the response shapes the UI depends on are unchanged. Nothing is hardcoded on
 * the client — every count/label is read from the database.
 */
import { supabase } from '../supabase';
import type {
  AudienceOption,
  BranchStepInput,
  ManualSendResult,
  Sequence,
  SequenceBranchStep,
  SequenceEnrollment,
  SequenceInput,
  SequenceRecipientsResponse,
  SequenceStep,
  SequenceStepInput,
  SequenceStepLog,
  StepParentBranch,
} from '../types/sequence';

// ─── Tables ────────────────────────────────────────────────────────────────

const SEQUENCES_TABLE = 'sequences';
const STEPS_TABLE = 'sequence_steps';
const ENROLLMENTS_TABLE = 'sequence_enrollments';
const STEP_LOGS_TABLE = 'sequence_step_logs';
const BRANCH_STEPS_TABLE = 'sequence_branch_steps';
const CONTACTS_TABLE = 'contacts';

// ─── Domain constants (mirror backend/services/sequenceService.js) ─────────

const TRIGGER_TYPES = ['manual', 'time_based', 'behaviour'];
const RECIPIENT_TYPES = ['all', 'opened', 'not_opened'];
const SEND_MODES = ['automatic', 'manual', 'both'];
const SEND_ACTIONS = ['send_email', 'send_automatically', 'skip'];
const SEND_AFTER_UNITS = ['minutes', 'hours', 'days'];

const BRANCH_STARTING: StepParentBranch = 'STARTING';
const BRANCH_OPENED: StepParentBranch = 'OPENED';
const BRANCH_NOT_OPENED: StepParentBranch = 'NOT_OPENED';

const DEFAULT_WAIT_HOURS = 24;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_DELIVERABLE_EMAIL_RE =
  /(^__)|@example\.(com|org|net|edu)$|\.(test|invalid|localhost|local)$/i;

// ─── Error helpers ─────────────────────────────────────────────────────────

function toError(error: unknown, fallback: string): Error {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : fallback;
  const err = new Error(message);
  (err as any).status = 500;
  return err;
}

function badRequest(message: string): never {
  const err = new Error(message);
  (err as any).status = 400;
  throw err;
}

function notFound(kind: string, id: string): never {
  const err = new Error(`${kind} not found${id ? `: ${id}` : ''}`);
  (err as any).status = 404;
  throw err;
}

function conflict(message: string): never {
  const err = new Error(message);
  (err as any).status = 409;
  throw err;
}

function requireString(value: unknown, name: string): string {
  if (value === undefined || value === null || !String(value).trim()) {
    badRequest(`Missing required field: ${name}`);
  }
  return String(value).trim();
}

function enumValue(value: unknown, name: string, allowed: string[]): string | undefined {
  const v = value === undefined || value === null ? undefined : String(value).trim();
  if (v !== undefined && !allowed.includes(v)) {
    badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

// ─── Per-step batching config (shared config, per-step runtime queue) ───────
// One batch configuration is inherited by every step (sequences.batch_*). The
// runtime keeps a SEPARATE queue per step (sequence_step_batch_state) so each
// step schedules its own batches without blocking or being blocked by others.

const BATCH_SIZE_DEFAULT = 30;
const FIRST_BATCH_DELAY_DEFAULT = 0;
const SUBSEQUENT_BATCH_DELAY_DEFAULT = 1;

interface BatchConfig {
  batch_enabled: boolean;
  batch_size: number;
  first_batch_delay_hours: number;
  subsequent_batch_delay_hours: number;
}

function normalizeBatchConfig(payload: any): BatchConfig {
  const batchEnabled =
    payload && payload.batch_enabled !== undefined ? Boolean(payload.batch_enabled) : false;
  const batchSize =
    payload && payload.batch_size !== undefined ? Number(payload.batch_size) : BATCH_SIZE_DEFAULT;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    badRequest('batch_size must be an integer >= 1');
  }
  const firstDelay =
    payload && payload.first_batch_delay_hours !== undefined
      ? Number(payload.first_batch_delay_hours)
      : FIRST_BATCH_DELAY_DEFAULT;
  if (!Number.isFinite(firstDelay) || firstDelay < 0) {
    badRequest('first_batch_delay_hours must be a number >= 0');
  }
  const subsequentDelay =
    payload && payload.subsequent_batch_delay_hours !== undefined
      ? Number(payload.subsequent_batch_delay_hours)
      : SUBSEQUENT_BATCH_DELAY_DEFAULT;
  if (!Number.isFinite(subsequentDelay) || subsequentDelay < 0) {
    badRequest('subsequent_batch_delay_hours must be a number >= 0');
  }
  return {
    batch_enabled: batchEnabled,
    batch_size: batchSize,
    first_batch_delay_hours: firstDelay,
    subsequent_batch_delay_hours: subsequentDelay,
  };
}

/**
 * (Re)sync the per-step batch queue rows for every step of a sequence to the
 * SHARED sequence config. Best-effort: the sequence-runner also lazily creates
 * a step's row on first send, so a missed RPC here is never fatal. Creating the
 * rows at activation arms the first-batch delay (next_batch_at = now + delay);
 * a config refresh preserves any in-flight progress in the rows.
 */
async function syncSequenceBatchState(sequenceId: string): Promise<void> {
  try {
    const sequence = await getSequenceRow(sequenceId);
    const steps = await listSteps(sequenceId);
    for (const step of steps) {
      await supabase.rpc('create_sequence_batch_state', {
        p_sequence_id: sequenceId,
        p_sequence_step_id: step.id,
        p_batch_size: Number(sequence.batch_size) > 0 ? Number(sequence.batch_size) : BATCH_SIZE_DEFAULT,
        p_batch_enabled: !!sequence.batch_enabled,
        p_first_delay: Number(sequence.first_batch_delay_hours) || 0,
        p_subsequent_delay: Number(sequence.subsequent_batch_delay_hours) || SUBSEQUENT_BATCH_DELAY_DEFAULT,
      });
    }
  } catch (err) {
    console.warn('[sequenceApi] batch-state sync failed:', (err as Error).message);
  }
}

/** Load every step's batch state row for a sequence (for progress display). */
async function loadSequenceBatchStates(sequenceId: string): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  try {
    const { data, error } = await supabase
      .from('sequence_step_batch_state')
      .select('*')
      .eq('sequence_id', sequenceId);
    if (error) {
      console.warn('[sequenceApi] batch-state load failed:', error.message);
      return map;
    }
    for (const row of data || []) map.set(row.sequence_step_id, row);
  } catch (err) {
    console.warn('[sequenceApi] batch-state load failed:', (err as Error).message);
  }
  return map;
}

// ─── Step helpers ──────────────────────────────────────────────────────────

function normalizeBranch(value: unknown): StepParentBranch | null {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().toUpperCase();
  return v === BRANCH_OPENED || v === BRANCH_NOT_OPENED || v === BRANCH_STARTING
    ? (v as StepParentBranch)
    : null;
}

function waitHoursOf(step: any): number {
  const h = Number(step && step.wait_hours);
  return Number.isFinite(h) && h >= 0 ? h : DEFAULT_WAIT_HOURS;
}

function startingNodeOf(steps: any[]): any | null {
  return (steps || []).find((s) => s.parent_step_id === null) || (steps || [])[0] || null;
}

function childrenOf(steps: any[], stepId: string | null): any[] {
  return (steps || []).filter((s) => s.parent_step_id === stepId);
}

function isLinearFromSteps(steps: any[], childStep: any): boolean {
  if (!childStep || !childStep.parent_step_id) return false;
  const siblings = (steps || []).filter((s) => s.parent_step_id === childStep.parent_step_id);
  return siblings.length > 0 && siblings.every((s) => s.parent_branch === BRANCH_OPENED);
}

function nodeContentSubject(node: any): string | null {
  if (node && node.parent_branch === BRANCH_NOT_OPENED) {
    return node.increment_subject || node.normal_subject || null;
  }
  return node ? node.normal_subject || null : null;
}

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

function isDeliverableRecipientEmail(email: unknown): boolean {
  const value = String(email || '').trim();
  if (!value) return false;
  if (!EMAIL_REGEX.test(value)) return false;
  return !NON_DELIVERABLE_EMAIL_RE.test(value);
}

function dedupeContacts(contacts: any[]): any[] {
  const seenEmails = new Set<string>();
  const out: any[] = [];
  for (const contact of contacts || []) {
    if (!isDeliverableRecipientEmail(contact.email)) continue;
    const key = normalizeEmail(contact.email);
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    out.push(contact);
  }
  return out;
}

// ─── Audience resolution (port of supabaseService.resolveContactsForAudience) ─

async function resolveContactsForAudience(audienceSegment: unknown): Promise<any[]> {
  const segment = String(audienceSegment || '').trim();
  let query = supabase.from(CONTACTS_TABLE).select('*');
  if (segment && segment !== 'All Contacts') {
    // Filter by contact_type exactly matching the selected audience segment
    query = (query as any).eq('contact_type', segment);
  }
  const { data, error } = await query;
  if (error) throw toError(error, 'Failed to fetch contacts for audience');
  return data || [];
}

// ─── Branch eligibility (port of sequenceWorker.getBranchEligibility) ──────

interface EligibilityRow {
  eligible: boolean;
  branch: string;
  opened: boolean | null;
  opened_at: string | null;
  clicked: boolean | null;
  clicked_at: string | null;
  email_status: string | null;
  parentSentAt: string | null;
  parentEmailLogId: string | null;
  parent_skipped?: boolean;
  reason?: string;
}

async function getBranchEligibility(
  sequenceId: string,
  stepId: string,
  contactIds: string[]
): Promise<Map<string, EligibilityRow>> {
  const steps = await listSteps(sequenceId);
  const step = steps.find((s) => s.id === stepId) || null;
  const map = new Map<string, EligibilityRow>();
  if (!step || !contactIds || contactIds.length === 0) return map;

  if (!step.parent_step_id) {
    for (const id of contactIds) {
      map.set(id, {
        eligible: true,
        branch: 'starting',
        opened: null,
        email_status: null,
        opened_at: null,
        clicked: null,
        clicked_at: null,
        parentSentAt: null,
        parentEmailLogId: null,
      });
    }
    return map;
  }

  const { data: parentLogs, error } = await supabase
    .from(STEP_LOGS_TABLE)
    .select('contact_id, email_log_id, sent_at, status, opened, opened_at, clicked, clicked_at')
    .eq('sequence_id', sequenceId)
    .eq('sequence_step_id', step.parent_step_id)
    .in('contact_id', contactIds);
  if (error) throw toError(error, 'Failed to fetch parent step logs');

  const logByContact = new Map<string, any>((parentLogs || []).map((l) => [l.contact_id, l]));
  const emailLogIds = [
    ...new Set((parentLogs || []).map((l) => l.email_log_id).filter(Boolean)),
  ];
  const emailById = new Map<string, any>();
  if (emailLogIds.length > 0) {
    const { data: logs, error: logsError } = await supabase
      .from('email_logs')
      .select('id, status, opened, opened_at, clicked, clicked_at, sent_at')
      .in('id', emailLogIds);
    if (logsError) throw toError(logsError, 'Failed to fetch parent email logs');
    for (const log of logs || []) emailById.set(log.id, log);
  }

  const branch = step.parent_branch === BRANCH_NOT_OPENED ? 'not_opened' : 'opened';
  const linearChild = isLinearFromSteps(steps, step);
  for (const id of contactIds) {
    const parentLog = logByContact.get(id);
    if (!parentLog) {
      map.set(id, {
        eligible: false,
        branch: 'none',
        opened: null,
        email_status: null,
        opened_at: null,
        clicked: null,
        clicked_at: null,
        parentSentAt: null,
        parentEmailLogId: null,
        reason: 'parent_not_sent',
      });
      continue;
    }
    const emailLog = parentLog.email_log_id ? emailById.get(parentLog.email_log_id) || null : null;
    const sent = !!(emailLog ? emailLog.status === 'sent' : parentLog.status === 'sent');
    const opened = !!(emailLog ? emailLog.opened === true : parentLog.opened === true);
    const openedAt = (emailLog && emailLog.opened_at) || parentLog.opened_at || null;
    const clicked = !!(emailLog ? emailLog.clicked === true : parentLog.clicked === true);
    const clickedAt = (emailLog && emailLog.clicked_at) || parentLog.clicked_at || null;
    const parentSkipped = parentLog.status === 'skipped';
    const eligible =
      parentSkipped ||
      (branch === 'not_opened' ? sent && opened === false : opened === true) ||
      (!opened && sent && linearChild && branch === 'opened');
    map.set(id, {
      eligible,
      branch,
      opened,
      parent_skipped: parentSkipped,
      email_status: (emailLog && emailLog.status) || parentLog.status || 'sent',
      opened_at: openedAt,
      clicked,
      clicked_at: clickedAt,
      parentSentAt: parentLog.sent_at || (emailLog && emailLog.sent_at) || null,
      parentEmailLogId: parentLog.email_log_id || null,
    });
  }
  return map;
}

// ─── Shared row fetchers ───────────────────────────────────────────────────

async function getSequenceRow(id: string): Promise<any> {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence');
  if (!data) notFound('Sequence', id);
  return data;
}

async function sequenceExists(id: string): Promise<any> {
  const { data, error } = await supabase
    .from(SEQUENCES_TABLE)
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch sequence');
  if (!data) notFound('Sequence', id);
  return data;
}

async function stepBelongsToSequence(sequenceId: string, stepId: string): Promise<any> {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('id', stepId)
    .eq('sequence_id', sequenceId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch step');
  if (!data) notFound('Step', stepId);
  return data;
}

async function assertParentStepExists(sequenceId: string, parentStepId: string): Promise<void> {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('id')
    .eq('sequence_id', sequenceId)
    .eq('id', parentStepId)
    .is('archived_at', null)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to validate parent step');
  if (!data) badRequest('Parent step does not exist in this sequence');
}

async function listSteps(sequenceId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('sequence_id', sequenceId)
    .is('archived_at', null)
    .order('step_number', { ascending: true });
  if (error) throw toError(error, 'Failed to fetch sequence steps');
  return data || [];
}

// ─── sequence_branch_steps mirror helpers (port of sequenceService) ────────

async function branchStepRowForNode(sequenceId: string, node: any): Promise<any> {
  let parentStep: number | null = null;
  let parentStepId: number | null = null;
  if (node && node.parent_step_id) {
    const { data: parent } = await supabase
      .from(STEPS_TABLE)
      .select('step_number, parent_branch')
      .eq('id', node.parent_step_id)
      .eq('sequence_id', sequenceId)
      .maybeSingle();
    if (parent && parent.step_number != null) {
      parentStep = Number(parent.step_number);
      if (parent.parent_branch) {
        const { data: parentMirror } = await supabase
          .from(BRANCH_STEPS_TABLE)
          .select('id')
          .eq('sequence_id', sequenceId)
          .eq('step', Number(parent.step_number))
          .eq('parent_branch', parent.parent_branch)
          .maybeSingle();
        if (parentMirror) parentStepId = parentMirror.id;
      }
    }
  }
  const isNotOpened = node && node.parent_branch === BRANCH_NOT_OPENED;
  return {
    sequence_id: sequenceId,
    step: node && node.step_number != null ? Number(node.step_number) : null,
    parent_step: parentStep,
    parent_step_id: parentStepId,
    parent_branch: node ? node.parent_branch : null,
    subject: (isNotOpened ? node.increment_subject || '' : node.normal_subject || '') || '',
    body: (isNotOpened ? node.increment_body || '' : node.normal_body || '') || '',
    wait_hours: node && node.wait_hours != null ? Number(node.wait_hours) : 0,
    send_action: (node && node.send_action) || 'send_automatically',
    send_after_value: node && node.send_after_value != null ? Number(node.send_after_value) : null,
    send_after_unit: (node && node.send_after_unit) || null,
  };
}

async function syncBranchStepForNode(sequenceId: string, node: any, includeEmpty = false): Promise<void> {
  try {
    const row = await branchStepRowForNode(sequenceId, node);
    if (row.step == null || !row.parent_branch) return;
    if (!includeEmpty && (!row.subject || !row.body)) return;
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('id')
      .eq('sequence_id', row.sequence_id)
      .eq('step', row.step)
      .eq('parent_branch', row.parent_branch)
      .maybeSingle();
    if (existing) {
      await supabase
        .from(BRANCH_STEPS_TABLE)
        .update({
          parent_step: row.parent_step,
          parent_step_id: row.parent_step_id,
          subject: row.subject,
          body: row.body,
          wait_hours: row.wait_hours,
          send_action: row.send_action,
          send_after_value: row.send_after_value,
          send_after_unit: row.send_after_unit,
          updated_at: now,
        })
        .eq('id', existing.id);
    } else {
      await supabase.from(BRANCH_STEPS_TABLE).insert({ ...row, created_at: now, updated_at: now });
    }
  } catch (err) {
    console.warn('[BranchSteps] sync failed:', (err as Error).message);
  }
}

async function removeBranchStepsForNodes(sequenceId: string, nodes: any[]): Promise<void> {
  for (const node of nodes || []) {
    if (!node || node.step_number == null || !node.parent_branch) continue;
    await supabase
      .from(BRANCH_STEPS_TABLE)
      .delete()
      .eq('sequence_id', sequenceId)
      .eq('step', Number(node.step_number))
      .eq('parent_branch', node.parent_branch);
  }
}

async function branchStepBelongsToSequence(sequenceId: string, branchStepId: number): Promise<any> {
  const { data, error } = await supabase
    .from(BRANCH_STEPS_TABLE)
    .select('*')
    .eq('id', branchStepId)
    .eq('sequence_id', sequenceId)
    .maybeSingle();
  if (error) throw toError(error, 'Failed to fetch branch step');
  if (!data) notFound('Branch step', String(branchStepId));
  return data;
}

/** Write a sequence_branch_steps edit through to its canonical sequence_steps node. */
async function syncSequenceStepFromBranchStep(
  sequenceId: string,
  before: any,
  after: any
): Promise<void> {
  if (!after || after.step == null || !after.parent_branch) return;
  if (before && before.parent_branch !== after.parent_branch) return;

  const { data: node, error } = await supabase
    .from(STEPS_TABLE)
    .select('*')
    .eq('sequence_id', sequenceId)
    .eq('step_number', Number(after.step))
    .eq('parent_branch', after.parent_branch)
    .is('archived_at', null)
    .maybeSingle();
  if (error || !node) {
    console.warn(
      `[BranchSteps] write-through skipped: no sequence_steps node for step=${after.step} branch=${after.parent_branch} (${(error && error.message) || 'not found'})`
    );
    return;
  }

  const updates: any = {
    wait_hours: after.wait_hours != null ? Number(after.wait_hours) : Number(node.wait_hours),
    updated_at: new Date().toISOString(),
  };
  if (after.parent_branch === BRANCH_NOT_OPENED) {
    updates.increment_subject = after.subject;
    updates.increment_body = after.body;
  } else {
    updates.normal_subject = after.subject;
    updates.normal_body = after.body;
  }

  const { data: updatedNode, error: updateError } = await supabase
    .from(STEPS_TABLE)
    .update(updates)
    .eq('id', node.id)
    .select('*')
    .single();
  if (updateError) {
    console.warn('[BranchSteps] write-through update failed:', updateError.message);
    return;
  }
  await syncBranchStepForNode(sequenceId, updatedNode);
}

// ─── sequences.subject_N / body_N content columns (legacy wide projection) ──
//
// The `sequences` row carries per-step content columns (subject_1/body_1,
// subject_2/body_2, subject_2a/body_2a, … subject_11a/body_11a). The canonical
// content lives in sequence_steps (normal_* for STARTING/OPENED nodes,
// increment_* for NOT_OPENED nodes); these helpers project that tree onto the
// flat columns so the `sequences` row can never drift from the builder:
//   STARTING / OPENED node at step_number N  -> subject_N  / body_N
//   NOT_OPENED node at step_number N         -> subject_Na / body_Na
// The projection runs after every step/branch mutation AND self-heals on read.

/** Build the subject_N/body_N content-column payload from canonical steps. */
function contentColumnsFromSteps(steps: any[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const node of steps || []) {
    if (!node || node.archived_at) continue;
    const n = Number(node.step_number);
    if (!Number.isInteger(n) || n < 1 || n > 12) continue;
    if (node.parent_branch === BRANCH_NOT_OPENED) {
      out[`subject_${n}a`] = node.increment_subject || null;
      out[`body_${n}a`] = node.increment_body || null;
    } else {
      out[`subject_${n}`] = node.normal_subject || null;
      out[`body_${n}`] = node.normal_body || null;
    }
  }
  return out;
}

/** Recompute the sequences content columns from the canonical step tree. */
async function syncSequenceContentColumns(sequenceId: string): Promise<void> {
  try {
    const [{ data: steps, error: stepsError }, { data: branches }, { data: current }] =
      await Promise.all([
        supabase
          .from(STEPS_TABLE)
          .select('*')
          .eq('sequence_id', sequenceId)
          .is('archived_at', null),
        supabase.from(BRANCH_STEPS_TABLE).select('*').eq('sequence_id', sequenceId),
        supabase.from(SEQUENCES_TABLE).select('*').eq('id', sequenceId).maybeSingle(),
      ]);
    if (stepsError) {
      console.warn('[SequenceContent] load failed:', stepsError.message);
      return;
    }

    const computed = contentColumnsFromSteps(steps || []);

    // Fill gaps from the branch table (the builder's edit source): when no
    // sequence_steps node carries content for a step + branch but the flat
    // branch row does, project it so the legacy wide columns never drift from
    // what the Builder/Sequence pages actually display.
    for (const b of branches || []) {
      const n = Number(b.step);
      if (!Number.isInteger(n) || n < 1 || n > 12) continue;
      const isNotOpened = b.parent_branch === BRANCH_NOT_OPENED;
      const subjCol = isNotOpened ? `subject_${n}a` : `subject_${n}`;
      const bodyCol = isNotOpened ? `body_${n}a` : `body_${n}`;
      if (!computed[subjCol] && b.subject) computed[subjCol] = b.subject;
      if (!computed[bodyCol] && b.body) computed[bodyCol] = b.body;
    }

    // Never blindly wipe existing non-null content columns: canonical content
    // wins, gaps keep whatever was already stored in the row (or stay null).
    const merged: Record<string, string | null> = {};
    for (const key of Object.keys(computed)) {
      const value = computed[key];
      if (value) merged[key] = value;
      else if (current && current[key]) merged[key] = current[key];
      else merged[key] = null;
    }

    const { error: upErr } = await supabase
      .from(SEQUENCES_TABLE)
      .update({ ...merged, updated_at: new Date().toISOString() })
      .eq('id', sequenceId);
    if (upErr) console.warn('[SequenceContent] sync failed:', upErr.message);
  } catch (err) {
    console.warn('[SequenceContent] sync failed:', (err as Error).message);
  }
}

// ─── Sequences ─────────────────────────────────────────────────────────────

/** Sequence list with steps_count (mirror of GET /api/sequences). */
export function fetchSequences(): Promise<Sequence[]> {
  return (async () => {
    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw toError(error, 'Failed to list sequences');
    const sequences = data || [];
    const ids = sequences.map((s: any) => s.id);
    const stepCounts: Record<string, number> = {};
    if (ids.length > 0) {
      const { data: steps, error: sError } = await supabase
        .from(STEPS_TABLE)
        .select('sequence_id')
        .is('archived_at', null);
      if (!sError) {
        for (const st of steps || []) {
          stepCounts[st.sequence_id] = (stepCounts[st.sequence_id] || 0) + 1;
        }
      }
    }
    for (const s of sequences as any[]) {
      void syncSequenceContentColumns(s.id);
    }
    return sequences.map((s: any) => ({
      ...s,
      steps_count: stepCounts[s.id] || 0,
    })) as Sequence[];
  })();
}

/** Sequence detail + ordered steps + engagement/overview (mirror of GET /api/sequences/:id). */
export function fetchSequence(id: string): Promise<Sequence> {
  return (async () => {
    const sequence = await getSequenceRow(id);
    void syncSequenceContentColumns(id);

    const { data: steps, error: stepsError } = await supabase
      .from(STEPS_TABLE)
      .select('*')
      .eq('sequence_id', id)
      .is('archived_at', null)
      .order('step_number', { ascending: true });
    if (stepsError) throw toError(stepsError, 'Failed to fetch sequence steps');
    const stepsList = steps || [];

    const [engagement, audience, enrollments, stepLogs] = await Promise.all([
      sequenceEngagement(id),
      resolveSequenceAudience(sequence),
      supabase
        .from(ENROLLMENTS_TABLE)
        .select('status, contact_id, current_step, current_step_id, current_email_type, next_run_at')
        .eq('sequence_id', id),
      supabase
        .from(STEP_LOGS_TABLE)
        .select('sequence_step_id, contact_id, email_log_id, opened, clicked, status, sent_at')
        .eq('sequence_id', id),
    ]);
    if (enrollments.error) throw toError(enrollments.error, 'Failed to load sequence enrollments');
    if (stepLogs.error) throw toError(stepLogs.error, 'Failed to load sequence step logs');

    const enrollmentRows = enrollments.data || [];

    // Scheduling state — read from the SAME data the sequence runner uses:
    //   next_run_at  -> earliest future due time across active enrollments
    //   active_count -> enrollments still waiting to be / being processed
    //   last_sent_at -> most recent email actually sent (step log status 'sent')
    let activeCount = 0;
    let nextRunAt: string | null = null;
    for (const enrollment of enrollmentRows) {
      if (enrollment.status !== 'active') continue;
      activeCount += 1;
      if (
        enrollment.next_run_at &&
        (!nextRunAt ||
          new Date(enrollment.next_run_at).getTime() < new Date(nextRunAt).getTime())
      ) {
        nextRunAt = enrollment.next_run_at;
      }
    }

    const summary = {
      total_eligible: audience.length,
      total: enrollmentRows.length,
      in_progress: 0,
      completed: 0,
      pending: 0,
      failed: 0,
    };
    for (const enrollment of enrollmentRows) {
      if (enrollment.status === 'completed') summary.completed += 1;
      else summary.in_progress += 1;
    }
    summary.pending = Math.max(0, summary.total_eligible - summary.total);

    const stepLogRows = stepLogs.data || [];

    // Latest email actually sent for this sequence (from the real step logs).
    let lastSentAt: string | null = null;
    for (const log of stepLogRows) {
      if (!log || log.status !== 'sent' || !log.sent_at) continue;
      if (!lastSentAt || new Date(log.sent_at).getTime() > new Date(lastSentAt).getTime()) {
        lastSentAt = log.sent_at;
      }
    }

    const emailLogIds = [...new Set(stepLogRows.map((l: any) => l.email_log_id).filter(Boolean))];
    const emailLogsById = new Map<string, any>();
    if (emailLogIds.length > 0) {
      const { data: logs, error: logsError } = await supabase
        .from('email_logs')
        .select('id, status, opened, opened_at, clicked, clicked_at')
        .in('id', emailLogIds);
      if (logsError) throw toError(logsError, 'Failed to load sequence email logs');
      for (const log of logs || []) emailLogsById.set(log.id, log);
    }

    const failedContactIds = new Set<string>();
    for (const log of stepLogRows) {
      if (!log || !log.contact_id) continue;
      const emailLog = log.email_log_id ? emailLogsById.get(log.email_log_id) : null;
      const failed = emailLog ? emailLog.status === 'failed' : log.status === 'failed';
      if (failed) failedContactIds.add(log.contact_id);
    }
    summary.failed = failedContactIds.size;

    const enrolledContactIds = [...new Set(enrollmentRows.map((e: any) => e.contact_id))];
    const nextByNode = await buildNextEmails(id, stepsList);
    const batchStates = await loadSequenceBatchStates(id);
    const sequenceBatchEnabled = !!sequence.batch_enabled;

    const steps_progress: any[] = [];
    for (const node of stepsList) {
      const nodeLogs = stepLogRows.filter((log: any) => log.sequence_step_id === node.id);
      const eligMap = await getBranchEligibility(id, node.id, enrolledContactIds);
      const eligibleIds = new Set<string>();
      for (const contactId of enrolledContactIds) {
        const row = eligMap.get(contactId);
        if (row && row.eligible) eligibleIds.add(contactId);
      }
      for (const log of nodeLogs) {
        if (log && log.contact_id) eligibleIds.add(log.contact_id);
      }
      const eligible = eligibleIds.size;

      const path = node.parent_branch || BRANCH_STARTING;
      const pathLabel =
        path === BRANCH_NOT_OPENED ? 'Not Opened' : path === BRANCH_OPENED ? 'Opened' : 'Starting';
      const parent = node.parent_step_id
        ? stepsList.find((s) => s.id === node.parent_step_id) || null
        : null;
      const parentLabel = parent
        ? `Step ${parent.step_number}${parent.parent_branch === BRANCH_NOT_OPENED ? 'A' : ''} — ${path === BRANCH_NOT_OPENED ? 'Not Opened' : 'Opened'}`
        : 'Starting Step';

      let sent = 0;
      let opened = 0;
      let clicked = 0;
      let failed = 0;
      for (const log of nodeLogs) {
        const emailLog = log.email_log_id ? emailLogsById.get(log.email_log_id) : null;
        const sentOk = emailLog ? emailLog.status === 'sent' : log.status === 'sent';
        const failedLog = emailLog ? emailLog.status === 'failed' : log.status === 'failed';
        if (failedLog) {
          failed += 1;
          continue;
        }
        if (!sentOk) continue;
        sent += 1;
        if (emailLog ? emailLog.opened === true : log.opened === true) opened += 1;
        if (emailLog ? emailLog.clicked === true : log.clicked === true) clicked += 1;
      }

      const waitHours = waitHoursOf(node);
      let status: 'not_started' | 'in_progress' | 'completed' = 'not_started';
      if (sent > 0 && eligible > 0 && sent >= eligible) status = 'completed';
      else if (sent > 0) status = 'in_progress';
      else if (eligible > 0 && waitHours > 0) status = 'in_progress';

      const next = nextByNode.get(node.id) || [];
      const batch = batchStates.get(node.id) || null;
      const batchEnabledForStep = sequenceBatchEnabled && !!batch && !!batch.batch_enabled;

      steps_progress.push({
        step: node,
        subject: nodeContentSubject(node),
        path,
        path_label: pathLabel,
        parent_label: parentLabel,
        wait_hours: waitHours,
        wait_label: waitHours === 0 ? 'Immediate' : `${waitHours}h`,
        enrolled: enrollmentRows.length,
        eligible,
        sent,
        opened,
        clicked,
        failed,
        pending: Math.max(0, eligible - sent),
        status,
        next,
        batch_enabled: batchEnabledForStep,
        current_batch_number: batch ? Number(batch.current_batch_number) || 0 : 0,
        batch_sent: batch ? Number(batch.batch_sent) || 0 : 0,
        batch_size: batch && Number(batch.batch_size) > 0 ? Number(batch.batch_size) : undefined,
        next_batch_at: batch && batch.next_batch_at ? batch.next_batch_at : null,
        batch_completed_at: batch && batch.completed_at ? batch.completed_at : null,
      });
    }

    return {
      ...sequence,
      engagement,
      summary,
      steps_progress,
      steps: stepsList,
      next_run_at: nextRunAt,
      active_count: activeCount,
      last_sent_at: lastSentAt,
    } as Sequence;
  })();
}

/** Create a sequence (always starts as a draft). */
export function createSequence(payload: SequenceInput): Promise<Sequence> {
  return (async () => {
    const name = requireString(payload && payload.name, 'name');
    const audienceSegment = requireString(payload && payload.audience_segment, 'audience_segment');
    const triggerType = payload && payload.trigger_type ? String(payload.trigger_type).trim() : 'behaviour';
    if (!TRIGGER_TYPES.includes(triggerType)) {
      badRequest(`trigger_type must be one of: ${TRIGGER_TYPES.join(', ')}`);
    }
    const recipientType = enumValue(payload && payload.recipient_type, 'recipient_type', RECIPIENT_TYPES) || 'all';
    const sendMode = enumValue(payload && payload.send_mode, 'send_mode', SEND_MODES) || 'both';
    const batch = normalizeBatchConfig(payload || {});
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .insert({
        name,
        audience_segment: audienceSegment,
        trigger_type: triggerType,
        recipient_type: recipientType,
        send_mode: sendMode,
        batch_enabled: batch.batch_enabled,
        batch_size: batch.batch_size,
        first_batch_delay_hours: batch.first_batch_delay_hours,
        subsequent_batch_delay_hours: batch.subsequent_batch_delay_hours,
        status: 'draft',
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to create sequence');
    if (data && data.id) await syncSequenceContentColumns(data.id);
    return data as Sequence;
  })();
}

/** Update sequence configuration. */
export function updateSequence(id: string, payload: Partial<SequenceInput>): Promise<Sequence> {
  return (async () => {
    await getSequenceRow(id);
    const updates: any = { updated_at: new Date().toISOString() };
    const incoming = payload as any;

    if (incoming && incoming.name !== undefined) updates.name = requireString(incoming.name, 'name');
    if (incoming && incoming.audience_segment !== undefined) {
      updates.audience_segment = requireString(incoming.audience_segment, 'audience_segment');
    }
    if (incoming && incoming.trigger_type !== undefined) {
      const triggerType = String(incoming.trigger_type).trim();
      if (!TRIGGER_TYPES.includes(triggerType)) {
        badRequest(`trigger_type must be one of: ${TRIGGER_TYPES.join(', ')}`);
      }
      updates.trigger_type = triggerType;
    }
    if (incoming && incoming.recipient_type !== undefined) {
      updates.recipient_type = enumValue(incoming.recipient_type, 'recipient_type', RECIPIENT_TYPES);
    }
    if (incoming && incoming.send_mode !== undefined) {
      updates.send_mode = enumValue(incoming.send_mode, 'send_mode', SEND_MODES);
    }
    const touchesBatch =
      incoming &&
      (incoming.batch_enabled !== undefined ||
        incoming.batch_size !== undefined ||
        incoming.first_batch_delay_hours !== undefined ||
        incoming.subsequent_batch_delay_hours !== undefined);
    if (touchesBatch) {
      const batch = normalizeBatchConfig(incoming);
      updates.batch_enabled = batch.batch_enabled;
      updates.batch_size = batch.batch_size;
      updates.first_batch_delay_hours = batch.first_batch_delay_hours;
      updates.subsequent_batch_delay_hours = batch.subsequent_batch_delay_hours;
    }

    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to update sequence');
    if (touchesBatch) await syncSequenceBatchState(id);
    if (data && data.id) await syncSequenceContentColumns(data.id);
    return data as Sequence;
  })();
}

/** Delete a sequence (steps cascade via FK). Sequences are independent of
 *  campaigns — no linked campaign row is created or deleted. */
export function deleteSequence(id: string): Promise<void> {
  return (async () => {
    await getSequenceRow(id);
    await supabase.from(BRANCH_STEPS_TABLE).delete().eq('sequence_id', id);
    const { error } = await supabase.from(SEQUENCES_TABLE).delete().eq('id', id);
    if (error) throw toError(error, 'Failed to delete sequence');
  })();
}

// ─── Selector data (from the database) ─────────────────────────────────────

/**
 * Target-audience options — sourced EXCLUSIVELY from the Contacts table.
 *
 * The Contacts table is the single source of truth for who a sequence can
 * target. Every sequence's `audience_segment` is resolved at enrollment time
 * against `contacts.contact_type` (see resolveContactsForAudience), so the
 * dropdown MUST list the unique, real `contact_type` values that actually
 * exist in the contacts table — NOT `company_category`, campaign segments, or
 * the `contact_types` reference table (those values never match the
 * `contact_type` column and would enroll zero contacts).
 *
 * Because the list is derived straight from the live column, adding a new
 * contact type in Contacts makes it appear here automatically — nothing is
 * hardcoded.
 */
export function fetchAudienceOptions(): Promise<AudienceOption[]> {
  return (async () => {
    const audiences = new Map<string, AudienceOption>();
    const add = (value: unknown) => {
      const v = String(value || '').trim();
      if (v && !audiences.has(v)) audiences.set(v, { id: v, label: v });
    };
    // "All Contacts" is a meta-audience (enroll everyone); the real, per-type
    // audiences are appended below from the contacts table.
    add('All Contacts');

    const { data: contactTypes, error } = await supabase
      .from(CONTACTS_TABLE)
      .select('contact_type')
      .not('contact_type', 'is', null)
      .neq('contact_type', '');
    if (error) throw toError(error, 'Failed to load audiences from contacts');
    if (contactTypes) for (const row of contactTypes) add(row.contact_type);

    return [...audiences.values()];
  })();
}

/**
 * Count the contacts that would be enrolled for a given target audience.
 * Mirrors the same filter used by resolveContactsForAudience / activateSequence
 * so the UI preview and the actual enrollment always agree.
 *
 *  - 'All Contacts' (or empty) → every contact in the table.
 *  - any other value        → contacts whose `contact_type` equals it.
 */
export function countContactsForAudience(audienceSegment: string): Promise<number> {
  return (async () => {
    const segment = String(audienceSegment || '').trim();
    let query = supabase
      .from(CONTACTS_TABLE)
      .select('id', { count: 'exact', head: true });
    if (segment && segment !== 'All Contacts') {
      query = (query as any).eq('contact_type', segment);
    }
    const { count, error } = await query;
    if (error) throw toError(error, 'Failed to count contacts for audience');
    return count || 0;
  })();
}

/** Flat branch-tree rows (sequence_branch_steps) for one sequence. */
export function fetchBranchSteps(sequenceId: string): Promise<SequenceBranchStep[]> {
  return (async () => {
    await sequenceExists(sequenceId);
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('*')
      .eq('sequence_id', sequenceId)
      .order('step', { ascending: true })
      .order('parent_branch', { ascending: true });
    if (error) throw toError(error, 'Failed to list branch steps');
    return (data || []) as SequenceBranchStep[];
  })();
}

/** Update a branch-step row's editable fields + write through to sequence_steps. */
export function updateBranchStep(
  sequenceId: string,
  branchStepId: number,
  payload: BranchStepInput
): Promise<SequenceBranchStep> {
  return (async () => {
    const existing = await branchStepBelongsToSequence(sequenceId, branchStepId);
    const updates: any = { updated_at: new Date().toISOString() };

    const parentStep =
      payload && payload.parent_step !== undefined ? payload.parent_step : existing.parent_step;
    if (parentStep === null || parentStep === '') updates.parent_step = null;
    else {
      const p = Number(parentStep);
      if (!Number.isFinite(p) || p < 1 || !Number.isInteger(p)) {
        badRequest('parent_step must be a positive integer or null');
      }
      updates.parent_step = p;
    }

    if (payload && payload.parent_branch !== undefined) {
      const branch = String(payload.parent_branch).trim().toUpperCase();
      const allowedBranches: string[] = [BRANCH_STARTING, BRANCH_OPENED, BRANCH_NOT_OPENED];
      if (!allowedBranches.includes(branch)) {
        badRequest('parent_branch must be STARTING, OPENED, or NOT_OPENED');
      }
      updates.parent_branch = branch as StepParentBranch;
    }

    if (payload && payload.wait_hours !== undefined) {
      const w = Number(payload.wait_hours);
      if (!Number.isFinite(w) || w < 0 || !Number.isInteger(w)) {
        badRequest('wait_hours must be an integer >= 0');
      }
      updates.wait_hours = w;
    }
    if (payload && payload.subject !== undefined) {
      const subject = String(payload.subject).trim();
      if (!subject) badRequest('subject cannot be empty');
      updates.subject = subject;
    }
    if (payload && payload.body !== undefined) {
      const body = String(payload.body).trim();
      if (!body) badRequest('body cannot be empty');
      updates.body = body;
    }

    const { data: updated, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .update(updates)
      .eq('id', branchStepId)
      .eq('sequence_id', sequenceId)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to update branch step');

    await syncSequenceStepFromBranchStep(sequenceId, existing, updated);
    await syncSequenceContentColumns(sequenceId);
    return updated as SequenceBranchStep;
  })();
}

/** Delete a branch-step row (scoped to its sequence). */
export function deleteBranchStep(
  sequenceId: string,
  branchStepId: number
): Promise<{ deleted: boolean; id: number }> {
  return (async () => {
    await branchStepBelongsToSequence(sequenceId, branchStepId);
    const { error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .delete()
      .eq('id', branchStepId)
      .eq('sequence_id', sequenceId);
    if (error) throw toError(error, 'Failed to delete branch step');
    await syncSequenceContentColumns(sequenceId);
    return { deleted: true, id: branchStepId };
  })();
}

// ─── Step validation + CRUD ────────────────────────────────────────────────

function validateStepData(data: any) {
  const optional = (value: unknown): string | null =>
    value !== undefined && value !== null && String(value).trim()
      ? String(value).trim()
      : null;

  const sendAction =
    enumValue(data && data.send_action, 'send_action', SEND_ACTIONS) || 'send_automatically';
  const normalSubject = optional(data && data.normal_subject) || '';
  const normalBody = optional(data && data.normal_body) || '';
  const incrementSubject = optional(data && data.increment_subject);
  const incrementBody = optional(data && data.increment_body);
  if (!normalSubject && !incrementSubject && sendAction !== 'skip') {
    badRequest('normal_subject or increment_subject is required (unless this step is skipped)');
  }

  const waitHours = Number(data && data.wait_hours);
  if (!Number.isInteger(waitHours) || waitHours < 0) {
    badRequest('wait_hours must be an integer >= 0');
  }

  let sendAfterValue: number | null = null;
  if (
    data &&
    data.send_after_value !== undefined &&
    data.send_after_value !== null &&
    data.send_after_value !== ''
  ) {
    const raw = Number(data.send_after_value);
    if (!Number.isFinite(raw) || raw < 0) {
      badRequest('send_after_value must be a number >= 0');
    }
    sendAfterValue = Math.floor(raw);
  }
  let sendAfterUnit =
    (data && data.send_after_unit !== undefined && data.send_after_unit !== null
      ? enumValue(data.send_after_unit, 'send_after_unit', SEND_AFTER_UNITS)
      : null) || null;
  if (sendAfterValue != null && sendAfterValue > 0 && !sendAfterUnit) {
    sendAfterUnit = null;
  }

  const recipientType =
    enumValue(data && data.recipient_type, 'recipient_type', RECIPIENT_TYPES) || 'all';

  let parentStepId =
    data && data.parent_step_id !== undefined && data.parent_step_id !== null
      ? String(data.parent_step_id).trim()
      : null;
  let branch = normalizeBranch(data && data.parent_branch);
  if (!parentStepId && data && data.parent_path !== undefined && data.parent_path !== null) {
    parentStepId = String(data.parent_path).trim();
  }
  if (!branch && data && data.branch_type !== undefined && data.branch_type !== null) {
    branch = normalizeBranch(data.branch_type);
  }

  if (parentStepId) {
    if (branch !== BRANCH_OPENED && branch !== BRANCH_NOT_OPENED) {
      badRequest('parent_branch must be OPENED or NOT_OPENED when parent_step_id is set');
    }
  } else if (branch && branch !== BRANCH_STARTING) {
    badRequest('parent_step_id is required when parent_branch is set');
  }

  const parentFields = {
    parent_step_id: parentStepId,
    parent_branch: parentStepId ? branch : BRANCH_STARTING,
  };

  return {
    normal_subject: normalSubject,
    normal_body: normalBody,
    increment_subject: incrementSubject,
    increment_body: incrementBody,
    from_name: optional(data && data.from_name),
    wait_hours: waitHours,
    recipient_type: recipientType,
    send_action: sendAction,
    send_after_value: sendAfterValue,
    send_after_unit: sendAfterUnit,
    ...parentFields,
  };
}

async function runWorkerNow(sequenceId: string): Promise<void> {
  try {
    await supabase.functions.invoke('sequence-runner', {
      body: { sequenceId },
    });
  } catch (err) {
    console.warn('[sequenceApi] sequence-runner invoke failed (cron will pick it up):', (err as Error).message);
  }
}

/** Add a step (auto-numbered when omitted). */
export function createStep(sequenceId: string, payload: SequenceStepInput): Promise<SequenceStep> {
  return (async () => {
    await sequenceExists(sequenceId);
    const step = validateStepData(payload);
    if (step.parent_step_id) {
      await assertParentStepExists(sequenceId, step.parent_step_id);
    }

    let stepNumber = payload && payload.step_number;
    if (stepNumber === undefined || stepNumber === null) {
      const { data: maxRow } = await supabase
        .from(STEPS_TABLE)
        .select('step_number')
        .eq('sequence_id', sequenceId)
        .is('archived_at', null)
        .order('step_number', { ascending: false })
        .limit(1);
      stepNumber = (maxRow && maxRow[0] ? Number(maxRow[0].step_number) : 0) + 1;
    } else {
      stepNumber = Number(stepNumber);
      if (!Number.isInteger(stepNumber) || stepNumber < 1) {
        badRequest('step_number must be an integer >= 1');
      }
    }

    const now = new Date().toISOString();
    const { data: created, error } = await supabase
      .from(STEPS_TABLE)
      .insert({
        sequence_id: sequenceId,
        step_number: stepNumber,
        ...step,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        badRequest('A step already exists for this parent step + branch in this sequence');
      }
      throw toError(error, 'Failed to create step');
    }

    const { data: seqRow } = await supabase
      .from(SEQUENCES_TABLE)
      .select('status')
      .eq('id', sequenceId)
      .maybeSingle();
    if (seqRow && seqRow.status === 'active') {
      void runWorkerNow(sequenceId);
    }

    await syncBranchStepForNode(sequenceId, created);
    await syncSequenceContentColumns(sequenceId);
    return created as SequenceStep;
  })();
}

/** Update a step. */
export function updateStep(
  sequenceId: string,
  stepId: string,
  payload: Partial<SequenceStepInput>
): Promise<SequenceStep> {
  return (async () => {
    const existing = await stepBelongsToSequence(sequenceId, stepId);
    const incoming = payload as any;

    const validated = validateStepData({
      normal_subject: incoming && incoming.normal_subject !== undefined ? incoming.normal_subject : existing.normal_subject,
      normal_body: incoming && incoming.normal_body !== undefined ? incoming.normal_body : existing.normal_body,
      increment_subject: incoming && incoming.increment_subject !== undefined ? incoming.increment_subject : existing.increment_subject,
      increment_body: incoming && incoming.increment_body !== undefined ? incoming.increment_body : existing.increment_body,
      from_name: incoming && incoming.from_name !== undefined ? incoming.from_name : existing.from_name,
      wait_hours: incoming && incoming.wait_hours !== undefined ? incoming.wait_hours : existing.wait_hours,
      recipient_type: incoming && incoming.recipient_type !== undefined ? incoming.recipient_type : existing.recipient_type,
      send_action: incoming && incoming.send_action !== undefined ? incoming.send_action : existing.send_action,
      send_after_value: incoming && incoming.send_after_value !== undefined ? incoming.send_after_value : existing.send_after_value,
      send_after_unit: incoming && incoming.send_after_unit !== undefined ? incoming.send_after_unit : existing.send_after_unit,
      parent_step_id: incoming && incoming.parent_step_id !== undefined ? incoming.parent_step_id : existing.parent_step_id,
      parent_branch: incoming && incoming.parent_branch !== undefined ? incoming.parent_branch : existing.parent_branch,
      parent_path: incoming && incoming.parent_path !== undefined ? incoming.parent_path : existing.parent_path,
      branch_type: incoming && incoming.branch_type !== undefined ? incoming.branch_type : existing.branch_type,
    });

    if (validated.parent_step_id) {
      if (String(validated.parent_step_id) === String(existing.id)) {
        badRequest('A step cannot be its own parent');
      }
      await assertParentStepExists(sequenceId, validated.parent_step_id);
    }

    const updates: any = { ...validated, updated_at: new Date().toISOString() };

    const wantsNoParent =
      payload && payload.parent_step_id !== undefined &&
      (payload.parent_step_id === null || String(payload.parent_step_id).trim() === '') &&
      Boolean(existing.parent_step_id);
    if (wantsNoParent) {
      updates.parent_step_id = null;
      updates.parent_branch = BRANCH_STARTING;
    }

    if (payload && payload.step_number !== undefined) {
      const stepNumber = Number(payload.step_number);
      if (!Number.isInteger(stepNumber) || stepNumber < 1) {
        badRequest('step_number must be an integer >= 1');
      }
      updates.step_number = stepNumber;
    }

    const { data: updated, error } = await supabase
      .from(STEPS_TABLE)
      .update(updates)
      .eq('id', stepId)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') {
        badRequest('A step already exists for this parent step + branch in this sequence');
      }
      throw toError(error, 'Failed to update step');
    }

    const oldKey = `${Number(existing.step_number)}|${existing.parent_branch}`;
    const newKey = `${Number(updated.step_number)}|${updated.parent_branch}`;
    if (oldKey !== newKey) {
      await removeBranchStepsForNodes(sequenceId, [existing]);
    }
    await syncBranchStepForNode(sequenceId, updated);
    await syncSequenceContentColumns(sequenceId);

    return updated as SequenceStep;
  })();
}

function collectSubtreeIds(steps: any[], rootId: string): string[] {
  const ids: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (ids.includes(id)) continue;
    ids.push(id);
    for (const child of childrenOf(steps, id)) queue.push(child.id);
  }
  return ids;
}

/** Delete a step node safely (subtree rules + archive-vs-hard-delete). */
export function deleteStep(
  sequenceId: string,
  stepId: string,
  cascade: boolean = false
): Promise<{ deleted: boolean; mode?: string; affected?: number }> {
  return (async () => {
    const step = await stepBelongsToSequence(sequenceId, stepId);
    if (step.archived_at) {
      return { deleted: false, already_deleted: true } as any;
    }

    const sequence = await getSequenceRow(sequenceId);
    const steps = await listSteps(sequenceId);
    const isStarting = step.parent_step_id === null;

    if (isStarting) {
      if (steps.length > 1) {
        conflict(
          `The starting step cannot be deleted while ${steps.length - 1} other step(s) exist — delete or re-parent them first.`
        );
      }
      if (sequence.status !== 'draft') {
        conflict(`The starting step of a ${sequence.status} sequence cannot be deleted.`);
      }
    }

    const affectedIds = collectSubtreeIds(steps, stepId);
    const directChildren = childrenOf(steps, stepId);

    if (affectedIds.length > 1 && !cascade) {
      const children = directChildren.map((c) => ({
        id: c.id,
        step_number: Number(c.step_number),
        parent_branch: c.parent_branch,
        subject: nodeContentSubject(c) || c.normal_subject || 'Untitled step',
      }));
      const error: any = new Error(
        `This step has ${affectedIds.length - 1} child step(s) (and their descendants) that would be deleted. Confirm the deletion to remove them too.`
      );
      error.status = 409;
      error.detail = { children, affected_count: affectedIds.length };
      throw error;
    }

    const { data: affectedNodes } = await supabase
      .from(STEPS_TABLE)
      .select('step_number, parent_branch')
      .in('id', affectedIds);
    if (affectedNodes) await removeBranchStepsForNodes(sequenceId, affectedNodes);

    if (affectedIds.length > 0) {
      await supabase
        .from(ENROLLMENTS_TABLE)
        .update({ status: 'completed', next_run_at: null, updated_at: new Date().toISOString() })
        .in('current_step_id', affectedIds)
        .eq('status', 'active');
    }

    const { data: logRows, error: logErr } = await supabase
      .from(STEP_LOGS_TABLE)
      .select('id')
      .in('sequence_step_id', affectedIds)
      .limit(1);
    if (logErr) throw toError(logErr, 'Failed to check step send history');
    const hasHistory = (logRows || []).length > 0;

    if (hasHistory) {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from(STEPS_TABLE)
        .update({ archived_at: nowIso, updated_at: nowIso })
        .in('id', affectedIds);
      if (error) throw toError(error, 'Failed to archive step');
      await syncSequenceContentColumns(sequenceId);
      return { deleted: true, mode: 'archived', affected: affectedIds.length };
    }

    const { error } = await supabase.from(STEPS_TABLE).delete().in('id', affectedIds);
    if (error) throw toError(error, 'Failed to delete step');
    await syncSequenceContentColumns(sequenceId);
    return { deleted: true, mode: 'deleted', affected: affectedIds.length };
  })();
}

// ─── Engagement / overview helpers ─────────────────────────────────────────

async function sequenceEngagement(sequenceId: string): Promise<{
  all: number;
  opened: number;
  not_opened: number;
}> {
  const { data: logs, error } = await supabase
    .from(STEP_LOGS_TABLE)
    .select('contact_id, email_log_id')
    .eq('sequence_id', sequenceId);
  if (error) throw toError(error, 'Failed to load sequence engagement');

  const emailLogIds = [...new Set((logs || []).map((l) => l.email_log_id).filter(Boolean))];
  const openedByLogId = new Map<string, boolean>();
  if (emailLogIds.length > 0) {
    const { data: emailLogs, error: e2 } = await supabase
      .from('email_logs')
      .select('id, opened')
      .in('id', emailLogIds);
    if (e2) throw toError(e2, 'Failed to load sequence email engagement');
    for (const log of emailLogs || []) openedByLogId.set(log.id, log.opened === true);
  }

  const received = new Set<string>();
  const openedContacts = new Set<string>();
  for (const log of logs || []) {
    if (!log.contact_id) continue;
    received.add(log.contact_id);
    if (openedByLogId.get(log.email_log_id)) openedContacts.add(log.contact_id);
  }
  return {
    all: received.size,
    opened: openedContacts.size,
    not_opened: Math.max(0, received.size - openedContacts.size),
  };
}

async function resolveSequenceAudience(sequence: any): Promise<any[]> {
  const contacts = await resolveContactsForAudience(sequence.audience_segment);
  return dedupeContacts(contacts || []);
}

async function buildNextEmails(sequenceId: string, steps: any[]): Promise<Map<string, any[]>> {
  const nextByNode = new Map<string, any[]>();
  const nodesWithChildren = (steps || []).filter((s) =>
    (steps || []).some((c) => c.parent_step_id === s.id)
  );
  if (nodesWithChildren.length === 0) return nextByNode;

  let branchSteps: any[] = [];
  try {
    const { data, error } = await supabase
      .from(BRANCH_STEPS_TABLE)
      .select('sequence_id, step, parent_step, parent_branch, subject')
      .eq('sequence_id', sequenceId);
    if (!error) branchSteps = data || [];
  } catch (err) {
    console.warn('[sequenceApi] Failed to load branch steps for next emails:', (err as Error).message);
  }

  for (const node of nodesWithChildren) {
    const children = childrenOf(steps, node.id).map((child) => {
      const candidates = branchSteps.filter(
        (b) =>
          b.sequence_id === sequenceId &&
          Number(b.step) === Number(child.step_number) &&
          b.parent_branch === child.parent_branch &&
          Number(b.parent_step) === Number(node.step_number)
      );
      const flatRow = candidates.length === 1 ? candidates[0] : null;
      return {
        step_number: Number(child.step_number),
        branch: child.parent_branch === BRANCH_NOT_OPENED ? BRANCH_NOT_OPENED : BRANCH_OPENED,
        label: child.parent_branch === BRANCH_NOT_OPENED ? 'Not Opened' : 'Opened',
        subject: flatRow && flatRow.subject ? flatRow.subject : nodeContentSubject(child),
      };
    });
    nextByNode.set(node.id, children);
  }
  return nextByNode;
}

// ─── Activate / pause ──────────────────────────────────────────────────────

async function assertActivatable(id: string): Promise<void> {
  const sequence = await getSequenceRow(id);
  const missing: string[] = [];
  if (!sequence.name || !String(sequence.name).trim()) missing.push('name');
  if (!sequence.audience_segment || !String(sequence.audience_segment).trim()) {
    missing.push('audience_segment');
  }
  const { data: steps, error: stepsError } = await supabase
    .from(STEPS_TABLE)
    .select('id')
    .eq('sequence_id', id)
    .is('archived_at', null)
    .limit(1);
  if (stepsError) throw toError(stepsError, 'Failed to check sequence steps');
  if (!steps || steps.length === 0) missing.push('at least one step');
  if (missing.length > 0) {
    badRequest(`Cannot activate — missing: ${missing.join(', ')}`);
  }
}

/** Activate a sequence and enroll its target audience (idempotent). */
export function activateSequence(
  id: string
): Promise<Sequence & { enrolled_count?: number; resolved_contacts?: number }> {
  return (async () => {
    await assertActivatable(id);
    const sequence = await getSequenceRow(id);

    const contacts = await resolveSequenceAudience(sequence);
    const steps = await listSteps(id);
    const startingStep = startingNodeOf(steps);
    if (!startingStep) badRequest('Cannot activate — no starting step defined');

    const now = new Date().toISOString();
    // Step 1 (the STARTING node) must send immediately after activation; the
    // step's own wait_hours only governs the later OPENED/NOT_OPENED branch.
    const startingDue = now;

    const enrollments = (contacts || []).map((contact) => ({
      sequence_id: id,
      contact_id: contact.id,
      current_step_id: startingStep.id,
      current_step: Number(startingStep.step_number),
      current_email_type: 'normal',
      status: 'active',
      enrolled_at: now,
      next_run_at: startingDue,
    }));

    if (enrollments.length > 0) {
      const { error: enrollError } = await supabase
        .from(ENROLLMENTS_TABLE)
        .upsert(enrollments, { onConflict: 'sequence_id,contact_id', ignoreDuplicates: true });
      if (enrollError) throw toError(enrollError, 'Failed to enroll contacts');
    }

    const { error: resetError } = await supabase
      .from(ENROLLMENTS_TABLE)
      .update({ next_run_at: startingDue, updated_at: now })
      .eq('sequence_id', id)
      .eq('status', 'active')
      .eq('current_step_id', startingStep.id);
    if (resetError) throw toError(resetError, 'Failed to schedule sequence enrollments');

    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to activate sequence');

    // Arm the per-step batch queues (best-effort) so a configured first-batch
    // delay is enforced the moment the runner picks the enrollments up.
    if (sequence.batch_enabled) await syncSequenceBatchState(id);

    void runWorkerNow(id);
    await syncSequenceContentColumns(id);

    return {
      ...data,
      enrolled_count: enrollments.length,
      resolved_contacts: (contacts || []).length,
    } as Sequence & { enrolled_count?: number; resolved_contacts?: number };
  })();
}

/** Pause a sequence. */
export function pauseSequence(id: string): Promise<Sequence> {
  return (async () => {
    await sequenceExists(id);
    const { data, error } = await supabase
      .from(SEQUENCES_TABLE)
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw toError(error, 'Failed to pause sequence');
    return data as Sequence;
  })();
}

// ─── Contacts + logs ───────────────────────────────────────────────────────

/** Enrolled contacts (enrollments joined with contact row). */
export function fetchSequenceContacts(id: string): Promise<SequenceEnrollment[]> {
  return (async () => {
    await sequenceExists(id);
    const { data, error } = await supabase
      .from(ENROLLMENTS_TABLE)
      .select('*, contacts(id, full_name, email, company, contact_type, company_category)')
      .eq('sequence_id', id)
      .order('enrolled_at', { ascending: false });
    if (error) throw toError(error, 'Failed to fetch sequence contacts');

    return (data || []).map((row: any) => {
      const contact = row.contacts;
      return {
        id: row.id,
        sequence_id: row.sequence_id,
        contact_id: row.contact_id,
        current_step: row.current_step,
        current_step_id: row.current_step_id,
        current_email_type: row.current_email_type,
        current_email_log_id: row.current_email_log_id,
        status: row.status,
        next_run_at: row.next_run_at,
        sent_at: row.sent_at,
        enrolled_at: row.enrolled_at,
        last_action_at: row.last_action_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        contact,
      } as SequenceEnrollment;
    });
  })();
}

/** Sent step logs (authoritative open/click merged from linked email_logs). */
export function fetchSequenceLogs(id: string): Promise<SequenceStepLog[]> {
  return (async () => {
    await sequenceExists(id);
    const { data, error } = await supabase
      .from(STEP_LOGS_TABLE)
      .select(
        '*, sequence_steps(step_number, parent_branch, normal_subject, normal_body, increment_subject, increment_body), contacts(id, full_name, email)'
      )
      .eq('sequence_id', id)
      .order('sent_at', { ascending: false });
    if (error) throw toError(error, 'Failed to fetch sequence logs');

    const rows = data || [];
    const emailLogIds = [...new Set(rows.map((r: any) => r.email_log_id).filter(Boolean))];
    const emailLogsById = new Map<string, any>();
    if (emailLogIds.length > 0) {
      const { data: logs, error: logsError } = await supabase
        .from('email_logs')
        .select('id, opened, opened_at, clicked, clicked_at')
        .in('id', emailLogIds);
      if (!logsError) for (const log of logs || []) emailLogsById.set(log.id, log);
    }

    return rows.map((row: any) => {
      const emailLog = row.email_log_id ? emailLogsById.get(row.email_log_id) || null : null;
      const stepRow = row.sequence_steps || null;
      const step = stepRow
        ? {
            ...stepRow,
            // Expose the subject actually sent for this branch: NOT_OPENED nodes
            // use the increment_* content, everything else uses normal_*.
            display_subject: stepRow.parent_branch === BRANCH_NOT_OPENED
              ? stepRow.increment_subject || stepRow.normal_subject
              : stepRow.normal_subject || stepRow.increment_subject,
          }
        : null;
      return {
        id: row.id,
        sequence_id: row.sequence_id,
        sequence_step_id: row.sequence_step_id,
        contact_id: row.contact_id,
        email_log_id: row.email_log_id,
        sent_at: row.sent_at,
        opened: emailLog ? emailLog.opened === true : row.opened === true,
        opened_at: (emailLog && emailLog.opened_at) || row.opened_at || null,
        clicked: emailLog ? emailLog.clicked === true : row.clicked === true,
        clicked_at: (emailLog && emailLog.clicked_at) || row.clicked_at || null,
        status: row.status,
        created_at: row.created_at,
        step,
        contact: row.contacts || null,
      } as SequenceStepLog;
    });
  })();
}

// ─── Recipients + manual send ──────────────────────────────────────────────

/** Eligible recipients for a sequence node with engagement data. */
export function fetchSequenceRecipients(
  id: string,
  stepId?: string
): Promise<SequenceRecipientsResponse> {
  return (async () => {
    const sequence = await getSequenceRow(id);
    const steps = await listSteps(id);
    const step = stepId ? steps.find((s) => s.id === stepId) : startingNodeOf(steps);
    if (stepId && !step) notFound('Step', stepId);

    const [enrolled, engagement, stepLogResult] = await Promise.all([
      supabase
        .from(ENROLLMENTS_TABLE)
        .select('*, contacts(id, full_name, email, company, contact_type, company_category)')
        .eq('sequence_id', id)
        .order('enrolled_at', { ascending: false }),
      sequenceEngagement(id),
      step
        ? supabase
            .from(STEP_LOGS_TABLE)
            .select('contact_id, status')
            .eq('sequence_id', id)
            .eq('sequence_step_id', step.id)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (enrolled.error) throw toError(enrolled.error, 'Failed to fetch sequence enrollments');
    if (stepLogResult.error) throw toError(stepLogResult.error, 'Failed to load sent step logs');

    const enrollmentRows = enrolled.data || [];
    // A recipient is only "already sent" when the step actually went out
    // successfully. A failed or skipped log must NOT block re-send eligibility.
    const alreadySent = new Set<string>(
      (stepLogResult.data || []).filter((r: any) => r && r.status === 'sent').map((r: any) => r.contact_id)
    );

    const eligibility = await getBranchEligibility(
      id,
      step.id,
      enrollmentRows.map((e: any) => e.contact_id)
    );

    const recipients = enrollmentRows.map((e: any) => {
      const contact = e.contacts || null;
      const eng = eligibility.get(e.contact_id) || null;
      const sentForStep = alreadySent.has(e.contact_id);

      let status: string = 'eligible';
      if (sentForStep) status = 'already_sent';
      else if (eng && !eng.eligible) {
        // opened === null means the parent email was never sent / never opened —
        // the recipient is not on any branch yet, so label it distinctly rather
        // than pretending it is a "Not Opened" recipient.
        if (eng.opened === true) status = 'opened';
        else if (eng.opened === false) status = 'not_opened';
        else status = 'ineligible';
      }

      return {
        contact: contact
          ? {
              id: contact.id,
              full_name: contact.full_name,
              email: contact.email,
              company: contact.company,
              contact_type: contact.contact_type,
              company_category: contact.company_category,
            }
          : {
              id: e.contact_id,
              full_name: null,
              email: null,
              company: null,
              contact_type: null,
              company_category: null,
            },
        email_status: eng ? eng.email_status : null,
        opened: eng ? eng.opened : null,
        opened_at: eng ? eng.opened_at : null,
        clicked: eng ? eng.clicked : null,
        clicked_at: eng ? eng.clicked_at : null,
        sent_at: eng ? eng.parentSentAt : null,
        last_activity: eng ? eng.opened_at || eng.clicked_at || eng.parentSentAt || null : null,
        sequence_status: e.status,
        already_sent: sentForStep,
        status,
      };
    });

    return {
      sequence: {
        ...sequence,
        engagement,
      },
      step,
      recipients,
    } as SequenceRecipientsResponse;
  })();
}

/**
 * Pull the real reason out of a functions.invoke error. `FunctionsHttpError`
 * wraps the function's Response in `error.context`; without this the UI would
 * only ever show the SDK's generic "Failed to send a request to the Edge
 * Function" message instead of the server's JSON error.
 */
async function extractFunctionError(error: unknown, fallback = 'Edge Function call failed'): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: string; message?: string } | null;
      if (body?.error) return body.error;
      if (body?.message) return body.message;
    } catch {
      // Response body not JSON — fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Send a sequence node to selected recipients right now via the
 * sequence-manual-send Edge Function (SMTP stays server-side).
 */
export function manualSend(
  id: string,
  stepId: string,
  contactIds: string[]
): Promise<ManualSendResult> {
  return (async () => {
    const { data, error } = await supabase.functions.invoke('sequence-manual-send', {
      body: { sequence_id: id, step_id: stepId, contact_ids: contactIds },
    });
    if (error) throw new Error(await extractFunctionError(error, 'Manual send failed'));
    const payload = data as any;
    if (!payload || payload.success === false) {
      throw new Error((payload && payload.error) || 'Manual send failed');
    }
    return payload.data as ManualSendResult;
  })();
}
