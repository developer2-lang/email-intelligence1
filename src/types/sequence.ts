/**
 * Sequence / Drip automation types.
 *
 * These mirror the backend contract (backend/services/sequenceService.js) and
 * the canonical Supabase tables:
 *   sequences, sequence_steps, sequence_enrollments, sequence_step_logs
 *
 * Every value shown by the Sequences tab comes from the backend REST API —
 * nothing is hardcoded on the client.
 */

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'completed'
export type TriggerType = 'manual' | 'time_based' | 'behaviour'
export type RecipientType = 'all' | 'opened' | 'not_opened'
export type SendMode = 'automatic' | 'manual' | 'both'
/** Which path of a parent node a child node extends. */
/** Branch path of a sequence step node: STARTING (root) | OPENED | NOT_OPENED. */
export type StepParentBranch = 'STARTING' | 'OPENED' | 'NOT_OPENED'

/**
 * A file attached to one sequence step. The BINARY lives in Supabase Storage
 * (storage_bucket / storage_path) — this row in `sequence_step_attachments`
 * holds only metadata so the sequence_steps table never stores file bytes.
 *
 * `id` is the `sequence_step_attachments` primary key. For an EXISTING step the
 * metadata row is created at upload time (uploadStepAttachment persists it and
 * returns the real record). For a brand-NEW step the file is uploaded to Storage
 * first but no `sequence_step_attachments` row is written yet — the composer
 * keeps a temporary record (sequence_step_id = '', persisted = false) and the
 * metadata is inserted after the step is saved.
 *
 * `persisted === false` marks a temporary composer-only record that still needs
 * its `sequence_step_attachments` row once the step exists.
 */
export interface SequenceAttachment {
  id: string
  sequence_step_id: string
  file_name: string
  file_type: string
  file_size: number
  storage_bucket: string
  storage_path: string
  created_at?: string | null
  /** False for a brand-new step's not-yet-saved attachment (no DB row yet). */
  persisted?: boolean
}

/**
 * A file attached to ONE Sequence Builder branch-step record
 * (`sequence_branch_step_attachments`). The BINARY lives in Supabase Storage
 * (storage_bucket / storage_path) — this row holds only metadata so
 * sequence_branch_steps never stores file bytes.
 *
 * `id` is the `sequence_branch_step_attachments` primary key. For an EXISTING
 * branch step the metadata row is created at upload time. For a brand-NEW
 * branch step (no database id yet) the file is uploaded to a temporary Storage
 * path first and NO DB row is written until the step exists — the builder keeps
 * a temporary record (branch_step_id = 0, persisted = false) and the metadata
 * is inserted after the branch step is saved and relocated.
 */
export interface SequenceBranchStepAttachment {
  id: number
  branch_step_id: number
  file_name: string
  file_size: number | null
  storage_bucket: string
  storage_path: string
  created_at: string
  /** False for a brand-new branch step's not-yet-saved attachment (no DB row yet). */
  persisted?: boolean
}

/** One node of a sequence (sequence_steps row). */
export interface SequenceStep {
  id: string
  sequence_id: string
  step_number: number
  normal_subject: string
  normal_body: string
  increment_subject: string | null
  increment_body: string | null
  /** Templates table reference for the OPENED branch (original HTML fetched at send time). */
  normal_template_id?: string | null
  /** Templates table reference for the NOT OPENED branch (original HTML fetched at send time). */
  increment_template_id?: string | null
  from_name: string | null
  wait_hours: number
  /** Who receives THIS step: all | opened | not_opened (default 'all'). */
  recipient_type: RecipientType
  /**
   * Branch-tree parenting: the exact parent NODE this node extends (null for
   * the STARTING step, which the sequence itself sends to every enrolled
   * recipient — there is no Starting Campaign).
   */
  parent_step_id: string | null
  /** Which path of the parent this node belongs to: 'STARTING' | 'OPENED' | 'NOT_OPENED'. */
  parent_branch: StepParentBranch | null
  created_at: string | null
  updated_at: string | null
  /**
   * Decorated by the logs endpoint: the subject that was actually sent for this
   * branch (increment_* content for NOT_OPENED nodes, normal_* otherwise).
   */
  display_subject?: string | null
}

