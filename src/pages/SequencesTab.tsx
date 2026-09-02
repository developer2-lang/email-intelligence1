import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';
import { fetchTemplates } from '../services/campaignService';
import type { EmailTemplate } from '../types/campaign';
import LoadTemplateControl from '../components/LoadTemplateControl';
import TemplatePreview from '../components/TemplatePreview';
import StepAttachmentsControl from '../components/StepAttachmentsControl';
import type {
  AudienceOption,
  BranchStepInput,
  Sequence,
  SequenceAttachment,
  SequenceBranchStep,
  SequenceEnrollment,
  SequenceRecipient,
  SequenceStep,
  SequenceStepLog,
  SequenceStepInput,
  SequenceInput,
  RecipientType,
  SendMode,
  StepParentBranch,
} from '../types/sequence';
import {
  uploadStepAttachment,
  fetchStepAttachments,
  removeStepAttachment,
  relocatePendingStepAttachments,
} from '../services/sequenceAttachmentService';
import {
  fetchSequences,
  fetchSequence,
  createSequence,
  updateSequence,
  deleteSequence,
  fetchAudienceOptions,
  countContactsForAudience,
  fetchBranchSteps,
  updateBranchStep,
  createStep,
  updateStep,
  deleteStep,
  activateSequence,
  pauseSequence,
  fetchSequenceContacts,
  fetchSequenceLogs,
  fetchSequenceRecipients,
  manualSend,
  triggerTypeLabel,
  sendModeLabel,
  statusTagClass,
  formatSequenceDate,
} from '../services/sequenceService';

interface SequencesTabProps {
  onPersistSequences: (seqs: Sequence[]) => void;
  onToast: (msg: string, type?: string) => void;
}

/** One step being edited in the create/edit modal. */
interface StepDraft {
  /** Stable client-only id so in-list parents survive deletes/reorders. */
  draftKey: string;
  /** Persisted step id (null for steps not yet saved). */
  id: string | null;
  /** Persisted Not Opened branch node id (the increment sibling, if saved). */
  notOpenedId: string | null;
  /** Persisted step number (existing steps only; null for new drafts). */
  step_number: number | null;
  normal_subject: string;
  normal_body: string;
  increment_subject: string;
  increment_body: string;
  from_name: string;
  wait_hours: number;
  recipient_type: RecipientType;
  /** Persisted parent node id (existing steps only). */
  parent_step_id: string | null;
  /** Which branch of the parent this node extends: 'STARTING' | 'OPENED' | 'NOT_OPENED'. */
  parent_branch: StepParentBranch | null;
  /** draftKey of the parent draft (in-list reference, incl. new drafts). */
  parent_key: string | null;
  /** Selected template id for the OPENED/starting branch (Load Template control). */
  normal_template_id: string;
  /** Resolved template HTML for the OPENED branch — internal, used for sending only. */
  normal_template_html: string;
  /** The plain-text body the user typed before a template was applied (restored on deselect). */
  normal_manual_body: string;
  /** True while the OPENED branch template is being fetched from Storage. */
  normal_loading: boolean;
  /** Load error for the OPENED branch template (kept after failure). */
  normal_error: string | null;
  /** Selected template id for the NOT OPENED branch (Load Template control). */
  increment_template_id: string;
  /** Resolved template HTML for the NOT OPENED branch — internal, used for sending only. */
  increment_template_html: string;
  /** The plain-text body the user typed before a template was applied (restored on deselect). */
  increment_manual_body: string;
  /** True while the NOT OPENED branch template is being fetched from Storage. */
  increment_loading: boolean;
  /** Load error for the NOT OPENED branch template (kept after failure). */
  increment_error: string | null;
  /** Attachments for the OPENED/starting branch node (sequence_step_id = this draft's Opened node). */
  normal_attachments: SequenceAttachment[];
  /** Attachments for the NOT OPENED branch node (sequence_step_id = this draft's Not Opened node). */
  increment_attachments: SequenceAttachment[];
  /** True while an OPENED/starting branch file is being uploaded. */
  normal_attachments_uploading: boolean;
  /** True while a NOT OPENED branch file is being uploaded. */
  increment_attachments_uploading: boolean;
  /** Upload error for the OPENED/starting branch (kept after failure). */
  normal_attachments_error: string | null;
  /** Upload error for the NOT OPENED branch (kept after failure). */
  increment_attachments_error: string | null;
}

interface SequenceDetailData {
  seq: Sequence;
  enrollments: SequenceEnrollment[];
  logs: SequenceStepLog[];
}

const TRIGGER_OPTIONS: { value: 'manual' | 'time_based' | 'behaviour'; label: string }[] = [
  { value: 'manual', label: 'Manual enrollment' },
  { value: 'time_based', label: 'Time-based (after a delay)' },
  { value: 'behaviour', label: 'Behaviour (on email open/click)' },
];

const SEND_MODE_OPTIONS: { value: SendMode; label: string; desc: string; icon: string }[] = [
  {
    value: 'automatic',
    label: 'Automatic',
    desc: 'Send sequence emails automatically according to the configured schedule.',
    icon: '▶',
  },
  {
    value: 'manual',
    label: 'Manual',
    desc: 'Allow the user to manually select eligible recipients and send.',
    icon: '☝',
  },
  {
    value: 'both',
    label: 'Automatic + Manual',
    desc: 'Enable both automatic sending and manual sending.',
    icon: '⇄',
  },
];

let draftKeySeq = 0;
function nextDraftKey(): string {
  draftKeySeq += 1;
  return `draft-${draftKeySeq}`;
}

function newStepDraft(prevDrafts?: StepDraft[]): StepDraft {
  const prev = prevDrafts && prevDrafts.length > 0 ? prevDrafts[prevDrafts.length - 1] : null;
  return {
    draftKey: nextDraftKey(),
    id: null,
    notOpenedId: null,
    step_number: null,
    normal_subject: '',
    normal_body: '',
    increment_subject: '',
    increment_body: '',
    from_name: '',
    wait_hours: 24,
    recipient_type: 'all',
    parent_step_id: null,
    // A new step extends the previous step's Opened branch by default — the same
    // behaviour as the legacy linear model; branching only happens when the
    // user picks a different path in the "Parent Step / Recipient Branch"
    // dropdown.
    parent_branch: prev ? 'OPENED' : 'STARTING',
    parent_key: prev ? prev.draftKey : null,
    normal_template_id: '',
    normal_template_html: '',
    normal_manual_body: '',
    normal_loading: false,
    normal_error: null,
    increment_template_id: '',
    increment_template_html: '',
    increment_manual_body: '',
    increment_loading: false,
    increment_error: null,
    normal_attachments: [],
    increment_attachments: [],
    normal_attachments_uploading: false,
    increment_attachments_uploading: false,
    normal_attachments_error: null,
    increment_attachments_error: null,
  };
}

function stepToDraft(step: SequenceStep): StepDraft {
  return {
    draftKey: nextDraftKey(),
    id: step.id,
    notOpenedId: null,
    step_number: typeof step.step_number === 'number' ? step.step_number : Number(step.step_number) || null,
    normal_subject: step.normal_subject || '',
    normal_body: step.normal_body || '',
    increment_subject: step.increment_subject || '',
    increment_body: step.increment_body || '',
    from_name: step.from_name || '',
    wait_hours: typeof step.wait_hours === 'number' ? step.wait_hours : 24,
    recipient_type: step.recipient_type || 'all',
    parent_step_id: step.parent_step_id || null,
    parent_branch: step.parent_step_id ? step.parent_branch || 'OPENED' : 'STARTING',
    parent_key: null,
    normal_template_id: step.normal_template_id || '',
    normal_template_html: '',
    normal_manual_body: '',
    normal_loading: false,
    normal_error: null,
    increment_template_id: step.increment_template_id || '',
    increment_template_html: '',
    increment_manual_body: '',
    increment_loading: false,
    increment_error: null,
    normal_attachments: [],
    increment_attachments: [],
    normal_attachments_uploading: false,
    increment_attachments_uploading: false,
    normal_attachments_error: null,
    increment_attachments_error: null,
  };
}

/**
 * Payload for a step's OPENED branch node.
 *
 * Every non-root step card saves TWO branch nodes: the Opened node (this
 * payload — normal content, sent immediately) and the Not Opened node (see
 * stepNotOpenedPayload — increment content, sent after the wait). The starting
 * node has no parent and keeps its own (legacy) increment fields.
 */
function stepPayload(
  draft: StepDraft,
  parentId: string | null,
  stepNumber: number | null,
): SequenceStepInput {
  const isRoot = !parentId;
  return {
    step_number: stepNumber == null ? undefined : stepNumber,
    normal_subject: draft.normal_subject.trim(),
    normal_body: draft.normal_body.trim(),
    normal_template_id: draft.normal_template_id.trim() || null,
    increment_subject: isRoot ? draft.increment_subject.trim() || null : null,
    increment_body: isRoot ? draft.increment_body.trim() || null : null,
    increment_template_id: isRoot ? draft.increment_template_id.trim() || null : null,
    from_name: draft.from_name.trim() || null,
    wait_hours: isRoot ? Number(draft.wait_hours) : 0,
    recipient_type: draft.recipient_type,
    parent_step_id: parentId,
    parent_branch: parentId ? 'OPENED' : 'STARTING',
  };
}

/** Payload for a step's NOT OPENED branch node (increment content + wait). */
function stepNotOpenedPayload(
  draft: StepDraft,
  parentId: string,
  stepNumber: number | null,
): SequenceStepInput {
  return {
    step_number: stepNumber == null ? undefined : stepNumber,
    normal_subject: '',
    normal_body: '',
    normal_template_id: null,
    increment_subject: draft.increment_subject.trim() || null,
    increment_body: draft.increment_body.trim() || null,
    increment_template_id: draft.increment_template_id.trim() || null,
    from_name: draft.from_name.trim() || null,
    wait_hours: Number(draft.wait_hours),
    recipient_type: draft.recipient_type,
    parent_step_id: parentId,
    parent_branch: 'NOT_OPENED',
  };
}

/**
 * Resolve the parent NODE id for a draft at save time.
 *
 * The "Parent Step / Recipient Branch" dropdown points at a parent CARD plus a
 * branch. Because each card saves two nodes (Opened + Not Opened), the parent
 * node is that card's node for the selected branch — falling back to whatever
 * node the parent card has when it doesn't have a Not Opened sibling yet.
 *
 * In-list references (parent_key) are preferred because they survive deletes,
 * reorders and re-parenting: the parent may be an existing node (its persisted
 * id) or a new sibling created earlier in this same save (whose id is captured
 * in idByKey as parents are always saved before their children).
 */
function resolveParentId(
  draft: StepDraft,
  drafts: StepDraft[],
  idByKey: Record<string, string>,
  notOpenedIdByKey: Record<string, string>,
): string | null {
  if (draft.parent_key) {
    const parent = drafts.find((d) => d.draftKey === draft.parent_key);
    if (!parent) return null;
    const wantNotOpened = draft.parent_branch === 'NOT_OPENED';
    const id = wantNotOpened
      ? parent.notOpenedId ||
        notOpenedIdByKey[parent.draftKey] ||
        parent.id ||
        idByKey[parent.draftKey]
      : parent.id ||
        idByKey[parent.draftKey] ||
        parent.notOpenedId ||
        notOpenedIdByKey[parent.draftKey];
    return id || null;
  }
  return draft.parent_step_id;
}

/** Selected "key:branch" value for a draft's parent dropdown ('' = no parent). */
function parentOptionValue(draft: StepDraft, drafts: StepDraft[]): string {
  if (!draft.parent_key) return '';
  if (!drafts.some((d) => d.draftKey === draft.parent_key)) return '';
  return `${draft.parent_key}:${draft.parent_branch || 'OPENED'}`;
}

/** Human-readable branch label for a node ('Starting' when it has no parent). */
function stepPathLabel(step: SequenceStep | null): string {
  if (!step) return '—';
  if (!step.parent_step_id) return 'Starting';
  return step.parent_branch === 'NOT_OPENED' ? 'Not Opened' : 'Opened';
}

/**
 * Parent reference for a node, e.g. 'Step 1 — Opened' for a child of the
 * starting node's opened branch, and 'Step 2A — Opened' for a child of the
 * STEP 2 NOT_OPENED node (the parent gets an 'A' suffix when the parent NODE
 * itself is a NOT_OPENED node). 'Starting Step' when the node is the root.
 */
function stepParentLabel(step: SequenceStep | null, steps: SequenceStep[]): string {
  if (!step) return '—';
  if (!step.parent_step_id) return 'Starting Step';
  const parent = steps.find((s) => s.id === step.parent_step_id) || null;
  if (!parent) return '—';
  const branch = step.parent_branch === 'NOT_OPENED' ? 'Not Opened' : 'Opened';
  const parentA = parent.parent_branch === 'NOT_OPENED' ? 'A' : '';
  return `Step ${parent.step_number}${parentA} — ${branch}`;
}

function sendModeTagClass(mode: SendMode | null | undefined): string {
  switch (mode) {
    case 'automatic':
      return 'tag-client';
    case 'manual':
      return 'tag-oem';
    default:
      return 'tag-startup';
  }
}

/** Short label for a step's recipient condition shown on the timeline. */
function stepConditionLabel(type: RecipientType | null | undefined): string {
  switch (type) {
    case 'opened':
      return 'Opened';
    case 'not_opened':
      return 'Not Opened';
    default:
      return 'All Recipients';
  }
}

/**
 * Nominal "Day N" for a step, derived from the real wait_hours of every earlier
 * step (never hardcoded). Step 1 fires on day 0.
 */
function stepDayLabel(step: SequenceStep, steps: SequenceStep[]): string {
  let hours = 0;
  for (const s of steps) {
    if (Number(s.step_number) >= Number(step.step_number)) break;
    hours += Number(s.wait_hours) || 0;
  }
  if (hours <= 0) return 'Day 0';
  const days = Math.round(hours / 24);
  return days === 0 ? 'Day 0' : `Day ${days}`;
}

/**
 * Overall open rate of a sequence, derived from ACTUAL send/open records
 * (sequence_step_logs + email_logs, deduplicated per distinct contact).
 * Never derived from enrollment counts or UI state. Returns '—' until
 * overview data is available, and '0%' when nothing was sent yet.
 */
function openRateOf(seq: Sequence): string {
  const engagement = seq.engagement || { all: 0, opened: 0, not_opened: 0 };
  if (engagement.all === 0) return '0%';
  return `${Math.round((engagement.opened / engagement.all) * 100)}%`;
}

