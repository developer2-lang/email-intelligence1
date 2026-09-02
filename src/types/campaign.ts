export interface CampaignRow {
  id: string
  campaign_name: string
  subject_line: string | null
  from_name: string | null
  audience_segment: string | null
  campaign_type: string | null
  schedule_date: string | null
  schedule_time: string | null
  email_body: string | null
  html_content: string | null
  template_name: string | null
  status: string | null
  mailchimp_campaign_id: string | null
  recipient_count: number | null
  sent_at: string | null
  scheduled_at: string | null
  created_at: string | null
  updated_at: string | null
  opened_count?: number | null
  clicked_count?: number | null
  delivered_count?: number | null
  sent_count?: number | null
  open_rate?: number | null
  click_rate?: number | null
  send_in_batches?: boolean | null
  batch_size?: number | null
  first_batch_delay_hours?: number | null
  subsequent_batch_delay_hours?: number | null
}

export interface CampaignInput {
  campaign_name: string
  subject_line?: string | null
  from_name?: string | null
  audience_segment?: string | null
  campaign_type?: string | null
  schedule_date?: string | null
  schedule_time?: string | null
  email_body?: string | null
  html_content?: string | null
  template_name?: string | null
  status?: string | null
}

export interface Campaign {
  id: string
  name: string
  type: string
  audience: string
  sent: number
  opened: number
  clicked: number
  bounced: number
  status: string
  date: string
  subject: string
  fromName: string
  campaignType: string
  scheduleDate: string
  scheduleTime: string
  emailBody: string
  templateName: string
  mailchimpCampaignId: string
  recipientCount: number
  sentAt: string
  scheduledAt: string
  deliveredCount: number
  sentCount: number
  openedCount: number
  clickedCount: number
  openRate: number
  clickRate: number
  time: string
  /** Human-readable schedule summary, e.g. "Every Monday • 10:00 AM". */
  scheduleText: string
  /** Batch sending configuration */
  sendInBatches?: boolean
  batchSize?: number
  firstBatchDelayHours?: number
  subsequentBatchDelayHours?: number
}

export interface EmailTemplate {
  id: string
  key: string
  name: string
  description: string
  category: string
  subject: string
  body: string
  /** When the template row was created (used by the Template Editor library). */
  created_at?: string
  /** When the template row was last updated/saved (used by the Saved Templates section). */
  updated_at?: string
  /** Where the template body lives: 'database' (body column) or 'storage' (Supabase Storage HTML file). */
  template_source?: string
  /** Supabase Storage bucket name (used when template_source === 'storage'). */
  storage_bucket?: string
  /** Path of the HTML file inside the storage bucket (used when template_source === 'storage'). */
  storage_path?: string
}

export type ScheduleType = 'one_time' | 'weekly' | 'monthly'
export type MonthlyScheduleType = 'day_of_month' | 'weekday'
export type FollowupMode = 'manual' | 'automatic'

/**
 * A file attached to a campaign. The BINARY lives in Supabase Storage
 * (storage_bucket / storage_path) — this row in `campaign_attachments` holds
 * only metadata so the campaigns table never stores file bytes.
 *
 * `id` is the `campaign_attachments` primary key. For an EXISTING campaign the
 * metadata row is created at upload time (uploadCampaignAttachment persists it
 * to the database and returns the real record). For a brand-NEW campaign the
 * file is uploaded to Storage first but no `campaigns` / `campaign_attachments`
 * row is written yet — the composer keeps a temporary record (campaign_id = '',
 * persisted = false) and the metadata is inserted after the campaign is saved.
 *
 * `persisted === false` marks a temporary composer-only record that still needs
 * its `campaign_attachments` row once the campaign exists.
 */
export interface CampaignAttachment {
  id: string
  campaign_id: string
  file_name: string
  file_type: string
  file_size: number
  storage_bucket: string
  storage_path: string
  created_at?: string | null
  /** False for a brand-new composer's not-yet-saved attachment (no DB row yet). */
  persisted?: boolean
}

/**
 * Follow-up automation settings persisted to the `campaign_followups` table.
 * Mirrors the DB columns (snake_case).
 */
export interface FollowupConfig {
  id?: string | null
  campaign_id: string
  followup_campaign_id: string | null
  trigger_type: string | null
  followup_mode: FollowupMode
  is_active: boolean
  created_at?: string | null
}

/**
 * A configured follow-up relationship decorated by GET /api/followups.
 * `campaign_id` is always the ORIGINAL campaign ('all' for a synthesized
 * all-campaigns row); `followup_campaign_id` is always the FOLLOW-UP campaign.
 *
 * Two SEPARATE concepts:
 *  - `opened_count` / `sent_count`   → the ORIGINAL campaign's openers (eligible
 *    recipients) and how many of them already received the follow-up.
 *  - `followup_opened_count` / `followup_delivered` / `followup_open_rate` → the
 *    FOLLOW-UP campaign's OWN engagement from ITS email_logs (never the original).
 */