/** A sequence row (sequences table). */
export interface Sequence {
  id: string
  name: string
  audience_segment: string | null
  trigger_type: TriggerType
  /** Who receives the sequence: all | opened | not_opened. */
  recipient_type: RecipientType
  /** How it sends: automatic | manual | both. */
  send_mode: SendMode
  status: SequenceStatus
  /**
   * Per-step batching config. One shared configuration is INHERITED by every
   * step of the sequence; the runtime tracks each step's own queue via
   * `sequence_step_batch_state` (see SequenceStepBatchState).
   */
  batch_enabled: boolean
  /** Max recipients per batch window (per step). */
  batch_size: number
  /** Hours to wait before the FIRST batch window opens (0 = immediately). */
  first_batch_delay_hours: number
  /** Hours between subsequent batch windows (0.25 = 15m, 0.5 = 30m, 1 = 1h, …). */
  subsequent_batch_delay_hours: number
  /** Decorated step count (list endpoint). */
  steps_count?: number
  /** Steps included by GET /api/sequences/:id. */
  steps?: SequenceStep[]
  created_at: string | null
  updated_at: string | null
  /** Engagement breakdown from GET /api/sequences/:id (overview). */
  engagement?: SequenceEngagement
  /** Enrollment summary from GET /api/sequences/:id (overview). */
  summary?: SequenceSummary
  /** Per-step progress from GET /api/sequences/:id (overview). */
  steps_progress?: SequenceStepProgress[]
  /** Min `next_run_at` over active enrollments — the next scheduled email time. */
  next_run_at?: string | null
  /** Count of active enrollments still waiting to be / being processed. */
  active_count?: number
  /** Latest `sent_at` over this sequence's step logs (last email actually sent). */
  last_sent_at?: string | null
}

/** Starting-campaign engagement counts (Recipient Engagement cards). */
export interface SequenceEngagement {
  all: number
  opened: number
  not_opened: number
}

/** Enrollment-derived summary counts (Overview). */
export interface SequenceSummary {
  total_eligible: number
  total: number
  in_progress: number
  completed: number
  pending: number
  failed: number
}

/** Per-node progress row (Overview table). One row per branch node. */
export interface SequenceStepProgress {
  step: SequenceStep
  subject: string | null
  /** 'STARTING' for the starting node, else the parent branch this node is on. */
  path: 'OPENED' | 'NOT_OPENED' | 'STARTING'
  path_label: string
  /** e.g. 'Step 2 — Opened' or 'Starting Step'. */
  parent_label: string
  wait_hours: number
  /** Display label for the Wait column ('Immediate' or e.g. '24h'). */
  wait_label: string
  eligible: number
  /** Contacts enrolled in the sequence (same denominator for every node). */
  enrolled: number
  sent: number
  opened: number
  clicked: number
  /** Distinct contacts whose send for this node ended in a failed email. */
  failed: number
  /** Eligible contacts who have not been sent yet. */
  pending: number
  status: 'not_started' | 'in_progress' | 'completed'
  /** The next branch emails this node leads to (its children). */
  next: Array<{
    step_number: number
    branch: 'OPENED' | 'NOT_OPENED'
    label: string
    subject: string | null
  }>
  /** Batch queue state for THIS step (empty when batching is disabled). */
  batch_enabled?: boolean
  /** Which batch is currently open (0 = not started). */
  current_batch_number?: number
  /** How many recipients already sent in the current batch. */
  batch_sent?: number
  /** Batch size for this step's queue. */
  batch_size?: number
  /** When the NEXT batch window opens (null → window open / not scheduled). */
  next_batch_at?: string | null
  /** When this step's queue was marked fully drained (all sends delivered). */
  batch_completed_at?: string | null
}

/** One row of the per-step runtime batch queue (sequence_step_batch_state). */
export interface SequenceStepBatchState {
  sequence_id: string
  sequence_step_id: string
  batch_size: number
  batch_enabled: boolean
  first_batch_delay_hours: number
  subsequent_batch_delay_hours: number
  current_batch_number: number
  batch_sent: number
  next_batch_at: string | null
  completed_at: string | null
  created_at: string | null
  updated_at: string | null
}

/** Payload for POST/PUT /api/sequences. */
export interface SequenceInput {
  name: string
  audience_segment: string
  trigger_type: TriggerType
  recipient_type?: RecipientType
  send_mode?: SendMode
  /** Per-step batching config (optional; defaults to disabled with size 30). */
  batch_enabled?: boolean
  batch_size?: number
  first_batch_delay_hours?: number
  subsequent_batch_delay_hours?: number
}