/**
 * Scheduling status shown on a sequence card, derived ONLY from real database
 * state (the fields the sequence runner writes):
 *
 *   - Scheduled  → active enrollments with a future next_run_at (emails waiting)
 *   - Sending    → active enrollments whose next_run_at is due NOW (the cron /
 *                  runner is about to send or is currently processing them)
 *   - Sent       → nothing scheduled but emails have already been sent
 *   - Completed  → all enrollments finished (no active work left)
 *   - Paused     → the sequence itself is paused (nothing auto-schedules)
 */
type ScheduleState =
  | { label: 'Scheduled'; nextAt: string }
  | { label: 'Sending' }
  | { label: 'Sent'; lastAt: string | null }
  | { label: 'Completed'; lastAt: string | null }
  | { label: 'Paused' };

function scheduleStateOf(seq: Sequence, now: number): ScheduleState | null {
  if (seq.status === 'paused') return { label: 'Paused' };
  const summary = seq.summary;
  const activeCount = seq.active_count ?? (summary ? summary.in_progress : 0);
  const nextRunAt = seq.next_run_at || null;
  // Manual-only sequences are never processed by the cron — only activity
  // states (Sent / Completed) can ever apply to them.
  const autoScheduled = seq.send_mode !== 'manual';
  if (autoScheduled && activeCount > 0 && nextRunAt) {
    if (new Date(nextRunAt).getTime() <= now) return { label: 'Sending' };
    return { label: 'Scheduled', nextAt: nextRunAt };
  }
  if (seq.last_sent_at) {
    if (activeCount === 0 && summary && summary.total > 0) {
      return { label: 'Completed', lastAt: seq.last_sent_at };
    }
    return { label: 'Sent', lastAt: seq.last_sent_at };
  }
  return null;
}

/**
 * True when a sequence is genuinely completed per the product's real
 * completion definition (the SAME state the card's "✓ Completed" badge is
 * derived from): the sequence is not paused, emails have actually been sent,
 * no enrollment is still in progress (all work finished) and at least one
 * recipient was enrolled. This is a sequence-level completion state — it never
 * relies on the `sequences.status` column (which only ever holds
 * draft/active/paused and is never persisted as 'completed').
 */
function isSequenceCompleted(seq: Sequence): boolean {
  if (seq.status === 'paused') return false;
  const summary = seq.summary;
  const activeCount = seq.active_count ?? (summary ? summary.in_progress : 0);
  if (!seq.last_sent_at) return false;
  return activeCount === 0 && !!summary && (summary.total || 0) > 0;
}

const SEQ_AVATAR_COLORS: Array<{ bg: string; color: string }> = [
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#047857' },
  { bg: '#fef3c7', color: '#b45309' },
  { bg: '#f5f3ff', color: '#7c3aed' },
  { bg: '#fce7f3', color: '#be185d' },
  { bg: '#cffafe', color: '#0e7490' },
  { bg: '#fee2e2', color: '#b91c1c' },
  { bg: '#ede9fe', color: '#6d28d9' },
];

/** Deterministic pastel avatar color for a sequence, derived from its name. */
function sequenceAvatarColor(name: string): { bg: string; color: string } {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SEQ_AVATAR_COLORS[h % SEQ_AVATAR_COLORS.length];
}

/** Node label for a flat branch-step row, e.g. 'STEP 2A' (A = NOT_OPENED node). */
function branchStepNodeLabel(row: SequenceBranchStep): string {
  return `STEP ${row.step}${row.parent_branch === 'NOT_OPENED' ? 'A' : ''}`;
}

/**
 * Parent reference of a flat branch-step row, resolved by the REAL parent row id
 * (parent_step_id). The parent node keeps its own 'A' suffix, so a child of the
 * STEP 2 NOT_OPENED node reads 'STEP 2A'. Falls back to the numeric parent_step
 * only when the row id is missing (legacy row).
 */
function branchStepParentLabel(
  row: SequenceBranchStep,
  rows: SequenceBranchStep[],
): string {
  if (row.parent_step_id != null) {
    const parent = rows.find((r) => r.id === row.parent_step_id) || null;
    if (parent) return branchStepNodeLabel(parent);
  }
  if (row.parent_step != null) return `STEP ${row.parent_step}`;
  return 'STEP 1';
}

function branchStepBranchLabel(branch: StepParentBranch): string {
  switch (branch) {
    case 'OPENED':
      return 'Opened';
    case 'NOT_OPENED':
      return 'Not Opened';
    default:
      return 'Starting';
  }
}

function branchStepBranchTagClass(branch: StepParentBranch): string {
  switch (branch) {
    case 'OPENED':
      return 'tag-startup';
    case 'NOT_OPENED':
      return 'tag-oem';
    default:
      return 'tag-client';
  }
}

function branchStepWaitLabel(waitHours: number | null | undefined): string {
  if (waitHours == null || waitHours === 0) return 'Immediate';
  return `${waitHours} hour${waitHours === 1 ? '' : 's'}`;
}

// ─── MANUAL SEND MODAL ─────────────────────────────────────────────────────