export interface FollowupConfigRow extends FollowupConfig {
  original_campaign_name: string
  followup_campaign_name: string
  /** Eligible recipients = original campaign's openers (union for 'all'). */
  opened_count: number
  /** Follow-ups already sent for this (original, follow-up) pair / union. */
  sent_count: number
  /** Follow-up campaign's own delivered emails (status=sent in its email_logs). */
  followup_delivered: number
  /** Follow-up campaign's own opened emails (opened=true in its email_logs). */
  followup_opened: number
  /** Follow-up campaign's own clicked emails. */
  followup_clicked: number
  /** Follow-up open rate % (followup_opened / followup_delivered). */
  followup_open_rate: number
  /** Follow-up click rate % (followup_clicked / followup_delivered). */
  followup_click_rate: number
  /** Recipients still eligible to receive the follow-up (opened - already sent). */
  remaining_eligible: number
  /** True for the synthesized all-campaigns row (campaign_id === 'all'). */
  is_all: boolean
  /** True when the follow-up campaign has an active schedule (status='scheduled'). */
  is_scheduled?: boolean
  /** Human-readable schedule summary for the follow-up campaign. */
  schedule_text?: string
}

/**
 * Result of POST /api/followups. `config` is the persisted relationship row;
 * `created` is true when a NEW follow-up campaign was created as part of the call.
 */
export interface FollowupConfigApiResult {
  config: FollowupConfig | null
  original_campaign_id: string
  followup_campaign_id: string | null
  created: boolean
}

/**
 * One follow-up record triggered by an open (`campaign_followup_logs` row).
 * The display fields (campaign_name, followup_campaign_name, recipient_name)
 * are decorated by the backend for the Pending Follow-ups tab.
 */
export interface PendingFollowup {
  id: string
  campaign_id: string
  campaign_name?: string
  contact_id: string
  recipient_name?: string
  email: string
  followup_campaign_id: string
  followup_campaign_name?: string
  opened_at: string | null
  status: string
  sent_at: string | null
  error_message: string | null
  created_at: string | null
}

export interface FollowupConfigPayload {
  is_active: boolean
  followup_mode: FollowupMode
  followup_campaign_id: string | null
}

/**
 * Payload for creating a follow-up relationship (original + follow-up campaign).
 * `followup_campaign_id` reuses an existing campaign; when omitted a new
 * follow-up campaign is created from campaign_name / subject_line / etc.
 */
export interface CreateFollowupConfigPayload {
  /** The ORIGINAL campaign whose openers become the follow-up recipients. */
  original_campaign_id: string
  /** Reuse an existing campaign as the follow-up (mutually exclusive with creating a new one). */
  followup_campaign_id?: string | null
  /** New follow-up campaign fields (used when followup_campaign_id is omitted). */
  campaign_name?: string
  subject_line?: string
  from_name?: string
  html_content?: string
  campaign_type?: string
  /** Name of the template that supplied the follow-up content (persisted to campaigns.template_name). */
  template_name?: string
  followup_mode: FollowupMode
  is_active: boolean
  /**
   * Optional recurring schedule. When set, the follow-up is delivered by the
   * campaign scheduler to openers only at the scheduled times (one-time /
   * weekly / monthly) — overriding BOTH automatic and manual modes. Omit to
   * keep today's behaviour (automatic = on open, manual = queue).
   */
  schedule?: CampaignScheduleInput | null
  /** Batch sending configuration (same fields as Campaigns). */
  send_in_batches?: boolean
  batch_size?: number
  first_batch_delay_hours?: number
  subsequent_batch_delay_hours?: number
}

export interface UpdateFollowupConfigPayload {
  followup_mode?: FollowupMode
  is_active?: boolean
}

export interface SendSelectedFollowupsPayload {
  contact_ids: string[]
  followup_campaign_id: string | null
}

export interface SendSelectedFollowupResult {
  contact_id: string
  name: string
  email: string
  status: 'sent' | 'skipped' | 'failed'
  reason?: string
}

/**
 * A contact who actually opened a campaign (`email_logs.opened = true`).
 * Returned by GET /api/campaigns/:id/opened-contacts and used by MANUAL
 * follow-up mode to let the user pick who receives the follow-up.
 */
export interface OpenedContact {
  contact_id: string
  name: string
  email: string
  company: string
  designation: string
  opened_at: string | null
  campaign_id: string
}

/**
 * Recurring schedule settings persisted to the `campaign_schedules` table.
 * Mirrors the DB columns (snake_case).
 */
export interface CampaignScheduleInput {
  schedule_type: ScheduleType
  start_date?: string | null
  send_time?: string | null
  repeat_interval?: number | null
  weekly_days?: string[] | null
  monthly_type?: MonthlyScheduleType | null
  day_of_month?: number | null
  week_number?: string | null
  weekday?: string | null
  timezone?: string | null
}