/** Payload for POST/PUT /api/sequences/:id/steps. */
export interface SequenceStepInput {
  step_number?: number
  normal_subject: string
  normal_body: string
  increment_subject?: string | null
  increment_body?: string | null
  normal_template_id?: string | null
  increment_template_id?: string | null
  from_name?: string | null
  wait_hours: number
  recipient_type?: RecipientType
  /**
   * Branch-tree parenting: the exact parent NODE this step extends
   * (parent_step_id) and which path of it this node is ('OPENED' |
   * 'NOT_OPENED'). The root/starting step omits parent_step_id and uses
   * parent_branch = 'STARTING'.
   */
  parent_step_id?: string | null
  parent_branch?: StepParentBranch | null
}

/** One row of the flat branch tree (sequence_branch_steps). */
export interface SequenceBranchStep {
  id: number
  sequence_id?: string
  step: number
  parent_step: number | null
  parent_step_id?: number | null
  parent_branch: StepParentBranch
  subject: string
  body: string
  /** Templates table reference for this branch step (original HTML fetched at send time). */
  template_id?: string | null
  wait_hours?: number
  created_at: string | null
  updated_at: string | null
}

/** Payload for PUT /api/sequences/:id/branch-steps/:branchStepId. */
export interface BranchStepInput {
  parent_step?: number | null
  parent_branch?: StepParentBranch
  subject?: string
  body?: string
  wait_hours?: number
  template_id?: string | null
}

/** Row from GET /api/sequences/audiences (target-audience selector). */
export interface AudienceOption {
  id: string
  label: string
}

/** Enrolled contact row from GET /api/sequences/:id/contacts. */
export interface SequenceEnrollment {
  id: string
  sequence_id: string
  contact_id: string
  current_step: number | null
  current_email_type: 'normal' | 'increment' | null
  current_email_log_id: string | null
  status: string | null
  next_run_at: string | null
  sent_at: string | null
  enrolled_at: string | null
  last_action_at: string | null
  created_at: string | null
  updated_at: string | null
  contact: {
    id: string
    full_name: string | null
    email: string | null
    company: string | null
    contact_type: string | null
    company_category: string | null
  } | null
}

/** Sent step log row from GET /api/sequences/:id/logs. */
export interface SequenceStepLog {
  id: string
  sequence_id: string
  sequence_step_id: string
  contact_id: string
  email_log_id: string | null
  sent_at: string | null
  opened: boolean
  opened_at: string | null
  clicked: boolean
  clicked_at: string | null
  status: string | null
  created_at: string | null
  step: {
    step_number: number
    parent_branch?: string | null
    normal_subject: string | null
    normal_body: string | null
    /** Subject actually sent for this branch (increment_* for NOT_OPENED nodes). */
    display_subject?: string | null
  } | null
  contact: {
    id: string
    full_name: string | null
    email: string | null
  } | null
}

/** Contact status counts derived from a sequence's enrollments. */
export interface SequenceCounts {
  total: number
  active: number
  completed: number
}

/** Recipient row from GET /api/sequences/:id/recipients. */
export interface SequenceRecipient {
  contact: {
    id: string
    full_name: string | null
    email: string | null
    company: string | null
    contact_type: string | null
    company_category: string | null
  }
  email_status: string | null
  opened: boolean | null
  opened_at: string | null
  clicked: boolean | null
  clicked_at: string | null
  sent_at: string | null
  last_activity: string | null
  sequence_status: string | null
  already_sent: boolean
  status: 'eligible' | 'already_sent' | 'opened' | 'not_opened' | 'ineligible'
  recipient_status?: string | null
}

/** Response of GET /api/sequences/:id/recipients. */
export interface SequenceRecipientsResponse {
  sequence: Sequence & {
    engagement: SequenceEngagement
  }
  step: SequenceStep | null
  recipients: SequenceRecipient[]
}

/** Per-contact result of POST /api/sequences/:id/manual-send. */
export interface ManualSendResultRow {
  contact_id: string
  status: string
  email_type?: string | null
  error?: string
  skipped?: boolean
}

/** Response of POST /api/sequences/:id/manual-send. */
export interface ManualSendResult {
  results: ManualSendResultRow[]
  sent: number
  scheduled: number
  skipped: number
}