interface ManualSendModalProps {
  seq: Sequence;
  recipients: SequenceRecipient[];
  step: SequenceStep | null;
  steps: SequenceStep[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (contactId: string) => void;
  onSelectAll: (ids: string[]) => void;
  onClearAll: () => void;
  onStepChange: (stepId: string) => void;
  onSend: () => void;
  onClose: () => void;
  sending: boolean;
}

function ManualSendModal({
  seq,
  recipients,
  step,
  steps,
  loading,
  selected,
  onToggle,
  onSelectAll,
  onClearAll,
  onStepChange,
  onSend,
  onClose,
  sending,
}: ManualSendModalProps) {
  const selectableIds = useMemo(
    () =>
      recipients
        .filter((r) => !r.already_sent && r.status === 'eligible')
        .map((r) => r.contact.id),
    [recipients],
  );
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const enrolledCount = recipients.length;
  const eligibleCount = recipients.filter((r) => r.status === 'eligible').length;
  const showingText = `${enrolledCount} enrolled · ${eligibleCount} eligible for this branch · ${step ? stepPathLabel(step) : '—'}`;

  const emptyText = {
    title: 'No eligible recipients',
    sub: 'Recipients appear here once they are on this step\'s branch.',
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: '880px' }}>
        <div className="modal-header">
          <div className="modal-title">Manual Sequence Send</div>
          <button className="btn-icon" onClick={onClose} disabled={sending}>✕</button>
        </div>
        <div className="modal-body">
          <div className="grid-2" style={{ marginBottom: '14px' }}>
            <div className="form-group" style={{ marginBottom: '0' }}>
              <label>Sequence Name</label>
              <input type="text" value={seq.name || ''} readOnly />
            </div>
            <div className="form-group" style={{ marginBottom: '0' }}>
              <label>Target Audience</label>
              <input type="text" value={seq.audience_segment || ''} readOnly />
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '14px',
              alignItems: 'flex-end',
              marginBottom: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div className="form-group" style={{ marginBottom: '0', minWidth: '280px', flex: 1 }}>
              <label>Sequence Step</label>
              <select
                value={step ? step.id : ''}
                disabled={sending}
                onChange={(e) => onStepChange(e.target.value)}
              >
                {steps.map((s) => (
                  <option key={s.id} value={s.id}>
                    Step {s.step_number} ({stepPathLabel(s)}): {s.normal_subject || s.increment_subject || 'Untitled step'}
                  </option>
                ))}
              </select>
            </div>
            <div
              className="form-group"
              style={{
                marginBottom: '0',
                minWidth: '200px',
                padding: '7px 10px',
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r)',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text2)' }}>
                Branching
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
                {step
                  ? stepPathLabel(step) === 'Not Opened'
                    ? `Not Opened node — sends the Increment variant after the parent email's wait (${step.wait_hours ?? 24}h).`
                    : stepPathLabel(step) === 'Starting'
                      ? 'Starting node — sent to every enrolled recipient.'
                      : 'Opened node — sent to recipients who opened the parent email.'
                  : ''}
              </div>
            </div>
          </div>

          <div
            style={{
              fontSize: '12px',
              color: 'var(--text4)',
              padding: '8px 10px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
              marginBottom: '12px',
            }}
          >
            Showing: <strong style={{ color: 'var(--text2)' }}>{showingText}</strong>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              Eligible recipients are re-validated on the backend at send time against this step's
              parent branch (opened / not opened) before any email goes out.
            </div>
          </div>

          {loading ? (
            <div className="empty-state" style={{ padding: '26px' }}>
              <div className="empty-icon">⟳</div>
              <div className="empty-title">Loading eligible recipients…</div>
            </div>
          ) : recipients.length === 0 ? (
            <div className="empty-state" style={{ padding: '26px' }}>
              <div className="empty-icon">✉</div>
              <div className="empty-title">
                {emptyText ? emptyText.title : 'No eligible recipients'}
              </div>
              {emptyText && <div className="empty-sub">{emptyText.sub}</div>}
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: '360px', overflow: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '34px' }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() =>
                          allSelected ? onClearAll() : onSelectAll(selectableIds)
                        }
                        disabled={selectableIds.length === 0}
                      />
                    </th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => {
                    const isAlreadySent = r.already_sent;
                    const isSelectable = r.status === 'eligible';
                    const disabled = isAlreadySent || !isSelectable;
                    return (
                      <tr key={r.contact.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={isAlreadySent ? true : selected.has(r.contact.id)}
                            disabled={disabled}
                            onChange={() => onToggle(r.contact.id)}
                          />
                        </td>
                        <td style={{ fontSize: '12.5px', fontWeight: 600 }}>
                          {r.contact.full_name || '—'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text3)' }}>
                          {r.contact.email || '—'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text3)' }}>
                          {r.contact.company || '—'}
                        </td>
                        <td>
                          <span
                            className={`tag ${
                              r.already_sent
                                ? 'tag-draft'
                                : r.status === 'eligible'
                                  ? 'tag-client'
                                  : r.status === 'ineligible'
                                    ? 'tag-pending'
                                    : r.opened === true
                                      ? 'tag-startup'
                                      : 'tag-oem'
                            }`}
                          >
                            {r.status === 'already_sent'
                              ? 'Already Sent'
                              : r.status === 'eligible'
                                ? 'Eligible'
                                : r.status === 'ineligible'
                                  ? 'Ineligible'
                                  : r.status === 'opened'
                                    ? 'Opened'
                                    : r.status === 'not_opened'
                                      ? 'Not Opened'
                                      : r.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginTop: '12px',
              fontSize: '12.5px',
              color: 'var(--text4)',
            }}
          >
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => onSelectAll(selectableIds)}
            >
              Select all
            </button>
            <button className="btn btn-secondary btn-xs" onClick={onClearAll}>
              Clear all
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ alignSelf: 'center' }}>
              <strong style={{ color: 'var(--text2)' }}>{selected.size}</strong> selected
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={onSend}
            disabled={sending || selected.size === 0}
          >
            {sending ? 'Sending…' : `Send Selected (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── BRANCH STEP EDIT MODAL ────────────────────────────────────────────────

interface BranchStepEditModalProps {
  row: SequenceBranchStep;
  saving: boolean;
  onSave: (payload: BranchStepInput) => void;
  onClose: () => void;
}

function BranchStepEditModal({ row, saving, onSave, onClose }: BranchStepEditModalProps) {
  const [parentStep, setParentStep] = useState(
    row.parent_step != null ? String(row.parent_step) : '',
  );
  const [parentBranch, setParentBranch] = useState<StepParentBranch>(row.parent_branch);
  const [subject, setSubject] = useState(row.subject || '');
  const [body, setBody] = useState(row.body || '');
  const [waitHours, setWaitHours] = useState(String(row.wait_hours ?? 0));

  const handleSubmit = () => {
    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();
    if (!trimmedSubject) return;
    if (!trimmedBody) return;
    const parsedWait = Number(waitHours);
    if (!Number.isFinite(parsedWait) || parsedWait < 0 || !Number.isInteger(parsedWait)) return;

    onSave({
      parent_step: parentStep.trim() ? Number(parentStep) : null,
      parent_branch: parentBranch,
      subject: trimmedSubject,
      body: trimmedBody,
      wait_hours: parsedWait,
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: '720px' }}>
        <div className="modal-header">
          <div className="modal-title">Edit Branch Step {row.step}</div>
          <button className="btn-icon" onClick={onClose} disabled={saving}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="grid-2" style={{ marginBottom: '14px' }}>
            <div className="form-group" style={{ marginBottom: '0' }}>
              <label>Parent Step</label>
              <input
                type="number"
                min={1}
                placeholder="Empty = Starting Step"
                value={parentStep}
                disabled={saving}
                onChange={(e) => setParentStep(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: '0' }}>
              <label>Branch</label>
              <select
                value={parentBranch}
                disabled={saving}
                onChange={(e) => setParentBranch(e.target.value as StepParentBranch)}
              >
                <option value="STARTING">Starting</option>
                <option value="OPENED">Opened</option>
                <option value="NOT_OPENED">Not Opened</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label>Subject</label>
            <input
              type="text"
              value={subject}
              disabled={saving}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Email Body</label>
            <textarea
              value={body}
              disabled={saving}
              rows={8}
              onChange={(e) => setBody(e.target.value)}
              style={{ resize: 'vertical' }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: '0' }}>
            <label>Wait Hours</label>
            <input
              type="number"
              min={0}
              step={1}
              value={waitHours}
              disabled={saving}
              onChange={(e) => setWaitHours(e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
              Use 0 for immediate delivery.
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={
              saving ||
              !subject.trim() ||
              !body.trim() ||
              !Number.isFinite(Number(waitHours)) ||
              Number(waitHours) < 0
            }
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SEQUENCE DETAILS ──────────────────────────────────────────────────────

interface SequenceDetailsProps {
  seqId: string;
  reloadToken: number;
  onBack: () => void;
  onToast: (msg: string, type?: string) => void;
  onEdit: (seq: Sequence) => void;
  onChanged: () => void;
  bumpReload: () => void;
}

function SequenceDetails({
  seqId,
  reloadToken,
  onBack,
  onToast,
  onEdit,
  onChanged,
  bumpReload,
}: SequenceDetailsProps) {
  const [detail, setDetail] = useState<SequenceDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'steps' | 'recipients' | 'activity' | 'settings'>(
    'overview',
  );

  const [recipients, setRecipients] = useState<SequenceRecipient[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsStepId, setRecipientsStepId] = useState<string>('');

  const [manualOpen, setManualOpen] = useState(false);
  const [manualStepId, setManualStepId] = useState<string>('');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingStep, setDeletingStep] = useState<string | null>(null);

  const [branchSteps, setBranchSteps] = useState<SequenceBranchStep[]>([]);
  const [branchStepsLoading, setBranchStepsLoading] = useState(true);
  const [branchStepsError, setBranchStepsError] = useState<string | null>(null);
  const [editingBranchStep, setEditingBranchStep] = useState<SequenceBranchStep | null>(null);
  const [branchStepSaving, setBranchStepSaving] = useState(false);

  const seq = detail?.seq || null;

  const loadDetail = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const [full, enrollments, logs] = await Promise.all([
          fetchSequence(seqId),
          fetchSequenceContacts(seqId),
          fetchSequenceLogs(seqId),
        ]);
        setDetail({ seq: full, enrollments: enrollments || [], logs: logs || [] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load sequence details';
        setError(msg);
        if (!opts?.silent) onToast('Failed to load sequence details: ' + msg, 'error');
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [seqId, onToast],
  );

  const loadBranchSteps = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setBranchStepsLoading(true);
      setBranchStepsError(null);
      try {
        const rows = await fetchBranchSteps(seqId);
        setBranchSteps(rows || []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load branch steps';
        setBranchStepsError(msg);
        if (!opts?.silent) onToast('Failed to load branch steps: ' + msg, 'error');
      } finally {
        if (!opts?.silent) setBranchStepsLoading(false);
      }
    },
    [seqId, onToast],
  );

  const loadRecipients = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setRecipientsLoading(true);
      try {
        const data = await fetchSequenceRecipients(seqId, recipientsStepId || undefined);
        setRecipients(data.recipients || []);
        if (data.step) setRecipientsStepId(data.step.id);
      } catch (err) {
        if (!opts?.silent) {
          onToast(
            'Failed to load recipients: ' + (err instanceof Error ? err.message : err),
            'error',
          );
        }
      } finally {
        if (!opts?.silent) setRecipientsLoading(false);
      }
    },
    [seqId, recipientsStepId, onToast],
  );

  const handleRecipientsStepChange = async (stepId: string) => {
    setRecipientsStepId(stepId);
    setRecipientsLoading(true);
    try {
      const data = await fetchSequenceRecipients(seqId, stepId);
      setRecipients(data.recipients || []);
    } catch (err) {
      onToast(
        'Failed to load recipients: ' + (err instanceof Error ? err.message : err),
        'error',
      );
    } finally {
      setRecipientsLoading(false);
    }
  };

  useEffect(() => {
    void loadDetail();
    void loadBranchSteps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, seqId]);

  // Live-ish engagement: re-check recipients every 15s while the details page
  // is open so opens/clicks reflect without a manual refresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDetail({ silent: true });
      void loadRecipients({ silent: true });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadRecipients]);

  const openManualSend = async () => {
    setManualOpen(true);
    setManualSelected(new Set());
    const steps = (seq && seq.steps) || [];
    const targetStepId = manualStepId || (steps.length > 0 ? steps[0].id : '');
    if (targetStepId) setManualStepId(targetStepId);
    setManualLoading(true);
    try {
      const data = await fetchSequenceRecipients(seqId, targetStepId || undefined);
      setRecipients(data.recipients || []);
    } catch (err) {
      onToast(
        'Failed to load recipients: ' + (err instanceof Error ? err.message : err),
        'error',
      );
    } finally {
      setManualLoading(false);
    }
  };

  const handleManualStepChange = async (stepId: string) => {
    setManualStepId(stepId);
    setManualSelected(new Set());
    setManualLoading(true);
    try {
      const data = await fetchSequenceRecipients(seqId, stepId);
      setRecipients(data.recipients || []);
    } catch (err) {
      onToast(
        'Failed to load recipients: ' + (err instanceof Error ? err.message : err),
        'error',
      );
    } finally {
      setManualLoading(false);
    }
  };

  const handleManualSend = async () => {
    if (sending || manualSelected.size === 0 || !manualStepId) return;
    setSending(true);
    try {
      const result = await manualSend(seqId, manualStepId, [...manualSelected]);
      const parts = [];
      if (result.sent > 0) parts.push(`sent ${result.sent}`);
      if (result.scheduled > 0) parts.push(`scheduled ${result.scheduled} not-opened`);
      if (result.skipped > 0) parts.push(`skipped ${result.skipped}`);
      const msg =
        parts.length > 0
          ? `${parts.join(', ')}.`
          : 'No emails sent (already sent or not eligible).';
      onToast(msg, result.sent > 0 ? 'success' : 'info');
      setManualOpen(false);
      setManualSelected(new Set());
      bumpReload();
      onChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to send', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleStatusChange = async () => {
    if (!seq || busyStatus) return;
    const isActive = seq.status === 'active';
    const isPaused = seq.status === 'paused';
    if (
      !window.confirm(
        `${isActive ? 'Pause' : isPaused ? 'Resume' : 'Activate'} sequence "${seq.name}"?`,
      )
    )
      return;
    setBusyStatus(true);
    try {
      if (isActive) {
        await pauseSequence(seq.id);
        onToast(`Sequence "${seq.name}" paused`, 'success');
      } else {
        await activateSequence(seq.id);
        onToast(
          isPaused ? `Sequence "${seq.name}" resumed` : `Sequence "${seq.name}" activated`,
          'success',
        );
      }
      bumpReload();
      onChanged();
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : `Failed to ${isActive ? 'pause' : 'activate'} sequence`,
        'error',
      );
    } finally {
      setBusyStatus(false);
    }
  };

  const handleDelete = async () => {
    if (!seq || deleting) return;
    if (!window.confirm(`Delete sequence "${seq.name}"? Its steps will also be deleted.`)) return;
    setDeleting(true);
    try {
      await deleteSequence(seq.id);
      onToast('Sequence deleted', 'info');
      onBack();
      onChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete sequence', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    if (!seq || deletingStep) return;
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;

    const children = steps.filter((s) => s.parent_step_id === stepId);
    let affected = 0;
    const queue = [stepId];
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) continue;
      affected += 1;
      for (const s of steps) if (s.parent_step_id === id) queue.push(s.id);
    }
    const isStarting = step.parent_step_id === null;
    const label = step.normal_subject || step.increment_subject || `Step ${step.step_number}`;

    const confirmLines = [
      isStarting
        ? 'This is the starting step. Deleting it will remove the whole sequence workflow.'
        : `Delete "${label}"? It will be removed from the sequence workflow.`,
    ];
    if (children.length > 0) {
      confirmLines.push(
        `It has ${children.length} child branch(es) and ${affected - 1} step(s) in total (including descendants) that will also be removed.`,
      );
    }
    confirmLines.push('Recipient send/tracking history is preserved. This cannot be undone.');
    if (!window.confirm(confirmLines.join('\n\n'))) return;

    setDeletingStep(stepId);
    try {
      const res = await deleteStep(seq.id, stepId, children.length > 0);
      onToast(
        res?.mode === 'archived'
          ? 'Step deleted — send history preserved'
          : 'Step deleted',
        'success',
      );
      bumpReload();
      onChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete step', 'error');
    } finally {
      setDeletingStep(null);
    }
  };

  const handleSaveBranchStep = async (payload: BranchStepInput) => {
    if (!editingBranchStep || branchStepSaving) return;
    setBranchStepSaving(true);
    try {
      await updateBranchStep(seqId, editingBranchStep.id, payload);
      onToast('Branch step updated', 'success');
      setEditingBranchStep(null);
      await loadBranchSteps();
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Failed to update branch step',
        'error',
      );
    } finally {
      setBranchStepSaving(false);
    }
  };

  const canManualSend = !!seq && seq.status === 'active' && seq.send_mode !== 'automatic';

  if (loading && !detail) {
    return (
      <div className="empty-state" style={{ padding: '40px' }}>
        <div className="empty-icon">⟳</div>
        <div className="empty-title">Loading sequence details…</div>
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="empty-state" style={{ padding: '40px' }}>
        <div className="empty-icon">⚠</div>
        <div className="empty-title">Could not load sequence details</div>
        <div className="empty-sub">{error}</div>
      </div>
    );
  }
  if (!seq) return null;

  const engagement = seq.engagement || { all: 0, opened: 0, not_opened: 0 };
  const summary = seq.summary || {
    total_eligible: 0,
    total: 0,
    in_progress: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  };
  const steps = seq.steps || [];
  const stepsProgress = seq.steps_progress || [];
  const currentStep = steps.find((s) => s.id === manualStepId) || steps[0] || null;

  const TABS: { key: typeof tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'steps', label: 'Steps' },
    { key: 'recipients', label: 'Recipients' },
    { key: 'activity', label: 'Activity' },
    { key: 'settings', label: 'Settings' },
  ];

  const recipientsStep = steps.find((s) => s.id === recipientsStepId) || steps[0] || null;
  const recipientsPath = recipientsStep
    ? (recipientsStep.parent_branch ?? 'STARTING')
    : 'STARTING';
  const recipientsEmpty =
    recipientsPath === 'OPENED'
      ? {
          title: 'No opened-branch recipients yet',
          sub: 'Recipients will appear here once they open the parent email of this step.',
        }
      : recipientsPath === 'NOT_OPENED'
        ? {
            title: 'No not-opened recipients yet',
            sub: 'Recipients will appear here once they receive but do not open the parent email of this step.',
          }
        : null;

    return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '18px' }}>
        <button
          className="btn btn-secondary btn-xs"
          style={{ marginBottom: '12px' }}
          onClick={onBack}
        >
          ‹ Back to sequences
        </button>

        <div className="seqdet-card seqdet-header">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
              <div className="seqdet-header-title">Sequence Details</div>
              <div className="seqdet-header-badges">
                <span className={`tag ${statusTagClass(seq.status)}`}>{seq.status}</span>
                <span className={`tag ${sendModeTagClass(seq.send_mode)}`}>
                  Send Mode: {sendModeLabel(seq.send_mode)}
                </span>
              </div>
            </div>
            <div className="seqdet-meta">
              <span>
                <strong>Target Audience:</strong> {seq.audience_segment || '—'}
              </span>
              <span>
                <strong>Trigger:</strong> {triggerTypeLabel(seq.trigger_type)}
              </span>
              <span>
                <strong>Created:</strong> {formatSequenceDate(seq.created_at)}
              </span>
            </div>
          </div>
          <div className="seqdet-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void handleStatusChange()}
              disabled={busyStatus || deleting}
            >
              {busyStatus ? 'Working…' : seq.status === 'active' ? 'Pause' : seq.status === 'paused' ? 'Resume' : 'Activate'}
            </button>
            {canManualSend && (
              <button className="btn btn-primary btn-sm" onClick={() => void openManualSend()}>
                Manual Send
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => onEdit(seq)} disabled={deleting}>
              Edit
            </button>
            <button
              className="btn btn-secondary btn-sm btn-danger"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Recipient Engagement cards */}
      <div className="seqdet-eng-grid">
        {[
          { label: 'All Recipients', value: engagement.all, tag: 'tag-oem', icon: '☰', tone: 'blue' },
          { label: 'Opened Email', value: engagement.opened, tag: 'tag-client', icon: '✓', tone: 'green' },
          { label: 'Not Opened Email', value: engagement.not_opened, tag: 'tag-draft', icon: '⊘', tone: 'slate' },
        ].map((card) => (
          <div key={card.label} className="seqdet-card seqdet-eng-card">
            <div className={`seqdet-eng-icon ${card.tone}`}>{card.icon}</div>
            <div className="seqdet-eng-body">
              <div className="seqdet-eng-label">Recipient Engagement</div>
              <div className="seqdet-eng-desc">{card.label}</div>
            </div>
            <div className="seqdet-eng-count">{card.value}</div>
            <span className={`tag ${card.tag} seqdet-eng-tag`}>{card.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <div className="seqdet-section-title">Sequence Summary</div>
            <div className="seqdet-summary-grid">
              {[
                { label: 'Total Eligible', value: summary.total_eligible, tone: 'dark', icon: '▣' },
                { label: 'Completed', value: summary.completed, tone: 'green', icon: '✓' },
                { label: 'In Progress', value: summary.in_progress, tone: 'blue', icon: '◐' },
                { label: 'Pending', value: summary.pending, tone: 'gray', icon: '▢' },
                { label: 'Failed', value: summary.failed, tone: 'red', icon: '⚠' },
              ].map((s) => (
                <div key={s.label} className="seqdet-card seqdet-stat">
                  <span className="seqdet-stat-label">
                    <span className="seqdet-stat-icon">{s.icon}</span>
                    <span className="seqdet-stat-name">{s.label}</span>
                  </span>
                  <span className={`seqdet-stat-value ${s.tone}`}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="seqdet-section-title">Step Progress</div>
            <div className="seqdet-table-wrap">
              <table className="seqdet-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Parent</th>
                    <th>Recipient Branch</th>
                    <th>Subject</th>
                    <th>Wait</th>
                    <th>Enrolled</th>
                    <th>Eligible</th>
                    <th>Sent</th>
                    <th>Opened</th>
                    <th>Failed</th>
                    <th>Pending</th>
                    <th>Clicked</th>
                    <th>Status</th>
                    <th>Next Emails</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stepsProgress.length === 0 ? (
                    <tr>
                      <td colSpan={15}>
                        <div className="empty-state" style={{ padding: '18px' }}>
                          <div className="empty-sub">No steps defined yet.</div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    stepsProgress.map((p) => (
                      <tr key={p.step.id}>
                        <td className="seqdet-step-name">
                          Step {p.step.step_number}
                          {p.step.parent_branch === 'NOT_OPENED' ? 'A' : ''}
                        </td>
                        <td className="seqdet-cell-muted">{p.parent_label || '—'}</td>
                        <td>
                          <span
                            className={`tag ${
                              p.path === 'OPENED'
                                ? 'tag-startup'
                                : p.path === 'NOT_OPENED'
                                  ? 'tag-oem'
                                  : 'tag-client'
                            }`}
                          >
                            {p.path_label || 'Starting'}
                          </span>
                        </td>
                        <td className="seqdet-subject" style={{ color: 'var(--text3)' }}>
                          {p.subject || '—'}
                        </td>
                        <td className="seqdet-cell-muted">{p.wait_label || '—'}</td>
                        <td className="seqdet-cell-value">{p.enrolled ?? '—'}</td>
                        <td className="seqdet-cell-value">{p.eligible}</td>
                        <td className="seqdet-cell-value">{p.sent}</td>
                        <td className="seqdet-cell-value">{p.opened}</td>
                        <td className={`seqdet-cell-value ${p.failed > 0 ? 'red' : ''}`}>
                          {p.failed}
                        </td>
                        <td className="seqdet-cell-value gray">{p.pending}</td>
                        <td className="seqdet-cell-value">{p.clicked}</td>
                        <td>
                          <span
                            className={`tag ${
                              p.status === 'completed'
                                ? 'tag-startup'
                                : p.status === 'in_progress'
                                  ? 'tag-client'
                                  : 'tag-draft'
                            }`}
                          >
                            {p.status === 'completed'
                              ? 'Completed'
                              : p.status === 'in_progress'
                                ? 'In progress'
                                : 'Not started'}
                          </span>
                        </td>
                        <td>
                          {p.next && p.next.length > 0 ? (
                            <div className="seqdet-next-pills">
                              {p.next.map((n) => (
                                <span
                                  key={`${n.step_number}-${n.branch}`}
                                  className={`seqdet-pill ${n.branch === 'NOT_OPENED' ? 'purple' : 'blue'}`}
                                >
                                  Step {n.step_number}
                                  {n.branch === 'NOT_OPENED' ? 'A' : ''} · {n.label}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="seqdet-cell-muted">—</span>
                          )}
                        </td>
                        <td>
                          {(() => {
                            const st = p.step;
                            const deletable =
                              st.parent_step_id !== null ||
                              (steps.length === 1 && seq.status === 'draft');
                            if (!deletable) return null;
                            return (
                              <button
                                className="btn-icon"
                                title="Delete step"
                                aria-label={`Delete step ${st.step_number}`}
                                onClick={() => void handleDeleteStep(st.id)}
                                disabled={deletingStep !== null}
                              >
                                🗑️
                              </button>
                            );
                          })()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── STEPS ── */}
      {tab === 'steps' && (
        <div>
          <div className="seqdet-toolbar">
            <div className="seqdet-section-title" style={{ marginBottom: 0 }}>
              Drip Steps Workflow
            </div>
            <button className="btn btn-secondary btn-xs" onClick={() => onEdit(seq)}>
              + Add / Edit Steps
            </button>
          </div>
          {steps.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px' }}>
              <div className="empty-sub">No steps defined yet — edit this sequence to add steps.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {steps.map((st) => (
                <div key={st.id} className="seqdet-card" style={{ padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div className="seqdet-step-num">
                      {st.step_number}
                      {st.parent_branch === 'NOT_OPENED' ? 'A' : ''}
                    </div>
                    <div className="seqdet-step-body">
                      <div className="seqdet-step-title">
                        {st.normal_subject || st.increment_subject || 'Untitled step'}
                      </div>
                      <div className="seqdet-step-sub">
                        Wait: {st.wait_hours} hour{st.wait_hours === 1 ? '' : 's'}
                        {st.from_name ? ` · From: ${st.from_name}` : ''}
                      </div>
                    </div>
                    <span className={`tag ${st.parent_branch === 'NOT_OPENED' ? 'tag-oem' : 'tag-client'}`}>
                      {stepParentLabel(st, steps)}
                    </span>
                    {(() => {
                      const deletable =
                        st.parent_step_id !== null ||
                        (steps.length === 1 && seq.status === 'draft');
                      if (!deletable) return null;
                      return (
                        <button
                          className="btn-icon"
                          title="Delete step"
                          aria-label={`Delete step ${st.step_number}`}
                          onClick={() => void handleDeleteStep(st.id)}
                          disabled={deletingStep !== null}
                        >
                          🗑️
                        </button>
                      );
                    })()}
                  </div>
                  <div className="seqdet-step-content">
                    {st.parent_branch === 'NOT_OPENED' ? (
                      <>
                        <div className="seqdet-step-content-label">
                          EMAIL TO SEND — increment variant, scheduled after {st.wait_hours}h if the
                          parent email has not been opened
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>
                          {st.increment_subject ? (
                            <>
                              <strong>{st.increment_subject}</strong>
                              <br />
                              {st.increment_body || '—'}
                            </>
                          ) : (
                            '—'
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="seqdet-step-content-label">
                          NORMAL / OPENED — sent when the recipient opens this node's parent email
                          (the starting node sends to every enrolled recipient)
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>
                          {st.normal_subject ? (
                            <>
                              <strong>{st.normal_subject}</strong>
                              <br />
                              {st.normal_body || '—'}
                            </>
                          ) : (
                            '—'
                          )}
                        </div>
                        <div className="seqdet-step-content-label" style={{ marginTop: '8px' }}>
                          NOT OPENED / INCREMENT — scheduled after {st.wait_hours}h if the parent
                          email has not been opened
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>
                          {st.increment_subject ? (
                            <>
                              <strong>{st.increment_subject}</strong>
                              <br />
                              {st.increment_body || '—'}
                            </>
                          ) : (
                            '—'
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── BRANCH STEPS (sequence_branch_steps) ── */}
          <div style={{ marginTop: '22px' }}>
            <div className="seqdet-toolbar">
              <div className="seqdet-section-title" style={{ marginBottom: 0 }}>
                Branch Steps — same records used by the Edit Sequence form
              </div>
              <div className="seqdet-cell-muted">
                Flat projection of the step tree (sequence_branch_steps)
              </div>
            </div>
            {branchStepsLoading ? (
              <div className="empty-state" style={{ padding: '20px' }}>
                <div className="empty-sub">Loading branch steps…</div>
              </div>
            ) : branchStepsError ? (
              <div className="empty-state" style={{ padding: '20px' }}>
                <div className="empty-sub">{branchStepsError}</div>
              </div>
            ) : branchSteps.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px' }}>
                <div className="empty-sub">No branch-step records for this sequence.</div>
              </div>
            ) : (
              <div className="seqdet-table-wrap">
                <table className="seqdet-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Parent</th>
                      <th>Branch</th>
                      <th>Subject</th>
                      <th>Wait</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branchSteps.map((row) => (
                      <tr key={row.id}>
                        <td className="seqdet-step-name">{branchStepNodeLabel(row)}</td>
                        <td className="seqdet-cell-muted">
                          {branchStepParentLabel(row, branchSteps)}
                        </td>
                        <td>
                          <span
                            className={`tag ${branchStepBranchTagClass(row.parent_branch)}`}
                          >
                            {branchStepBranchLabel(row.parent_branch)}
                          </span>
                        </td>
                        <td
                          className="seqdet-subject"
                          style={{ maxWidth: '260px', color: 'var(--text3)' }}
                        >
                          {row.subject || '—'}
                        </td>
                        <td className="seqdet-cell-muted">
                          {branchStepWaitLabel(row.wait_hours)}
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => setEditingBranchStep(row)}
                            disabled={branchStepSaving}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── RECIPIENTS ── */}
      {tab === 'recipients' && (
        <div>
          <div className="seqdet-toolbar">
            <div className="seqdet-section-title" style={{ marginBottom: 0 }}>
              Recipients ({recipients.length})
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {steps.length > 0 && (
                <div className="form-group" style={{ marginBottom: '0', minWidth: '240px' }}>
                  <select
                    value={recipientsStep ? recipientsStep.id : ''}
                    onChange={(e) => void handleRecipientsStepChange(e.target.value)}
                  >
                    {steps.map((s) => (
                      <option key={s.id} value={s.id}>
                        Step {s.step_number} · {stepPathLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {canManualSend && (
                <button className="btn btn-primary btn-xs" onClick={() => void openManualSend()}>
                  Manual Send
                </button>
              )}
            </div>
          </div>
          {recipientsLoading ? (
            <div className="empty-state" style={{ padding: '24px' }}>
              <div className="empty-icon">⟳</div>
              <div className="empty-title">Loading recipients…</div>
            </div>
          ) : recipients.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px' }}>
              <div className="empty-icon">✉</div>
              <div className="empty-title">
                {recipientsEmpty ? recipientsEmpty.title : 'No eligible recipients'}
              </div>
              {recipientsEmpty && <div className="empty-sub">{recipientsEmpty.sub}</div>}
            </div>
          ) : (
            <div className="seqdet-table-wrap">
              <table className="seqdet-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Email Status</th>
                    <th>Opened</th>
                    <th>Clicked</th>
                    <th>Last Activity</th>
                    <th>Sequence Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.contact.id}>
                      <td style={{ fontSize: '12.5px', fontWeight: 600 }}>
                        {r.contact.full_name || '—'}
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text3)' }}>
                        {r.contact.email || '—'}
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text3)' }}>
                        {r.contact.company || '—'}
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            r.email_status === 'sent'
                              ? 'tag-startup'
                              : r.email_status === 'failed'
                                ? 'tag-draft'
                                : r.email_status === 'pending'
                                  ? 'tag-oem'
                                  : 'tag-draft'
                          }`}
                        >
                          {r.email_status || '—'}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            r.opened === true ? 'tag-startup' : r.opened === false ? 'tag-draft' : 'tag-draft'
                          }`}
                        >
                          {r.opened === true
                            ? `Opened${r.opened_at ? ` · ${formatSequenceDate(r.opened_at)}` : ''}`
                            : r.opened === false
                              ? 'Not Opened'
                              : '—'}
                        </span>
                      </td>
                      <td>
                        <span className={`tag ${r.clicked === true ? 'tag-oem' : 'tag-draft'}`}>
                          {r.clicked === true ? 'Clicked' : r.clicked === false ? 'No click' : '—'}
                        </span>
                      </td>
                      <td style={{ fontSize: '12px', color: 'var(--text4)' }}>
                        {formatSequenceDate(r.last_activity)}
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            String(r.sequence_status || '').toLowerCase().includes('completed')
                              ? 'tag-startup'
                              : r.sequence_status && r.sequence_status !== 'not_enrolled'
                                ? 'tag-client'
                                : 'tag-draft'
                          }`}
                        >
                          {r.sequence_status || '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── ACTIVITY ── */}
      {tab === 'activity' && (
        <div>
          <div className="seqdet-section-title">
            Sent Step Logs ({detail?.logs.length ?? 0})
          </div>
          {(detail?.logs.length ?? 0) === 0 ? (
            <div className="empty-state" style={{ padding: '24px' }}>
              <div className="empty-sub">No emails have been sent from this sequence yet.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {detail?.logs.map((log) => (
                <div key={log.id} className="seqdet-log-row">
                  <div style={{ fontWeight: 600, minWidth: '150px' }}>
                    {log.contact?.full_name || log.contact?.email || '—'}
                  </div>
                  <div
                    style={{
                      color: 'var(--text4)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Step {log.step?.step_number ?? '—'}: {log.step?.display_subject || '—'}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text4)', fontFamily: 'var(--mono)' }}>
                    {formatSequenceDate(log.sent_at)}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <span className={`tag ${log.opened ? 'tag-client' : 'tag-draft'}`}>
                      {log.opened ? 'Opened' : 'Unopened'}
                    </span>
                    <span className={`tag ${log.clicked ? 'tag-oem' : 'tag-draft'}`}>
                      {log.clicked ? 'Clicked' : 'No click'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SETTINGS ── */}
      {tab === 'settings' && (
        <div style={{ maxWidth: '640px' }}>
          <div className="seqdet-section-title">Configuration</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { label: 'Sequence Name', value: seq.name || '—' },
              { label: 'Target Audience', value: seq.audience_segment || '—' },
              { label: 'Trigger Type', value: triggerTypeLabel(seq.trigger_type) },
              ...(steps.length > 0
                ? steps.map((st) => ({
                    label: `Step ${st.step_number} · Recipient Branch`,
                    value: stepPathLabel(st),
                  }))
                : [{ label: 'Recipient Branch', value: 'Configured per step' }]),
              { label: 'Send Mode', value: sendModeLabel(seq.send_mode) },
              { label: 'Status', value: seq.status || '—' },
              { label: 'Created At', value: formatSequenceDate(seq.created_at) },
              { label: 'Updated At', value: formatSequenceDate(seq.updated_at) },
            ].map((row) => (
              <div key={row.label} className="seqdet-settings-row">
                <span className="seqdet-settings-label">{row.label}</span>
                <span className="seqdet-settings-value">{row.value}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '14px' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onEdit(seq)}>
              Edit Sequence
            </button>
          </div>
        </div>
      )}

      {/* Manual send modal */}
      {manualOpen && (
        <ManualSendModal
          seq={seq}
          recipients={recipients}
          step={currentStep}
          steps={steps}
          loading={manualLoading}
          selected={manualSelected}
          onToggle={(contactId) =>
            setManualSelected((prev) => {
              const next = new Set(prev);
              if (next.has(contactId)) next.delete(contactId);
              else next.add(contactId);
              return next;
            })
          }
          onSelectAll={(ids) => setManualSelected(new Set(ids))}
          onClearAll={() => setManualSelected(new Set())}
          onStepChange={(stepId) => void handleManualStepChange(stepId)}
          onSend={() => void handleManualSend()}
          onClose={() => setManualOpen(false)}
          sending={sending}
        />
      )}

      {/* Branch step edit modal */}
      {editingBranchStep && (
        <BranchStepEditModal
          row={editingBranchStep}
          saving={branchStepSaving}
          onSave={(payload) => void handleSaveBranchStep(payload)}
          onClose={() => setEditingBranchStep(null)}
        />
      )}
    </div>
  );
}

// ─── SEQUENCES TAB (LIST + CREATE/EDIT) ────────────────────────────────────

export default function SequencesTab({ onPersistSequences, onToast }: SequencesTabProps) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audienceOptions, setAudienceOptions] = useState<AudienceOption[]>([]);

  const [viewSeqId, setViewSeqId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Sequence | null>(null);
  const [saving, setSaving] = useState(false);
  const [delBusyId, setDelBusyId] = useState<string | null>(null);
  const [actBusyId, setActBusyId] = useState<string | null>(null);
  const [enrollBusyId, setEnrollBusyId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    'all' | 'active' | 'completed' | 'draft' | 'paused' | 'archived'
  >('all');
  /** Enriched per-sequence overviews (summary / steps / engagement) for the cards. */
  const [overviewMap, setOverviewMap] = useState<Record<string, Sequence>>({});
  /** Id of the sequence whose steps are currently expanded (only one at a time). */
  const [expandedSeqId, setExpandedSeqId] = useState<string | null>(null);

  const [fName, setFName] = useState('');
  const [fAudience, setFAudience] = useState('');
  /** Live count of contacts that match the currently selected target audience. */
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [audienceCountLoading, setAudienceCountLoading] = useState(false);
  const [fTrigger, setFTrigger] = useState<'manual' | 'time_based' | 'behaviour'>('manual');
  const [fRecipientType, setFRecipientType] = useState<RecipientType>('all');
  const [fSendMode, setFSendMode] = useState<SendMode>('both');
  const [stepDrafts, setStepDrafts] = useState<StepDraft[]>([newStepDraft()]);
  // ─── BATCH SENDING STATE (mirrors Campaigns / Follow-ups UI) ───
  const [sendInBatches, setSendInBatches] = useState(false);
  const [batchSize, setBatchSize] = useState(30);
  const [batchDelayHours, setBatchDelayHours] = useState(1);

  const DELAY_OPTIONS = [
    { value: 5 / 60, label: '5 Minutes' },
    { value: 10 / 60, label: '10 Minutes' },
    { value: 0.25, label: '15 Minutes' },
    { value: 0.5, label: '30 Minutes' },
    { value: 1, label: '1 Hour' },
    { value: 2, label: '2 Hours' },
    { value: 4, label: '4 Hours' },
    { value: 8, label: '8 Hours' },
    { value: 24, label: '24 Hours' },
  ];

  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | SendMode>('all');

  // ─── LOAD TEMPLATE (per step/branch) ───
  // All templates from `public.templates` shared by every step's Load Template
  // dropdown. Selection/loading/error live on each StepDraft branch so one
  // step's template choice never affects another step.
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const { data, error } = await fetchTemplates();
      if (error) {
        setTemplates([]);
        onToast('Failed to load templates: ' + error, 'error');
      } else {
        const loaded = data || [];
        setTemplates(loaded);
        // Re-associate existing drafts whose saved Body is a template's HTML:
        // set the template id (dropdown shows the name) and mark the HTML as
        // internal so the editor renders the template instead of showing raw
        // HTML in the Body textarea. Best-effort exact match.
        if (loaded.length > 0) {
          const normalized = (value: string) => String(value || '').trim();
          setStepDrafts((prev) =>
            prev.map((d) => {
              let next = d;
              let changed = false;
              if (!next.normal_template_id && next.normal_body) {
                const match = loaded.find(
                  (t) => normalized(t.body) === normalized(next.normal_body),
                );
                if (match) {
                  next = {
                    ...next,
                    normal_template_id: match.id,
                    normal_template_html: next.normal_body,
                    normal_manual_body: '',
                  };
                  changed = true;
                }
              }
              if (!next.increment_template_id && next.increment_body) {
                const match = loaded.find(
                  (t) => normalized(t.body) === normalized(next.increment_body),
                );
                if (match) {
                  next = {
                    ...next,
                    increment_template_id: match.id,
                    increment_template_html: next.increment_body,
                    increment_manual_body: '',
                  };
                  changed = true;
                }
              }
              return changed ? next : d;
            }),
          );
        }
      }
    } finally {
      setTemplatesLoading(false);
    }
  }, [onToast]);

  /**
   * Load a selected template into ONE branch of ONE step draft (independent of
   * every other step/branch). The Subject Line is never touched by template
   * selection — it is always typed manually by the user.
   *
   *  - database templates use their existing `body`.
   *  - storage templates fetch the HTML from Supabase Storage (public URL built
   *    from the row's storage_bucket / storage_path) and use the returned HTML
   *    as the body — never stripped to plain text, never replaced with
   *    `undefined`/`null`/an empty string.
   *
   * On failure the previous subject/body stay untouched and the branch shows a
   * clear error while the modal keeps working.
   */
  const applyTemplateToBranch = useCallback(
    async (templateId: string, branch: 'normal' | 'increment', draftKey: string) => {
      const template = templates.find((t) => t.id === templateId);
      if (!template) return;

      // The raw HTML stays INTERNAL (saved for sending) and is rendered as a
      // preview — it is never shown inside the editable Body textarea. The
      // plain-text body typed before the template was applied is kept aside so
      // deselecting the template restores it.
      const captureManual = (s: StepDraft): Partial<StepDraft> =>
        branch === 'normal'
          ? {
              normal_template_id: templateId,
              normal_loading: true,
              normal_error: null,
              normal_manual_body: s.normal_template_id ? s.normal_manual_body : s.normal_body,
            }
          : {
              increment_template_id: templateId,
              increment_loading: true,
              increment_error: null,
              increment_manual_body: s.increment_template_id
                ? s.increment_manual_body
                : s.increment_body,
            };

      setStepDrafts((prev) =>
        prev.map((s) => (s.draftKey === draftKey ? { ...s, ...captureManual(s) } : s)),
      );

      try {
        let body: string;
        if (template.template_source === 'storage') {
          if (!template.storage_bucket || !template.storage_path) {
            throw new Error(`Template '${template.name}' is missing a storage bucket or file path.`);
          }
          const { data } = supabase.storage
            .from(template.storage_bucket)
            .getPublicUrl(template.storage_path);
          if (!data?.publicUrl) {
            throw new Error('Could not resolve the template file URL.');
          }
          const response = await fetch(data.publicUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch template file (HTTP ${response.status}).`);
          }
          body = await response.text();
        } else {
          body = template.body || '';
        }
        if (!String(body).trim()) {
          throw new Error(`Template '${template.name}' has an empty body.`);
        }
        if (branch === 'normal') {
          setStepDrafts((prev) =>
            prev.map((s) =>
              s.draftKey === draftKey
                ? {
                    ...s,
                    normal_body: body,
                    normal_template_html: body,
                    normal_loading: false,
                    normal_error: null,
                  }
                : s,
            ),
          );
        } else {
          setStepDrafts((prev) =>
            prev.map((s) =>
              s.draftKey === draftKey
                ? {
                    ...s,
                    increment_body: body,
                    increment_template_html: body,
                    increment_loading: false,
                    increment_error: null,
                  }
                : s,
            ),
          );
        }
        onToast(`Template '${template.name}' loaded successfully.`, 'success');
      } catch (err) {
        if (branch === 'normal') {
          setStepDrafts((prev) =>
            prev.map((s) =>
              s.draftKey === draftKey
                ? {
                    ...s,
                    normal_loading: false,
                    normal_error: err instanceof Error ? err.message : 'Failed to load template.',
                  }
                : s,
            ),
          );
        } else {
          setStepDrafts((prev) =>
            prev.map((s) =>
              s.draftKey === draftKey
                ? {
                    ...s,
                    increment_loading: false,
                    increment_error: err instanceof Error ? err.message : 'Failed to load template.',
                  }
                : s,
            ),
          );
        }
      }
    },
    [templates, onToast],
  );

  /**
   * Deselect the template for ONE branch of ONE step draft: the previously
   * typed plain-text Body is restored and the raw template HTML is no longer
   * referenced. Nothing is saved to the database by this — the change only
   * affects what the modal shows and what gets persisted on the next save.
   */
  const clearTemplateFromBranch = useCallback((branch: 'normal' | 'increment', draftKey: string) => {
    setStepDrafts((prev) =>
      prev.map((s) =>
        s.draftKey === draftKey
          ? branch === 'normal'
            ? {
                ...s,
                normal_template_id: '',
                normal_template_html: '',
                normal_body: s.normal_manual_body,
                normal_manual_body: '',
              }
            : {
                ...s,
                increment_template_id: '',
                increment_template_html: '',
                increment_body: s.increment_manual_body,
                increment_manual_body: '',
              }
          : s,
      ),
    );
  }, []);

  /**
   * Add files to ONE branch of ONE step draft (independent of every other
   * step/branch). Files are uploaded to Storage right away — directly into the
   * branch node's folder when the node is already persisted (editing), or to a
   * temporary path otherwise (brand-new step; the metadata row is inserted when
   * the step is saved). `editing.id` (the sequence id) is the storage folder
   * prefix for persisted nodes.
   */
  const handleAddStepAttachments = useCallback(
    async (files: FileList | null, branch: 'normal' | 'increment', draftKey: string) => {
      if (!files || files.length === 0) return;
      const draft = stepDrafts.find((s) => s.draftKey === draftKey);
      if (!draft) return;
      const nodeId = branch === 'normal' ? draft.id : draft.notOpenedId;

      const patchDraft = (patch: Partial<StepDraft>) =>
        setStepDrafts((prev) =>
          prev.map((s) => (s.draftKey === draftKey ? { ...s, ...patch } : s)),
        );

      if (branch === 'normal') {
        patchDraft({ normal_attachments_uploading: true, normal_attachments_error: null });
      } else {
        patchDraft({ increment_attachments_uploading: true, increment_attachments_error: null });
      }

      try {
        for (const file of Array.from(files)) {
          const uploaded = await uploadStepAttachment(file, editing ? editing.id : null, nodeId);
          if (branch === 'normal') {
            setStepDrafts((prev) =>
              prev.map((s) =>
                s.draftKey === draftKey
                  ? { ...s, normal_attachments: [...s.normal_attachments, uploaded] }
                  : s,
              ),
            );
          } else {
            setStepDrafts((prev) =>
              prev.map((s) =>
                s.draftKey === draftKey
                  ? { ...s, increment_attachments: [...s.increment_attachments, uploaded] }
                  : s,
              ),
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to upload attachment';
        if (branch === 'normal') {
          patchDraft({ normal_attachments_uploading: false, normal_attachments_error: message });
        } else {
          patchDraft({ increment_attachments_uploading: false, increment_attachments_error: message });
        }
        onToast(message, 'error');
        return;
      }

      if (branch === 'normal') {
        patchDraft({ normal_attachments_uploading: false });
      } else {
        patchDraft({ increment_attachments_uploading: false });
      }
    },
    [editing, stepDrafts, onToast],
  );

  /** Remove one file from a step branch: deletes Storage + metadata row. */
  const handleRemoveStepAttachment = useCallback(
    async (attachment: SequenceAttachment, branch: 'normal' | 'increment', draftKey: string) => {
      const { error } = await removeStepAttachment(attachment);
      if (error) {
        onToast(error, 'error');
        return;
      }
      setStepDrafts((prev) =>
        prev.map((s) =>
          s.draftKey === draftKey
            ? branch === 'normal'
              ? {
                  ...s,
                  normal_attachments: s.normal_attachments.filter(
                    (a) => a.storage_path !== attachment.storage_path,
                  ),
                }
              : {
                  ...s,
                  increment_attachments: s.increment_attachments.filter(
                    (a) => a.storage_path !== attachment.storage_path,
                  ),
                }
            : s,
        ),
      );
    },
    [onToast],
  );

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const [seqs, auds] = await Promise.all([
        fetchSequences(),
        fetchAudienceOptions(),
      ]);
      setSequences(seqs || []);
      onPersistSequences(seqs || []);
      setAudienceOptions(auds || []);
      // Enrich each card with the real overview (summary/steps/engagement) via
      // the existing detail endpoint — every stat shown is read from the DB.
      setOverviewMap({});
      if (seqs && seqs.length > 0) {
        const settled = await Promise.allSettled(
          seqs.map(async (s) => [s.id, await fetchSequence(s.id)] as const),
        );
        const map: Record<string, Sequence> = {};
        for (const r of settled) {
          if (r.status === 'fulfilled') map[r.value[0]] = r.value[1];
        }
        setOverviewMap(map);
      }
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load sequences');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [onPersistSequences]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live preview of how many contacts the selected Target Audience will enroll.
  // Derived straight from the Contacts table (contact_type), so it always
  // matches what activation/enrollment actually does — and shows the required
  // "No contacts found" message when the segment is empty.
  useEffect(() => {
    if (!modalOpen) return;
    if (!fAudience) {
      setAudienceCount(null);
      setAudienceCountLoading(false);
      return;
    }
    let cancelled = false;
    setAudienceCountLoading(true);
    void countContactsForAudience(fAudience)
      .then((count) => {
        if (!cancelled) setAudienceCount(count);
      })
      .catch(() => {
        if (!cancelled) setAudienceCount(null);
      })
      .finally(() => {
        if (!cancelled) setAudienceCountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fAudience, modalOpen]);

  // Latest wall-clock used to decide Scheduled (future next_run_at) vs Sending
  // (due now) from a state value instead of calling an impure function during
  // render. Refreshed on every poll tick.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Poll the list so each card's schedule status (Scheduled / Sending / Sent /
  // Completed) reflects the worker's real database writes after the cron runs,
  // without relying on a manual refresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
      void load({ silent: true });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const bumpReload = useCallback(() => setReloadToken((t) => t + 1), []);

  const filteredSequences = useMemo(() => {
    let list = sequences;
    if (activeTab === 'completed') {
      // The Completed tab must return exactly the sequences whose cards show
      // "✓ Completed" (see isSequenceCompleted), evaluated against the enriched
      // overview state (summary / active_count / last_sent_at) — never the raw
      // `sequences.status` column, which is only draft/active/paused.
      list = list.filter((s) => isSequenceCompleted(overviewMap[s.id] || s));
    } else if (activeTab !== 'all') {
      list = list.filter((s) => s.status === activeTab);
    }
    if (filterMode !== 'all') {
      list = list.filter((s) => s.send_mode === filterMode);
    }
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          (s.name || '').toLowerCase().includes(q) ||
          (s.audience_segment || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [sequences, overviewMap, activeTab, filterMode, searchTerm]);

  /** Aggregate overview stats for the top cards, read from the same DB-backed
   *  overview data used by the sequence rows (never hardcoded). */
  const stats = useMemo(() => {
    let enrolled = 0;
    let completed = 0;
    let opened = 0;
    let all = 0;
    let steps = 0;
    for (const s of sequences) {
      const overview = overviewMap[s.id] || s;
      const sum = overview.summary;
      if (sum) {
        enrolled += sum.total || 0;
        completed += sum.completed || 0;
      }
      const eng = overview.engagement;
      if (eng) {
        opened += eng.opened || 0;
        all += eng.all || 0;
      }
      const stepsArr = overview.steps && overview.steps.length > 0 ? overview.steps : [];
      steps += stepsArr.length || overview.steps_count || 0;
    }
    return {
      total: sequences.length,
      active: sequences.filter((s) => s.status === 'active').length,
      enrolled,
      completed,
      openRate: all > 0 ? `${Math.round((opened / all) * 100)}%` : '0%',
      opened,
      all,
      steps,
    };
  }, [sequences, overviewMap]);

  const openCreate = () => {
    setEditing(null);
    setFName('');
    setFAudience('');
    setFTrigger('manual');
    setFRecipientType('all');
    setFSendMode('both');
    setStepDrafts([newStepDraft()]);
    setSendInBatches(false);
    setBatchSize(30);
    setBatchDelayHours(1);
    void loadTemplates();
    setModalOpen(true);
  };

  const openEdit = async (seq: Sequence) => {
    // Some entry points (e.g. the list card) only hold the summary row without
    // steps. Fetch the full detail so every saved step/parent/branch/content
    // is loaded into the form instead of opening with an empty default.
    let source = seq;
    if (!source.steps || source.steps.length === 0) {
      try {
        source = await fetchSequence(seq.id);
      } catch {
        source = seq;
      }
    }
    setEditing(seq);
    setFName(source.name);
    setFAudience(source.audience_segment || '');
    setFTrigger(source.trigger_type);
    setFRecipientType(source.recipient_type || 'all');
    setFSendMode(source.send_mode || 'both');
    setSendInBatches(!!source.batch_enabled);
    setBatchSize(Number(source.batch_size) > 0 ? Number(source.batch_size) : 30);
    setBatchDelayHours(
      Number(source.subsequent_batch_delay_hours) >= 0
        ? Number(source.subsequent_batch_delay_hours)
        : 1,
    );
    let existing = source.steps && source.steps.length > 0 ? source.steps.map(stepToDraft) : [];
    // Pair each Not Opened branch node with its Opened sibling (same parent
    // node + same step number) so one card edits BOTH branches: the increment
    // content and both persisted node ids are folded into a single draft.
    const consumed = new Set<string>();
    for (const d of existing) {
      if (d.parent_branch !== 'NOT_OPENED' || !d.id) continue;
      // The card's Opened + Not Opened nodes share the same parent_step_id
      // (both hang off the branch node the card targets), so they pair up.
      const partner = existing.find(
        (x) =>
          x.id !== d.id &&
          x.id != null &&
          x.parent_branch === 'OPENED' &&
          x.parent_step_id === d.parent_step_id &&
          Number(x.step_number) === Number(d.step_number),
      );
      if (partner) {
        partner.increment_subject = d.increment_subject;
        partner.increment_body = d.increment_body;
        partner.wait_hours = d.wait_hours;
        partner.notOpenedId = d.id;
        consumed.add(d.id);
      }
    }
    existing = existing.filter((d) => !(d.id && consumed.has(d.id)));
    // Point each persisted draft at its parent via draftKey (in-list), so the
    // dropdown value and the save-time resolution both use the stable key.
    for (const d of existing) {
      if (d.id && d.parent_step_id) {
        const parent = existing.find((x) => x.id === d.parent_step_id);
        if (parent) d.parent_key = parent.draftKey;
      }
    }
    // Restore the saved subject/body from the sequence_branch_steps table
    // (keyed by step number + branch). Each card holds two branch rows — the
    // OPENED/STARTING row fills the normal content, the NOT_OPENED row fills
    // the increment content. Fall back to the sequence_steps values already
    // loaded when the branch table has no row for a step.
    try {
      const branchRows = await fetchBranchSteps(seq.id);
      const byKey = new Map<string, SequenceBranchStep>();
      for (const r of branchRows || []) byKey.set(`${r.step}:${r.parent_branch}`, r);
      for (const d of existing) {
        const n = Number(d.step_number);
        if (!Number.isFinite(n) || !n) continue;
        const opened = byKey.get(`${n}:OPENED`) || byKey.get(`${n}:STARTING`);
        const notOpened = byKey.get(`${n}:NOT_OPENED`);
        if (opened) {
          d.normal_subject = opened.subject;
          d.normal_body = opened.body;
        }
        if (notOpened) {
          d.increment_subject = notOpened.subject;
          d.increment_body = notOpened.body;
        }
      }
    } catch {
      // Branch table unavailable — keep the values loaded from sequence_steps.
    }
    setStepDrafts(existing.length > 0 ? existing : [newStepDraft()]);
    void loadTemplates();
    // Load the saved attachments for every persisted branch node (best-effort):
    // the OPENED/starting node id (draft.id) fills normal_attachments and the
    // NOT OPENED node id (draft.notOpenedId) fills increment_attachments.
    const nodeAttachmentPairs: Array<{ stepId: string; branch: 'normal' | 'increment'; draftKey: string }> = [];
    for (const d of existing) {
      if (d.id) nodeAttachmentPairs.push({ stepId: d.id, branch: 'normal', draftKey: d.draftKey });
      if (d.notOpenedId) {
        nodeAttachmentPairs.push({ stepId: d.notOpenedId, branch: 'increment', draftKey: d.draftKey });
      }
    }
    void Promise.all(
      nodeAttachmentPairs.map(async ({ stepId, branch, draftKey }) => {
        const { data, error: attErr } = await fetchStepAttachments(stepId);
        if (attErr) {
          onToast('Failed to load attachments: ' + attErr, 'error');
          return;
        }
        setStepDrafts((prev) =>
          prev.map((s) =>
            s.draftKey === draftKey
              ? branch === 'normal'
                ? { ...s, normal_attachments: data || [] }
                : { ...s, increment_attachments: data || [] }
              : s,
          ),
        );
      }),
    );
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!fName.trim()) {
      onToast('Sequence name is required', 'error');
      return;
    }
    if (!fAudience) {
      onToast('Select a target audience', 'error');
      return;
    }
    const validDrafts = stepDrafts.filter(
      (s) =>
        s.normal_subject.trim() ||
        s.normal_body.trim() ||
        s.increment_subject.trim() ||
        s.increment_body.trim(),
    );
    if (validDrafts.length === 0) {
      onToast('Add at least one step', 'error');
      return;
    }
    setSaving(true);
    try {
      const configPayload = {
        name: fName.trim(),
        audience_segment: fAudience,
        trigger_type: fTrigger,
        recipient_type: fRecipientType,
        send_mode: fSendMode,
        // Batch sending configuration (shared config, per-step runtime; mirrors
        // the Campaigns / Follow-ups batching UI fields).
        batch_enabled: sendInBatches,
        batch_size: sendInBatches ? batchSize : undefined,
        first_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
        subsequent_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
      } as SequenceInput;
      let sequenceId: string;
      if (editing) {
        await updateSequence(editing.id, configPayload);
        sequenceId = editing.id;
      } else {
        const created = await createSequence(configPayload);
        sequenceId = created.id;
      }

      // Parent-node id resolution: parents are always created/saved before
      // their children (list order), so by the time a step is persisted, its
      // parent's id is known — either from the DB (existing step) or from the
      // createStep response of a new sibling created earlier (idByKey).
      // Display step numbers become a depth: starting node = 1, children of a
      // node = parent's number + 1, so sibling nodes share the same number.
      //
      // Every non-root card persists TWO branch nodes: the Opened node (normal
      // content, wait 0) and the Not Opened node (increment content, wait =
      // the card's wait hours). Both rows then show up in Step Progress.
      const idByKey: Record<string, string> = {};
      const notOpenedIdByKey: Record<string, string> = {};
      const stepNumberByKey: Record<string, number> = {};
      for (const draft of stepDrafts) {
        const hasNormal = draft.normal_subject.trim() || draft.normal_body.trim();
        const hasIncrement = draft.increment_subject.trim() || draft.increment_body.trim();
        if (!hasNormal && !hasIncrement) continue;

        let stepNumber: number | null = null;
        if (draft.id || draft.notOpenedId) {
          stepNumber =
            typeof draft.step_number === 'number'
              ? draft.step_number
              : Number(draft.step_number) || null;
        } else {
          // Global step counter: the next step is numbered after the largest
          // step number already saved in the sequence (Step 1, 2, 3, 4 …), so a
          // card under "Step 2 → Opened" becomes Step 3 and a card under
          // "Step 2 → Not Opened" becomes Step 4 — every branch card keeps its
          // own distinct number while still extending the parent branch node.
          const nums: number[] = [];
          for (const d of stepDrafts) {
            const n = d.id || d.notOpenedId
              ? Number(d.step_number)
              : stepNumberByKey[d.draftKey];
            if (n != null && Number.isFinite(n)) nums.push(n as number);
          }
          stepNumber = (nums.length > 0 ? Math.max(...nums) : 0) + 1;
        }
        stepNumberByKey[draft.draftKey] = stepNumber || 1;

        const parentId = resolveParentId(draft, stepDrafts, idByKey, notOpenedIdByKey);

        // Opened branch node (normal content, immediate).
        if (hasNormal) {
          const openedPayload = stepPayload(draft, parentId, stepNumber);
          if (draft.id) {
            await updateStep(sequenceId, draft.id, openedPayload);
            idByKey[draft.draftKey] = draft.id;
          } else {
            const created = await createStep(sequenceId, openedPayload);
            idByKey[draft.draftKey] = created.id;
          }
          // Persist this node's attachments: move brand-new temp uploads into
          // sequence-attachments/{sequence_id}/{step_id}/ and insert their rows.
          if (draft.normal_attachments.length > 0) {
            const relocated = await relocatePendingStepAttachments(
              sequenceId,
              idByKey[draft.draftKey],
              draft.normal_attachments,
            );
            setStepDrafts((prev) =>
              prev.map((s) =>
                s.draftKey === draft.draftKey ? { ...s, normal_attachments: relocated } : s,
              ),
            );
          }
        }

        // Not Opened branch node (increment content, after the card's wait).
        // Both branch nodes hang off the SAME parent node the card targets, so
        // a card under "Step 2 → Opened" creates Step 3 Opened + Step 3 Not
        // Opened and a card under "Step 2 → Not Opened" creates Step 4 Opened +
        // Step 4 Not Opened — every branch continues with BOTH children.
        if (hasIncrement && parentId) {
          const notOpenedPayload = stepNotOpenedPayload(draft, parentId, stepNumber);
          if (draft.notOpenedId) {
            await updateStep(sequenceId, draft.notOpenedId, notOpenedPayload);
            notOpenedIdByKey[draft.draftKey] = draft.notOpenedId;
          } else {
            const created = await createStep(sequenceId, notOpenedPayload);
            notOpenedIdByKey[draft.draftKey] = created.id;
          }
          // Persist this node's attachments (moves temp uploads + inserts rows).
          if (draft.increment_attachments.length > 0) {
            const relocated = await relocatePendingStepAttachments(
              sequenceId,
              notOpenedIdByKey[draft.draftKey],
              draft.increment_attachments,
            );
            setStepDrafts((prev) =>
              prev.map((s) =>
                s.draftKey === draft.draftKey ? { ...s, increment_attachments: relocated } : s,
              ),
            );
          }
        }
      }
      if (editing) {
        const originalIds = new Set((editing.steps || []).map((s) => s.id));
        const keptIds = new Set<string>();
        for (const s of stepDrafts) {
          if ((s.normal_subject.trim() || s.normal_body.trim()) && s.id) keptIds.add(s.id);
          if ((s.increment_subject.trim() || s.increment_body.trim()) && s.notOpenedId) {
            keptIds.add(s.notOpenedId);
          }
        }
        for (const id of originalIds) {
          if (!keptIds.has(id)) await deleteStep(editing.id, id, true);
        }
        onToast('Sequence updated', 'success');
      } else {
        onToast('Sequence created', 'success');
      }
      setModalOpen(false);
      bumpReload();
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save sequence', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (seq: Sequence) => {
    if (actBusyId) return;
    const isActive = seq.status === 'active';
    const isPaused = seq.status === 'paused';
    setActBusyId(seq.id);
    try {
      if (isActive) {
        await pauseSequence(seq.id);
        onToast(`Sequence "${seq.name}" paused`, 'success');
      } else {
        const activated = await activateSequence(seq.id);
        const count = activated.enrolled_count;
        if (count === 0) {
          onToast('No contacts found for this target audience.', 'info');
        } else {
          onToast(
            isPaused
              ? `Sequence "${seq.name}" resumed — ${count} contact${count === 1 ? '' : 's'} enrolled`
              : `Sequence "${seq.name}" activated — ${count} contact${count === 1 ? '' : 's'} enrolled`,
            'success',
          );
        }
      }
      bumpReload();
      await load();
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : `Failed to ${isActive ? 'pause' : 'activate'} sequence`,
        'error',
      );
    } finally {
      setActBusyId(null);
    }
  };

  const handleDelete = async (seq: Sequence) => {
    if (delBusyId) return;
    if (!window.confirm(`Delete sequence "${seq.name}"? Its steps will also be deleted.`)) return;
    setDelBusyId(seq.id);
    try {
      await deleteSequence(seq.id);
      onToast('Sequence deleted', 'info');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete sequence', 'error');
    } finally {
      setDelBusyId(null);
    }
  };

  /**
   * "+ Enroll" — uses the existing activation endpoint, which enrolls the full
   * eligible audience (idempotent upsert), so new audience members are picked up
   * even when the sequence is already active.
   */
  const handleEnroll = async (seq: Sequence) => {
    if (enrollBusyId) return;
    setEnrollBusyId(seq.id);
    try {
      const activated = await activateSequence(seq.id);
      const count = activated.enrolled_count;
      if (count === 0) {
        onToast('No contacts found for this target audience.', 'info');
      } else {
        onToast(
          `Enrolled ${count} contact${count === 1 ? '' : 's'}`,
          'success',
        );
      }
      bumpReload();
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to enroll contacts', 'error');
    } finally {
      setEnrollBusyId(null);
    }
  };

  if (viewSeqId) {
    return (
      <SequenceDetails
        seqId={viewSeqId}
        reloadToken={reloadToken}
        onBack={() => setViewSeqId(null)}
        onToast={onToast}
        onEdit={openEdit}
        onChanged={() => void load()}
        bumpReload={bumpReload}
      />
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="seq-header">
        <div>
          <div className="seq-title">Sequences</div>
          <div className="seq-subtitle">Email drip automation — enroll contacts and track progress</div>
        </div>
        <button className="btn btn-primary btn-new-seq" onClick={openCreate}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create Sequence
        </button>
      </div>

      {/* Statistics */}
      <div className="seq-stats">
        <div className="seq-stat">
          <div className="seq-stat-icon seq-stat-blue">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>
          <div className="seq-stat-body">
            <div className="seq-stat-value">{stats.total}</div>
            <div className="seq-stat-label">Total Sequences</div>
            <div className="seq-stat-desc">{stats.active} active</div>
          </div>
        </div>
        <div className="seq-stat">
          <div className="seq-stat-icon seq-stat-violet">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="seq-stat-body">
            <div className="seq-stat-value">{stats.enrolled}</div>
            <div className="seq-stat-label">Enrolled</div>
            <div className="seq-stat-desc">Total enrollments</div>
          </div>
        </div>
        <div className="seq-stat">
          <div className="seq-stat-icon seq-stat-green">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div className="seq-stat-body">
            <div className="seq-stat-value">{stats.completed}</div>
            <div className="seq-stat-label">Completed</div>
            <div className="seq-stat-desc">Enrollments finished</div>
          </div>
        </div>
        <div className="seq-stat">
          <div className="seq-stat-icon seq-stat-amber">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 6l-10 7L2 6" />
              <rect x="2" y="3" width="20" height="18" rx="2" ry="2" />
            </svg>
          </div>
          <div className="seq-stat-body">
            <div className="seq-stat-value">{stats.openRate}</div>
            <div className="seq-stat-label">Open Rate</div>
            <div className="seq-stat-desc">{stats.all} tracked sends</div>
          </div>
        </div>
        <div className="seq-stat">
          <div className="seq-stat-icon seq-stat-rose">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </div>
          <div className="seq-stat-body">
            <div className="seq-stat-value">{stats.steps}</div>
            <div className="seq-stat-label">Total Steps</div>
            <div className="seq-stat-desc">Across all sequences</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="seq-toolbar">
        <div className="seq-tabs">
          {(
            [
              { key: 'all', label: 'All Sequences' },
              { key: 'active', label: 'Active' },
              { key: 'completed', label: 'Completed' },
              { key: 'draft', label: 'Draft' },
              { key: 'paused', label: 'Paused' },
              { key: 'archived', label: 'Archived' },
            ] as const
          ).map((tab) => {
            const selected = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                className={`seq-tab${selected ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="seq-toolbar-right">
          <div className="seq-search">
            <span className="seq-search-ic">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search sequences…"
              aria-label="Search sequences"
            />
          </div>
          <select
            className="seq-filter"
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as 'all' | SendMode)}
            aria-label="Filter sequences"
          >
            <option value="all">All send modes</option>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
            <option value="both">Automatic + Manual</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: '40px' }}>
          <div className="empty-icon">⟳</div>
          <div className="empty-title">Loading sequences…</div>
        </div>
      ) : error ? (
        <div className="empty-state" style={{ padding: '40px' }}>
          <div className="empty-icon">⚠</div>
          <div className="empty-title">Could not load sequences</div>
          <div className="empty-sub">{error}</div>
        </div>
      ) : sequences.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px' }}>
          <div className="empty-icon">✉</div>
          <div className="empty-title">No sequences yet</div>
          <div className="empty-sub">
            Create your first drip sequence to send follow-up emails to recipients who opened — or
            did not open — a campaign.
          </div>
          <button
            className="btn btn-primary btn-new-seq"
            style={{ marginTop: '14px' }}
            onClick={openCreate}
          >
            + Create Sequence
          </button>
        </div>
      ) : (
        <div className="seq-list">
          {filteredSequences.length === 0 ? (
            <div className="empty-state" style={{ padding: '32px' }}>
              <div className="empty-icon">🔍</div>
              <div className="empty-title">No sequences match your filters</div>
              <div className="empty-sub">Try adjusting the search or filters.</div>
            </div>
          ) : (
            filteredSequences.map((seq) => {
              const overview = overviewMap[seq.id] || seq;
              const steps =
                overview.steps && overview.steps.length > 0
                  ? [...overview.steps].sort((a, b) => a.step_number - b.step_number)
                  : [];
              const stepCount = steps.length || seq.steps_count || 0;
              const enrolled = overview.summary ? overview.summary.total : null;
              const completed = overview.summary ? overview.summary.completed : null;
              const openRate = openRateOf(overview);
              const statusLabel =
                seq.status === 'active'
                  ? 'Pause'
                  : seq.status === 'paused'
                    ? 'Resume'
                    : 'Activate';
              const schedule = scheduleStateOf(overview, nowMs);
              const avatar = sequenceAvatarColor(seq.name || 'Sequence');
              const isExpanded = expandedSeqId === seq.id;
              const scheduleSub =
                schedule?.label === 'Scheduled'
                  ? `Next email: ${formatSequenceDate(schedule.nextAt)}`
                  : schedule?.label === 'Sending'
                    ? 'The runner is processing due emails…'
                    : schedule?.label === 'Sent' || schedule?.label === 'Completed'
                      ? `Last sent: ${schedule.lastAt ? formatSequenceDate(schedule.lastAt) : '—'}`
                      : schedule?.label === 'Paused'
                        ? 'Emails paused until resumed'
                        : null;

              return (
                <div key={seq.id} className="seq-row">
                  <div className="seq-row-body">
                    {/* Left: icon + name + badges */}
                    <div className="seq-left">
                      <div className="seq-avatar" style={{ background: avatar.bg, color: avatar.color }}>
                        {(seq.name || 'S').charAt(0).toUpperCase()}
                      </div>
                      <div className="seq-info">
                        <div className="seq-name-row">
                          <button
                            type="button"
                            className="seq-name-btn"
                            onClick={() => setViewSeqId(seq.id)}
                          >
                            {seq.name}
                          </button>
                          <button
                            type="button"
                            className="seq-expand-btn"
                            onClick={() => setExpandedSeqId(isExpanded ? null : seq.id)}
                            title={isExpanded ? 'Collapse steps' : 'Expand steps'}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? '⌄' : '›'}
                          </button>
                        </div>
                        <div className="seq-badges">
                          <span className={`tag ${statusTagClass(seq.status)}`}>{seq.status}</span>
                          <span className={`tag ${sendModeTagClass(seq.send_mode)}`}>
                            {sendModeLabel(seq.send_mode)}
                          </span>
                          <span className="tag tag-draft">
                            {seq.audience_segment || 'No audience'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Status / last sent */}
                    <div className="seq-status">
                      {schedule ? (
                        <>
                          <div className={`seq-status-label seq-status-${schedule.label.toLowerCase()}`}>
                            {schedule.label === 'Completed' || schedule.label === 'Sent'
                              ? '✓'
                              : schedule.label === 'Paused'
                                ? '⏸'
                                : schedule.label === 'Sending'
                                  ? '⟳'
                                  : '⏱'}{' '}
                            {schedule.label}
                          </div>
                          <div className="seq-status-sub">{scheduleSub}</div>
                        </>
                      ) : (
                        <>
                          <div className="seq-status-label seq-status-draft">
                            {seq.status === 'draft' ? 'Draft' : 'Not started'}
                          </div>
                          <div className="seq-status-sub">No activity yet</div>
                        </>
                      )}
                    </div>

                    {/* Metrics */}
                    <div className="seq-metrics">
                      <div className="seq-metric">
                        <div className="seq-metric-value">{enrolled ?? '—'}</div>
                        <div className="seq-metric-label">Enrolled</div>
                      </div>
                      <div className="seq-metric">
                        <div className="seq-metric-value">{completed ?? '—'}</div>
                        <div className="seq-metric-label">Completed</div>
                      </div>
                      <div className="seq-metric seq-metric-accent">
                        <div className="seq-metric-value">{openRate}</div>
                        <div className="seq-metric-label">Open Rate</div>
                      </div>
                      <div className="seq-metric">
                        <div className="seq-metric-value">{stepCount}</div>
                        <div className="seq-metric-label">Steps</div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="seq-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setViewSeqId(seq.id)}
                      >
                        Manage
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void openEdit(overview)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void handleToggleStatus(seq)}
                        disabled={actBusyId === seq.id}
                      >
                        {actBusyId === seq.id ? 'Working…' : statusLabel}
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleEnroll(seq)}
                        disabled={enrollBusyId === seq.id}
                      >
                        {enrollBusyId === seq.id ? 'Enrolling…' : '+ Enroll'}
                      </button>
                      <button
                        className="btn-icon"
                        title="Delete sequence"
                        style={{ color: 'var(--red)' }}
                        onClick={() => void handleDelete(seq)}
                        disabled={delBusyId === seq.id}
                      >
                        {delBusyId === seq.id ? '…' : '🗑'}
                      </button>
                    </div>
                  </div>

                  {/* Step timeline (shown only when this sequence is expanded) */}
                  {isExpanded && (
                    <div className="seq-steps">
                      {steps.length === 0 ? (
                        <div style={{ fontSize: '12px', color: 'var(--text4)', padding: '4px 0' }}>
                          No steps configured yet.
                        </div>
                      ) : (
                        steps.map((step, idx) => (
                        <div key={step.id} style={{ display: 'flex', gap: '12px' }}>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <div
                              style={{
                                width: '26px',
                                height: '26px',
                                borderRadius: '50%',
                                border: '2px solid var(--accent)',
                                color: 'var(--accent)',
                                background: 'var(--accent-light)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '12px',
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {step.step_number}
                              {step.parent_branch === 'NOT_OPENED' ? 'A' : ''}
                            </div>
                            {idx < steps.length - 1 && (
                              <div
                                style={{
                                  width: '2px',
                                  flex: 1,
                                  background: 'var(--border)',
                                  minHeight: '30px',
                                  marginTop: '4px',
                                }}
                              />
                            )}
                          </div>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              paddingBottom: idx < steps.length - 1 ? '16px' : '2px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '10px',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  color: 'var(--text1)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {step.normal_subject || step.increment_subject || 'Untitled step'}
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: '6px',
                                  alignItems: 'center',
                                  flexShrink: 0,
                                }}
                              >
                                {step.parent_branch === 'OPENED' && (
                                  <span className="tag tag-startup">Opened</span>
                                )}
                                {step.parent_branch === 'NOT_OPENED' && (
                                  <span className="tag tag-oem">Not Opened</span>
                                )}
                                {step.recipient_type === 'opened' && (
                                  <span className="tag tag-startup">Opened</span>
                                )}
                                {step.recipient_type === 'not_opened' && (
                                  <span className="tag tag-oem">Not Opened</span>
                                )}
                                <span className="tag tag-draft">✉ email</span>
                              </div>
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
                              {stepDayLabel(step, steps)} · {stepConditionLabel(step.recipient_type)}
                            </div>
                            {step.parent_branch !== 'NOT_OPENED' && step.increment_subject ? (
                              <div style={{ fontSize: '11.5px', color: 'var(--text3)', marginTop: '2px' }}>
                                <span style={{ color: 'var(--text4)' }}>Not Opened:</span>{' '}
                                {step.increment_subject}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))
                      )}
                      <div
                        style={{
                          display: 'flex',
                          gap: '10px',
                          marginTop: '16px',
                          paddingTop: '14px',
                          borderTop: '1px solid var(--border)',
                        }}
                      >
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleEnroll(seq)}
                          disabled={enrollBusyId === seq.id}
                        >
                          {enrollBusyId === seq.id ? 'Enrolling…' : '+ Enroll Contacts'}
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => void openEdit(overview)}>
                          Edit Steps
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── CREATE / EDIT MODAL ── */}
      {modalOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '920px' }}>
            <div className="modal-header">
              <div className="modal-title">{editing ? 'Edit Sequence' : 'Create Sequence'}</div>
              <button className="btn-icon" onClick={() => setModalOpen(false)} disabled={saving}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="grid-2" style={{ marginBottom: '14px' }}>
                <div className="form-group" style={{ marginBottom: '0' }}>
                  <label>Sequence Name</label>
                  <input
                    type="text"
                    value={fName}
                    onChange={(e) => setFName(e.target.value)}
                    placeholder="e.g. Post-launch drip for opened contacts"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: '0' }}>
                  <label>Trigger Type</label>
                  <select
                    value={fTrigger}
                    onChange={(e) =>
                      setFTrigger(e.target.value as 'manual' | 'time_based' | 'behaviour')
                    }
                  >
                    {TRIGGER_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid-2" style={{ marginBottom: '14px' }}>
                <div className="form-group" style={{ marginBottom: '0' }}>
                  <label>Recipient Type</label>
                  <select
                    value={fRecipientType}
                    onChange={(e) => setFRecipientType(e.target.value as RecipientType)}
                  >
                    <option value="all">All Recipients</option>
                    <option value="opened">Opened Email</option>
                    <option value="not_opened">Not Opened Email</option>
                  </select>
                  <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
                    The sequence sends Step 1 to everyone enrolled; the per-step branch decides who
                    receives each follow-up.
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: '0' }}>
                  <label>Target Audience</label>
                  <select value={fAudience} onChange={(e) => setFAudience(e.target.value)}>
                    <option value="">Select an audience…</option>
                    {audienceOptions.map((a) => (
                      <option key={a.id} value={a.label}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
                    {audienceCountLoading ? (
                      'Checking matching contacts…'
                    ) : fAudience ? (
                      audienceCount === 0 ? (
                        <span style={{ color: 'var(--red, #ef4444)' }}>
                          No contacts found for this target audience.
                        </span>
                      ) : (
                        <>
                          <strong style={{ color: 'var(--text2)' }}>{audienceCount}</strong>{' '}
                          contact{audienceCount === 1 ? '' : 's'} will be enrolled.
                        </>
                      )
                    ) : (
                      'Pick the contact type from the Contacts table to target.'
                    )}
                  </div>
                </div>
              </div>

              {/* Branching note */}
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text4)',
                  padding: '8px 10px',
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  marginBottom: '16px',
                }}
              >
                Every step is a <strong style={{ color: 'var(--text2)' }}>node</strong> in a
                branching tree. Step 1 (the starting node) is sent to every enrolled recipient.
                Each later node is attached to a parent node's{' '}
                <strong style={{ color: 'var(--text2)' }}>Opened</strong> or{' '}
                <strong style={{ color: 'var(--text2)' }}>Not Opened</strong> branch — after the
                parent email, the recipient advances onto that branch's node and{' '}
                <strong style={{ color: 'var(--text2)' }}>both branches always send</strong> their
                configured next email: the Opened branch immediately, the Not Opened branch after
                the node's wait hours (only if the parent email is still not opened by then).
              </div>

              {/* Send Mode */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text3)' }}>
                  How should the sequence be sent?
                </label>
                <div className="grid-2" style={{ gap: '10px', marginTop: '8px' }}>
                  {SEND_MODE_OPTIONS.map((opt) => {
                    const selected = fSendMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setFSendMode(opt.value)}
                        style={{
                          display: 'flex',
                          gap: '10px',
                          alignItems: 'flex-start',
                          textAlign: 'left',
                          background: 'var(--surface3)',
                          border: `1.5px solid ${selected ? 'var(--accent, #4f8cff)' : 'var(--border)'}`,
                          borderRadius: '10px',
                          padding: '10px 12px',
                          cursor: 'pointer',
                        }}
                      >
                        <div
                          style={{
                            width: '30px',
                            height: '30px',
                            borderRadius: '8px',
                            background: selected ? 'var(--accent, #4f8cff)' : 'var(--surface2)',
                            border: '1px solid var(--border)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '13px',
                            color: selected ? '#fff' : 'var(--text4)',
                            flexShrink: 0,
                          }}
                        >
                          {opt.icon}
                        </div>
                        <div>
                          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text2)' }}>
                            {opt.label}
                          </div>
                          <div style={{ fontSize: '11.5px', color: 'var(--text4)', marginTop: '2px' }}>
                            {opt.desc}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Sending Limits / Batch Sending (matches Campaigns & Follow-ups UI) */}
              <div
                style={{
                  height: '1px',
                  background: 'var(--border)',
                  margin: '4px 0 16px',
                }}
              />
              <div
                style={{
                  fontSize: '12px',
                  letterSpacing: '0.05em',
                  color: 'var(--text4)',
                  marginBottom: '12px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                Sending Limits
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '16px' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '13px',
                    color: '#334155',
                    cursor: 'pointer',
                    fontWeight: 500,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sendInBatches}
                    onChange={(e) => setSendInBatches(e.target.checked)}
                    style={{
                      accentColor: '#2563EB',
                      width: '16px',
                      height: '16px',
                      cursor: 'pointer',
                      margin: 0,
                    }}
                  />
                  Send in batches
                </label>

                {sendInBatches && (() => {
                  const totalRecipients = audienceCount ?? 0;
                  const estimatedBatches =
                    totalRecipients > 0 && batchSize > 0 ? Math.ceil(totalRecipients / batchSize) : 0;
                  const delayLabel =
                    DELAY_OPTIONS.find((o) => o.value === batchDelayHours)?.label || '1 Hour';

                  return (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                        padding: '16px',
                        background: '#F8FAFC',
                        border: '1px solid #E2E8F0',
                        borderRadius: '10px',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '24px' }}>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <label
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#64748B',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            Batch Size
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="number"
                              value={batchSize}
                              onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                              min={1}
                              max={1000}
                              style={{
                                width: '100px',
                                height: '40px',
                                padding: '0 12px',
                                border: '1px solid #E2E8F0',
                                borderRadius: '8px',
                                fontSize: '13px',
                                outline: 'none',
                                background: '#FFFFFF',
                                color: '#334155',
                                textAlign: 'center',
                              }}
                            />
                            <span style={{ fontSize: '13px', color: '#64748B' }}>contacts</span>
                          </div>
                        </div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <label
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#64748B',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                            }}
                          >
                            Send next batch after
                          </label>
                          <select
                            value={batchDelayHours}
                            onChange={(e) => setBatchDelayHours(parseFloat(e.target.value))}
                            style={{
                              width: '100%',
                              height: '40px',
                              padding: '0 12px',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              fontSize: '13px',
                              outline: 'none',
                              background: '#FFFFFF',
                              color: '#334155',
                              cursor: 'pointer',
                            }}
                          >
                            {DELAY_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '13px', color: '#1D4ED8', fontWeight: 500 }}>
                          {batchSize} contacts will be sent every {delayLabel}.
                        </div>
                        {fAudience ? (
                          <div style={{ fontSize: '12px', color: '#475569' }}>
                            Audience: {fAudience} ({totalRecipients})
                          </div>
                        ) : (
                          <div style={{ fontSize: '12px', color: '#475569' }}>
                            Audience: {fAudience || 'Not selected'} ({totalRecipients})
                          </div>
                        )}
                        <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                          Estimated batches: {estimatedBatches}
                        </div>

                        {estimatedBatches > 0 && (
                          <div
                            style={{
                              maxHeight: '200px',
                              overflowY: 'auto',
                              fontSize: '12px',
                              color: '#334155',
                              background: '#FFFFFF',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              padding: '12px',
                            }}
                          >
                            {Array.from({ length: estimatedBatches }, (_, i) => {
                              const start = i * batchSize + 1;
                              const end = Math.min((i + 1) * batchSize, totalRecipients);
                              return (
                                <div
                                  key={i}
                                  style={{
                                    padding: '4px 0',
                                    borderBottom:
                                      i < estimatedBatches - 1 ? '1px solid #F1F5F9' : 'none',
                                  }}
                                >
                                  Batch {i + 1}: S.No. {start}–{end}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Steps */}
              <div style={{ marginBottom: '14px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text3)' }}>
                    Steps ({stepDrafts.length})
                  </label>
                  <button
                    className="btn btn-secondary btn-xs"
                    onClick={() => setStepDrafts((prev) => [...prev, newStepDraft(prev)])}
                  >
                    + Add Step
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {stepDrafts.map((draft, i) => {
                    return (
                    <div
                      key={draft.draftKey}
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: '10px',
                        padding: '12px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '10px',
                        }}
                      >
                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text3)' }}>
                          Step {draft.step_number ?? i + 1}
                        </div>
                        <button
                          className="btn-icon"
                          onClick={() =>
                            setStepDrafts((prev) =>
                              prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i),
                            )
                          }
                          disabled={stepDrafts.length === 1}
                        >
                          ✕
                        </button>
                      </div>

                      {/* Parent Step / Recipient Branch — the node this step extends */}
                      <div className="form-group" style={{ marginBottom: '10px' }}>
                        <label>Parent Step / Recipient Branch</label>
                        {i === 0 ? (
                          <select value="starting-step" disabled>
                            <option value="starting-step">Starting Step (no parent)</option>
                          </select>
                        ) : (
                          <select
                            value={parentOptionValue(draft, stepDrafts)}
                            onChange={(e) => {
                              const [key, path] = e.target.value.split(':');
                              setStepDrafts((prev) =>
                                prev.map((s, idx) =>
                                  idx === i
                                    ? {
                                        ...s,
                                        parent_step_id: null,
                                        parent_branch:
                                          path === 'NOT_OPENED' ? 'NOT_OPENED' : 'OPENED',
                                        parent_key: key,
                                      }
                                    : s,
                                ),
                              );
                            }}
                          >
                            {stepDrafts.slice(0, i).flatMap((pd, pIdx) =>
                              (['OPENED', 'NOT_OPENED'] as const).map((path) => (
                                <option
                                  key={`${pd.draftKey}-${path}`}
                                  value={`${pd.draftKey}:${path}`}
                                >
                                  Step {pd.step_number ?? pIdx + 1} —{' '}
                                  {path === 'OPENED' ? 'Opened' : 'Not Opened'}
                                </option>
                              )),
                            )}
                          </select>
                        )}
                        <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
                          {i === 0
                            ? 'Step 1 is the starting step — sent to every enrolled recipient. Its children branch into the Step 1 — Opened and Step 1 — Not Opened paths.'
                            : 'Attach this node to a parent node\u2019s branch. Recipients advance onto this node after the parent email; the Opened branch sends right away, the Not Opened branch after this node\u2019s wait hours.'}
                        </div>
                      </div>

                      {/* Recipient Type — who receives THIS step (kept on the same
                          database row when editing; only new steps are inserted). */}
                      <div className="form-group" style={{ marginBottom: '10px' }}>
                        <label>Recipient Type</label>
                        <select
                          value={draft.recipient_type}
                          onChange={(e) =>
                            setStepDrafts((prev) =>
                              prev.map((s, idx) =>
                                idx === i
                                  ? { ...s, recipient_type: e.target.value as RecipientType }
                                  : s,
                              ),
                            )
                          }
                        >
                          <option value="all">All Recipients</option>
                          <option value="opened">Opened Email</option>
                          <option value="not_opened">Not Opened Email</option>
                        </select>
                        <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
                          Determines which recipients move onto this step (in addition to the
                          parent branch path configured above).
                        </div>
                      </div>

                      {i === 0 ? (
                        <>
                          <div className="grid-2" style={{ gap: '10px', marginBottom: '10px' }}>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>Subject</label>
                              <input
                                type="text"
                                value={draft.normal_subject}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, normal_subject: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="Starting email subject sent to every enrolled recipient"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>From Name</label>
                              <input
                                type="text"
                                value={draft.from_name}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, from_name: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="e.g. Rupali Sirsath"
                              />
                            </div>
                          </div>
                          <LoadTemplateControl
                            templates={templates}
                            templatesLoading={templatesLoading}
                            value={draft.normal_template_id}
                            loading={draft.normal_loading}
                            error={draft.normal_error}
                            onSelect={(templateId) =>
                              templateId
                                ? void applyTemplateToBranch(templateId, 'normal', draft.draftKey)
                                : clearTemplateFromBranch('normal', draft.draftKey)
                            }
                          />
                          {draft.normal_template_id && draft.normal_template_html ? (
                            <TemplatePreview
                              html={draft.normal_template_html}
                              name={
                                templates.find((t) => t.id === draft.normal_template_id)?.name ||
                                undefined
                              }
                            />
                          ) : (
                            <div className="form-group" style={{ marginBottom: '10px' }}>
                              <label>Body</label>
                              <textarea
                                rows={3}
                                value={draft.normal_body}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, normal_body: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="Starting email body — {{company}} and {{first_name}} placeholders are supported."
                              />
                            </div>
                          )}
                          <StepAttachmentsControl
                            attachments={draft.normal_attachments}
                            uploading={draft.normal_attachments_uploading}
                            error={draft.normal_attachments_error}
                            onFiles={(files) =>
                              void handleAddStepAttachments(files, 'normal', draft.draftKey)
                            }
                            onRemove={(att) =>
                              void handleRemoveStepAttachment(att, 'normal', draft.draftKey)
                            }
                          />
                          <div className="form-group" style={{ marginBottom: '0' }}>
                            <label>Wait Hours</label>
                            <input
                              type="number"
                              min={0}
                              value={draft.wait_hours}
                              onChange={(e) =>
                                setStepDrafts((prev) =>
                                  prev.map((s, idx) =>
                                    idx === i ? { ...s, wait_hours: Number(e.target.value) } : s,
                                  ),
                                )
                              }
                            />
                            <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '4px' }}>
                              Delay before Step 1 is sent (0 = send immediately).
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginBottom: '6px',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                color: 'var(--text4)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.6px',
                              }}
                            >
                              OPENED
                            </span>
                            <span className="tag tag-startup">Opened branch content</span>
                            <span
                              style={{
                                marginLeft: 'auto',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'var(--accent)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              ⚡ Send Immediately
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text4)',
                              marginBottom: '10px',
                            }}
                          >
                            Sent right away to recipients on this node's branch (or to everyone, for
                            the starting step).
                          </div>
                          <div className="grid-2" style={{ gap: '10px', marginBottom: '10px' }}>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>Subject</label>
                              <input
                                type="text"
                                value={draft.normal_subject}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, normal_subject: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="Sent immediately when the recipient opens the tracked email"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>From Name</label>
                              <input
                                type="text"
                                value={draft.from_name}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, from_name: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="e.g. Rupali Sirsath"
                              />
                            </div>
                          </div>
                          <LoadTemplateControl
                            templates={templates}
                            templatesLoading={templatesLoading}
                            value={draft.normal_template_id}
                            loading={draft.normal_loading}
                            error={draft.normal_error}
                            onSelect={(templateId) =>
                              templateId
                                ? void applyTemplateToBranch(templateId, 'normal', draft.draftKey)
                                : clearTemplateFromBranch('normal', draft.draftKey)
                            }
                          />
                          {draft.normal_template_id && draft.normal_template_html ? (
                            <TemplatePreview
                              html={draft.normal_template_html}
                              name={
                                templates.find((t) => t.id === draft.normal_template_id)?.name ||
                                undefined
                              }
                            />
                          ) : (
                            <div className="form-group" style={{ marginBottom: '10px' }}>
                              <label>Body</label>
                              <textarea
                                rows={3}
                                value={draft.normal_body}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, normal_body: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="Email sent to recipients on this branch — {{company}} and {{first_name}} placeholders are supported."
                              />
                            </div>
                          )}
                          <StepAttachmentsControl
                            attachments={draft.normal_attachments}
                            uploading={draft.normal_attachments_uploading}
                            error={draft.normal_attachments_error}
                            onFiles={(files) =>
                              void handleAddStepAttachments(files, 'normal', draft.draftKey)
                            }
                            onRemove={(att) =>
                              void handleRemoveStepAttachment(att, 'normal', draft.draftKey)
                            }
                          />

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              marginBottom: '6px',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '11px',
                                fontWeight: 700,
                                color: 'var(--text4)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.6px',
                              }}
                            >
                              NOT OPENED
                            </span>
                            <span className="tag tag-oem">Not opened branch content</span>
                            <span
                              style={{
                                marginLeft: 'auto',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'var(--text4)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              Wait {draft.wait_hours} hour{draft.wait_hours === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text4)',
                              marginBottom: '10px',
                            }}
                          >
                            {draft.wait_hours > 0
                              ? `Sent after ${draft.wait_hours} hour${draft.wait_hours === 1 ? '' : 's'} if the recipient still has not opened the parent email.`
                              : 'Sent immediately if the recipient still has not opened the parent email.'}
                          </div>
                          <div className="grid-2" style={{ gap: '10px', marginBottom: '10px' }}>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>Subject</label>
                              <input
                                type="text"
                                value={draft.increment_subject}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, increment_subject: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="Sent after the wait if the recipient still has not opened the parent email"
                              />
                            </div>
                            <div className="form-group" style={{ marginBottom: '0' }}>
                              <label>From Name</label>
                              <input
                                type="text"
                                value={draft.from_name}
                                onChange={(e) =>
                                  setStepDrafts((prev) =>
                                    prev.map((s, idx) =>
                                      idx === i ? { ...s, from_name: e.target.value } : s,
                                    ),
                                  )
                                }
                                placeholder="e.g. Rupali Sirsath"
                              />
                            </div>
                          </div>
                          <LoadTemplateControl
                            templates={templates}
                            templatesLoading={templatesLoading}
                            value={draft.increment_template_id}
                            loading={draft.increment_loading}
                            error={draft.increment_error}
                            onSelect={(templateId) =>
                              templateId
                                ? void applyTemplateToBranch(templateId, 'increment', draft.draftKey)
                                : clearTemplateFromBranch('increment', draft.draftKey)
                            }
                          />
                          {draft.increment_template_id && draft.increment_template_html ? (
                            <>
                              <TemplatePreview
                                html={draft.increment_template_html}
                                name={
                                  templates.find((t) => t.id === draft.increment_template_id)?.name ||
                                  undefined
                                }
                              />
                              <div className="form-group" style={{ marginBottom: '0' }}>
                                <label>Wait Hours</label>
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.wait_hours}
                                  onChange={(e) =>
                                    setStepDrafts((prev) =>
                                      prev.map((s, idx) =>
                                        idx === i
                                          ? { ...s, wait_hours: Number(e.target.value) }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                              </div>
                            </>
                          ) : (
                            <div className="grid-2" style={{ gap: '10px', marginBottom: '10px' }}>
                              <div className="form-group" style={{ marginBottom: '0' }}>
                                <label>Body</label>
                                <textarea
                                  rows={2}
                                  value={draft.increment_body}
                                  onChange={(e) =>
                                    setStepDrafts((prev) =>
                                      prev.map((s, idx) =>
                                        idx === i ? { ...s, increment_body: e.target.value } : s,
                                      ),
                                    )
                                  }
                                  placeholder="Alternative content for recipients on this branch who did not open the parent email."
                                />
                              </div>
                              <div className="form-group" style={{ marginBottom: '0' }}>
                                <label>Wait Hours</label>
                                <input
                                  type="number"
                                  min={0}
                                  value={draft.wait_hours}
                                  onChange={(e) =>
                                    setStepDrafts((prev) =>
                                      prev.map((s, idx) =>
                                        idx === i
                                          ? { ...s, wait_hours: Number(e.target.value) }
                                          : s,
                                      ),
                                    )
                                  }
                                />
                              </div>
                            </div>
                          )}
                          <StepAttachmentsControl
                            attachments={draft.increment_attachments}
                            uploading={draft.increment_attachments_uploading}
                            error={draft.increment_attachments_error}
                            onFiles={(files) =>
                              void handleAddStepAttachments(files, 'increment', draft.draftKey)
                            }
                            onRemove={(att) =>
                              void handleRemoveStepAttachment(att, 'increment', draft.draftKey)
                            }
                          />
                        </>
                      )}
                    </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={saving}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Sequence'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



