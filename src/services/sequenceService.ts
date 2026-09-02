/**
 * Sequence / Drip automation service.
 *
 * Typed facade over the backend REST API (src/api/sequenceApi.ts). The
 * Sequences tab talks ONLY to the backend — campaign names, audiences,
 * statuses, step content and contact counts are always read from the database
 * through these functions, never hardcoded in the UI.
 */
import * as sequenceApi from '../api/sequenceApi';
import type {
  AudienceOption,
  BranchStepInput,
  ManualSendResult,
  RecipientType,
  Sequence,
  SequenceBranchStep,
  SequenceCounts,
  SequenceEnrollment,
  SequenceInput,
  SequenceRecipientsResponse,
  SequenceStep,
  SequenceStepInput,
  SequenceStepLog,
  SequenceStatus,
  SendMode,
  TriggerType,
} from '../types/sequence';

// ─── Sequences ─────────────────────────────────────────────────────────────

export function fetchSequences(): Promise<Sequence[]> {
  return sequenceApi.fetchSequences();
}

export function fetchSequence(id: string): Promise<Sequence> {
  return sequenceApi.fetchSequence(id);
}

export function createSequence(payload: SequenceInput): Promise<Sequence> {
  return sequenceApi.createSequence(payload);
}

export function updateSequence(id: string, payload: Partial<SequenceInput>): Promise<Sequence> {
  return sequenceApi.updateSequence(id, payload);
}

export function deleteSequence(id: string): Promise<void> {
  return sequenceApi.deleteSequence(id);
}

// ─── Selector data ─────────────────────────────────────────────────────────

export function fetchAudienceOptions(): Promise<AudienceOption[]> {
  return sequenceApi.fetchAudienceOptions();
}

/** Count contacts that would be enrolled for a given target audience segment. */
export function countContactsForAudience(audienceSegment: string): Promise<number> {
  return sequenceApi.countContactsForAudience(audienceSegment);
}

/** Flat branch-step rows (sequence_branch_steps) for one sequence. */
export function fetchBranchSteps(sequenceId: string): Promise<SequenceBranchStep[]> {
  return sequenceApi.fetchBranchSteps(sequenceId);
}

export function updateBranchStep(
  sequenceId: string,
  branchStepId: number,
  payload: BranchStepInput
): Promise<SequenceBranchStep> {
  return sequenceApi.updateBranchStep(sequenceId, branchStepId, payload);
}

export function deleteBranchStep(
  sequenceId: string,
  branchStepId: number
): Promise<{ deleted: boolean; id: number }> {
  return sequenceApi.deleteBranchStep(sequenceId, branchStepId);
}

// ─── Steps ─────────────────────────────────────────────────────────────────

export function createStep(sequenceId: string, payload: SequenceStepInput): Promise<SequenceStep> {
  return sequenceApi.createStep(sequenceId, payload);
}

export function updateStep(
  sequenceId: string,
  stepId: string,
  payload: Partial<SequenceStepInput>
): Promise<SequenceStep> {
  return sequenceApi.updateStep(sequenceId, stepId, payload);
}

export function deleteStep(
  sequenceId: string,
  stepId: string,
  cascade: boolean = false
): Promise<{ deleted: boolean; mode?: string; affected?: number }> {
  return sequenceApi.deleteStep(sequenceId, stepId, cascade);
}

// ─── Activate / pause ──────────────────────────────────────────────────────

export function activateSequence(
  id: string,
): Promise<Sequence & { enrolled_count?: number; resolved_contacts?: number }> {
  return sequenceApi.activateSequence(id);
}

export function pauseSequence(id: string): Promise<Sequence> {
  return sequenceApi.pauseSequence(id);
}

// ─── Contacts + logs ───────────────────────────────────────────────────────

export function fetchSequenceContacts(id: string): Promise<SequenceEnrollment[]> {
  return sequenceApi.fetchSequenceContacts(id);
}

export function fetchSequenceLogs(id: string): Promise<SequenceStepLog[]> {
  return sequenceApi.fetchSequenceLogs(id);
}

export function fetchSequenceRecipients(
  id: string,
  stepId?: string
): Promise<SequenceRecipientsResponse> {
  return sequenceApi.fetchSequenceRecipients(id, stepId);
}

export function manualSend(
  id: string,
  stepId: string,
  contactIds: string[]
): Promise<ManualSendResult> {
  return sequenceApi.manualSend(id, stepId, contactIds);
}

// ─── Derived data + display helpers ────────────────────────────────────────

/**
 * Derive Active / Completed / Total counts from a sequence's enrollments.
 * A contact counts as completed when its enrollment status contains
 * "completed"; everything else still in the sequence is "active".
 */
export function deriveSequenceCounts(enrollments: SequenceEnrollment[]): SequenceCounts {
  const total = enrollments.length;
  let completed = 0;
  for (const row of enrollments) {
    if (String(row.status || '').toLowerCase().includes('completed')) completed += 1;
  }
  return { total, active: Math.max(0, total - completed), completed };
}

/** Human-readable label for a trigger_type value. */
export function triggerTypeLabel(trigger: TriggerType | null | undefined): string {
  switch (trigger) {
    case 'manual':
      return 'Manual';
    case 'time_based':
      return 'Time-based';
    case 'behaviour':
      return 'Behaviour';
    default:
      return '—';
  }
}

/** Human-readable label for a recipient_type value. */
export function recipientTypeLabel(type: RecipientType | null | undefined): string {
  switch (type) {
    case 'opened':
      return 'Opened Email';
    case 'not_opened':
      return 'Not Opened Email';
    case 'all':
      return 'All Recipients';
    default:
      return '—';
  }
}

/** Human-readable label for a send_mode value. */
export function sendModeLabel(mode: SendMode | null | undefined): string {
  switch (mode) {
    case 'automatic':
      return 'Automatic';
    case 'manual':
      return 'Manual';
    case 'both':
      return 'Automatic + Manual';
    default:
      return '—';
  }
}

/** CSS tag class for a sequence status. */
export function statusTagClass(status: SequenceStatus | null | undefined): string {
  switch (status) {
    case 'active':
      return 'tag-client';
    case 'paused':
      return 'tag-oem';
    case 'completed':
      return 'tag-startup';
    default:
      return 'tag-draft';
  }
}

/**
 * Format a backend timestamp as a local "Aug 10, 2026 • 2:15 PM" string.
 * Returns '—' for absent/unparseable values.
 */
export function formatSequenceDate(input?: string | null): string {
  if (!input) return '—';
  const date = new Date(input);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
