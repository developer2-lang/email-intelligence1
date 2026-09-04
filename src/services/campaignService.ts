import { supabase } from '../supabase'
import { normalizeCampaignType } from '../constants/constants'
import type {
  Campaign,
  CampaignAttachment,
  CampaignInput,
  CampaignRow,
  CampaignScheduleInput,
  EmailTemplate,
  FollowupConfig,
  FollowupMode,
} from '../types/campaign'

const CAMPAIGNS_TABLE = 'campaigns'
const TEMPLATES_TABLE = 'templates'
/** Existing template Storage bucket (built-in storage-backed templates like
 * 'IUOVA Attractive' already read from it via templates.storage_bucket). */
const TEMPLATES_BUCKET = 'email template'
const CAMPAIGN_SCHEDULES_TABLE = 'campaign_schedules'
const ANALYTICS_TABLE = 'campaign_analytics'
const EMAIL_LOGS_TABLE = 'email_logs'
const CAMPAIGN_ATTACHMENTS_TABLE = 'campaign_attachments'
const CAMPAIGN_ATTACHMENTS_BUCKET = 'campaign-attachments'

// Gmail's practical message size limit is ~25 MB total; keep a single file at
// 20 MB so the base64 overhead still fits inside one email.
const MAX_ATTACHMENT_FILE_SIZE = 20 * 1024 * 1024

/** Human-readable file size, e.g. 1432 → "1.4 KB", 2048576 → "2 MB". */
export function formatFileSize(bytes: number): string {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / Math.pow(1024, unit)
  const text = unit === 0 || scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1)
  return `${text} ${units[unit]}`
}

const SCHEDULE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format an ordinal suffix for a day of month (1st, 2nd, 3rd, 11th, 21st...).
 */
function ordinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/**
 * "2026-08-10" → "Aug 10, 2026". Also tolerates full ISO timestamps
 * ("2026-08-10T00:00:00.000Z"). Returns the raw string when unparseable.
 */
function formatScheduleDate(input?: string | null): string {
  if (!input) return ''
  const trimmed = String(input).trim()
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/)
  if (!m) return trimmed
  return `${SCHEDULE_MONTHS[Number(m[2]) - 1]} ${String(Number(m[3])).padStart(2, '0')}, ${m[1]}`
}

function scheduleTime(input?: string | null): string {
  const t = formatTime(input)
  return t === '—' ? '' : t
}

/**
 * Format the actual send timestamp (sent_at) as a local "Aug 10, 2026 • 12:45 AM"
 * string, used for the Schedule column of campaigns sent immediately (Send Now).
 * Returns '' when sent_at is absent or unparseable.
 */
function formatSentAt(input?: string | null): string {
  if (!input) return ''
  const date = new Date(String(input).trim())
  if (isNaN(date.getTime())) return ''
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
  const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${dateStr} • ${timeStr}`
}

function parseWeeklyDays(value?: string | null): string[] {
  if (!value) return []
  return String(value).split(',').map((d) => d.trim()).filter(Boolean)
}

/**
 * Generate a human-readable schedule string from a `campaign_schedules` row.
 *
 *   one_time: "Aug 10, 2026 • 10:00 AM"
 *   weekly:   "Every Monday • 10:00 AM" / "Every Mon, Wed, Fri • 09:00 AM"
 *             "Every 2 Weeks • Monday • 10:00 AM"
 *   monthly:  "15th of every month • 11:30 AM" / "First Monday every month • 10:00 AM"
 *             "Every 3 Months • Last Friday • 5:00 PM"
 *
 * Returns '--' when no usable schedule is present.
 */
export function buildScheduleText(row: Record<string, any> | null | undefined): string {
  if (!row || !row.schedule_type) return '--'
  const timeSuffix = scheduleTime(row.send_time)
  const time = timeSuffix ? ` • ${timeSuffix}` : ''
  const interval = Math.max(1, Number(row.repeat_interval) || 1)

  if (row.schedule_type === 'one_time') {
    const d = formatScheduleDate(row.start_date)
    return d ? `${d}${time}` : (timeSuffix || '--')
  }

  if (row.schedule_type === 'weekly') {
    const days = parseWeeklyDays(row.weekly_days)
    let core: string
    if (interval > 1) {
      const dayPart =
        days.length === 0
          ? ''
          : days.length === 1
            ? days[0]
            : days.map((d) => d.slice(0, 3)).join(', ')
      core = dayPart ? `Every ${interval} Weeks • ${dayPart}` : `Every ${interval} Weeks`
    } else {
      const dayPart =
        days.length === 0
          ? 'Week'
          : days.length === 1
            ? ` ${days[0]}`
            : ` ${days.map((d) => d.slice(0, 3)).join(', ')}`
      core = `Every${dayPart}`
    }
    return `${core}${time}`
  }

  if (row.schedule_type === 'monthly') {
    if (row.monthly_type === 'weekday' && row.week_number && row.weekday) {
      const rule = `${row.week_number} ${row.weekday}`
      const core = interval > 1 ? `Every ${interval} Months • ${rule}` : `${rule} every month`
      return `${core}${time}`
    }
    const dom = ordinal(Math.max(1, Number(row.day_of_month) || 1))
    const core = interval > 1 ? `Every ${interval} Months • ${dom}` : `${dom} of every month`
    return `${core}${time}`
  }

  return '--'
}

/**
 * Fetch all campaign_schedules rows keyed by campaign_id.
 * Best-effort: returns {} on any failure so the table still renders.
 */
export async function fetchCampaignSchedules(): Promise<Record<string, Record<string, any>>> {
  try {
    const { data, error } = await supabase
      .from(CAMPAIGN_SCHEDULES_TABLE)
      .select('*')
    if (error) return {}
    const byCampaign: Record<string, Record<string, any>> = {}
    for (const row of (data as Record<string, any>[] | null) ?? []) {
      if (row.campaign_id) byCampaign[String(row.campaign_id)] = row
    }
    return byCampaign
  } catch {
    return {}
  }
}

/**
 * Best-effort cloud mirror of the backend's campaign metrics decoration
 * (backend/services/campaignService.js — listCampaignsFlow). Used when the
 * local backend is unreachable so the Campaigns page still shows live
 * sent/delivered/opened/clicked counts and rates from Supabase.
 *
 * campaign_analytics is the source of truth (maintained by the tracking RPCs +
 * worker sync); email_logs stats are the fallback for rows that predate the
 * analytics table — merged with the exact same precedence as the backend.
 */
async function decorateCampaignRowsWithMetrics(
  rows: CampaignRow[]
): Promise<CampaignRow[]> {
  if (rows.length === 0) return rows
  const ids = rows.map((r) => r.id)

  const { data: analyticsRows } = await supabase
    .from(ANALYTICS_TABLE)
    .select('*')
    .in('campaign_id', ids)

  const { data: logs } = await supabase
    .from(EMAIL_LOGS_TABLE)
    .select('campaign_id, status, opened, clicked')
    .in('campaign_id', ids)

  const analyticsByCampaign: Record<string, Record<string, any>> = {}
  for (const row of (analyticsRows as Record<string, any>[] | null) ?? []) {
    if (row.campaign_id) analyticsByCampaign[String(row.campaign_id)] = row
  }

  const statsByCampaign: Record<string, { delivered: number; opened: number; clicked: number; open_rate: number; click_rate: number }> = {}
  for (const id of ids) {
    statsByCampaign[id] = { delivered: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0 }
  }
  for (const log of (logs as Record<string, any>[] | null) ?? []) {
    const stats = statsByCampaign[String(log.campaign_id)]
    if (!stats) continue
    if (log.status === 'sent') stats.delivered++
    if (log.opened === true) stats.opened++
    if (log.clicked === true) stats.clicked++
  }
  for (const id of ids) {
    const stats = statsByCampaign[id]
    stats.open_rate = stats.delivered > 0
      ? Number(((stats.opened / stats.delivered) * 100).toFixed(1))
      : 0
    stats.click_rate = stats.delivered > 0
      ? Number(((stats.clicked / stats.delivered) * 100).toFixed(1))
      : 0
  }

  return rows.map((campaign) => {
    const id = String(campaign.id)
    const a = analyticsByCampaign[id]
    const stats = statsByCampaign[id] || { delivered: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0 }

    const delivered = a && a.delivered != null ? Number(a.delivered) : Number(stats.delivered) || 0
    const opened = a && a.opened != null ? Number(a.opened) : Number(stats.opened) || 0
    const clicked = a && a.clicked != null ? Number(a.clicked) : Number(stats.clicked) || 0

    // Rates are ALWAYS recomputed from the merged counts so the displayed
    // percentage always equals the displayed X/Y ratio (unique opened/clicked
    // recipients ÷ delivered) — never a stale campaign_analytics rate. When the
    // analytics row is in sync this yields the exact stored value; when it is
    // not, the Campaigns table still shows a self-consistent percentage.
    const open_rate = delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0
    const click_rate = delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0

    return {
      ...campaign,
      delivered,
      opened,
      clicked,
      sent_count: delivered,
      delivered_count: delivered,
      opened_count: opened,
      clicked_count: clicked,
      open_rate,
      click_rate,
      recipient_count: Number(campaign.recipient_count) || 0,
    }
  })
}

/**
 * Resolve the schedule text for a campaign row.
 * Uses campaign.schedule_text when present, otherwise generates it from the
 * linked campaign_schedules row. Falls back to the campaign's legacy
 * schedule_date/schedule_time columns (one-time schedule), then '--'.
 */
function resolveScheduleText(
  row: Record<string, any>,
  scheduleRow?: Record<string, any> | null
): string {
  if (row.schedule_text || row.scheduleText) return String(row.schedule_text || row.scheduleText)
  if (scheduleRow) {
    const text = buildScheduleText(scheduleRow)
    if (text !== '--') return text
  }
  const legacyDate = formatScheduleDate(row.schedule_date)
  const legacyTime = scheduleTime(row.schedule_time)
  if (legacyDate && legacyTime) return `${legacyDate} • ${legacyTime}`
  if (legacyDate) return legacyDate
  if (legacyTime) return legacyTime
  // Campaigns sent immediately (Send Now) have no schedule info — show the
  // actual send timestamp recorded in sent_at. Drafts must stay '--'.
  if (String(row.status || '').toLowerCase() === 'sent') {
    const sentText = formatSentAt(row.sent_at)
    if (sentText) return sentText
  }
  return '--'
}

/**
 * Map the composer's recurring-schedule UI state into a CampaignScheduleInput
 * that can be sent with the send/schedule payload and persisted to
 * `campaign_schedules`.
 *
 * - One Time: start_date = picked date, time = picked time.
 * - Weekly / Monthly: start_date defaults to today (the UI hides the date picker
 *   for recurring types); repeat settings are included.
 * - Monthly weekday rule ("First Monday") is split into week_number + weekday.
 */
export function buildScheduleInput(opts: {
  scheduleType: 'one_time' | 'weekly' | 'monthly'
  compDate: string
  compTime: string
  repeatEvery: number
  selectedDays: string[]
  monthlyOption: 'day' | 'weekday'
  dayOfMonth: number
  weekdayRule: string
}): CampaignScheduleInput {
  const recurring = opts.scheduleType !== 'one_time'
  const weekdaySplit = opts.weekdayRule.split(/\s+/)
  return {
    schedule_type: opts.scheduleType,
    start_date: recurring ? new Date().toISOString().slice(0, 10) : (opts.compDate || null),
    send_time: opts.compTime || null,
    repeat_interval: recurring ? opts.repeatEvery : null,
    weekly_days:
      opts.scheduleType === 'weekly' && opts.selectedDays.length > 0 ? opts.selectedDays : null,
    monthly_type:
      opts.scheduleType === 'monthly'
        ? opts.monthlyOption === 'day'
          ? 'day_of_month'
          : 'weekday'
        : null,
    day_of_month:
      opts.scheduleType === 'monthly' && opts.monthlyOption === 'day' ? opts.dayOfMonth : null,
    week_number:
      opts.scheduleType === 'monthly' && opts.monthlyOption === 'weekday'
        ? weekdaySplit[0] || null
        : null,
    weekday:
      opts.scheduleType === 'monthly' && opts.monthlyOption === 'weekday'
        ? weekdaySplit[1] || null
        : null,
  }
}

function toInsertRow(input: CampaignInput) {
  return {
    campaign_name: input.campaign_name.trim(),
    subject_line: input.subject_line?.trim() || null,
    from_name: input.from_name?.trim() || null,
    audience_segment: input.audience_segment?.trim() || null,
    campaign_type: input.campaign_type?.trim() || null,
    schedule_date: input.schedule_date || null,
    schedule_time: input.schedule_time?.trim() || null,
    email_body: input.email_body || null,
    html_content: input.html_content || input.email_body || null,
    template_name: input.template_name?.trim() || null,
    status: input.status || 'draft',
    updated_at: new Date().toISOString(),
  }
}

/**
 * Formats a stored time value as a 12-hour clock string (e.g. "10:30 AM").
 * Handles already-12h strings ("02:15 PM"), 24h times ("14:15", "14:15:00"),
 * and ISO timestamps (sent_at) converted to the viewer's local time.
 */
function formatTime(input?: string | null): string {
  if (!input) return '—'
  const trimmed = input.trim()
  if (/^(0?[1-9]|1[0-2]):[0-5]\d(:[0-5]\d)?\s*[APap][Mm]$/.test(trimmed)) {
    const m = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([APap][Mm])$/)
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]} ${m[3].toUpperCase()}`
  }
  if (trimmed.includes('T')) {
    const date = new Date(trimmed)
    if (!isNaN(date.getTime())) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
    }
  }
  const m = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    let h = parseInt(m[1], 10)
    const min = m[2]
    const suffix = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return `${String(h).padStart(2, '0')}:${min} ${suffix}`
  }
  return trimmed
}

function mapRowToCampaign(
  row: CampaignRow,
  scheduleRow?: Record<string, any> | null
): Campaign {
  const status = row.status || 'draft'
  const isSent = status.toLowerCase() === 'sent'

  const deliveredCount =
    typeof row.delivered_count === 'number' ? row.delivered_count : row.recipient_count || 0
  const sentCount =
    typeof row.sent_count === 'number' ? row.sent_count : deliveredCount
  const openedCount =
    typeof row.opened_count === 'number' ? row.opened_count : 0
  const clickedCount =
    typeof row.clicked_count === 'number' ? row.clicked_count : 0
  const openRate =
    typeof row.open_rate === 'number' ? row.open_rate : 0
  const clickRate =
    typeof row.click_rate === 'number' ? row.click_rate : 0

  const time =
    status.toLowerCase() === 'scheduled'
      ? formatTime(row.schedule_time)
      : isSent
        ? formatTime(row.sent_at)
        : '—'

  return {
    id: String(row.id),
    name: row.campaign_name || '',
    type: status.toLowerCase() === 'draft' ? 'Draft' : 'Campaign',
    audience: row.audience_segment || '',
    sent: deliveredCount,
    opened: openedCount,
    clicked: clickedCount,
    bounced: 0,
    status,
    date:
      row.schedule_date ||
      (isSent && row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '—'),
    subject: row.subject_line || 'No Subject',
    fromName: row.from_name || '',
    campaignType: normalizeCampaignType(row.campaign_type),
    scheduleDate: row.schedule_date || '',
    scheduleTime: row.schedule_time || '',
    emailBody: row.html_content || row.email_body || '',
    templateName: row.template_name || '',
    mailchimpCampaignId: row.mailchimp_campaign_id || '',
    recipientCount: row.recipient_count || 0,
    sentAt: row.sent_at || '',
    scheduledAt: row.scheduled_at || '',
    deliveredCount,
    sentCount,
    openedCount,
    clickedCount,
    openRate,
    clickRate,
    time,
    scheduleText: resolveScheduleText(row as Record<string, any>, scheduleRow),
    sendInBatches: row.send_in_batches || false,
    batchSize: row.batch_size || 30,
    firstBatchDelayHours: row.first_batch_delay_hours || 1,
    subsequentBatchDelayHours: row.subsequent_batch_delay_hours || 1,
  }
}

function mapTemplateRow(row: Record<string, any>): EmailTemplate {
  return {
    id: String(row.id),
    key: String(row.key || row.slug || row.id || ''),
    name: row.name || '',
    description: row.description || row.desc || row.summary || '',
    category: row.category || row.cat || 'General',
    subject: row.subject || '',
    body: row.body || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    template_source: row.template_source || 'database',
    storage_bucket: row.storage_bucket || '',
    storage_path: row.storage_path || '',
  }
}

/**
 * Fetch all campaigns directly from Supabase (cloud path — no local backend
 * required). Rows are decorated with live engagement metrics from
 * campaign_analytics / email_logs, exactly as the backend listCampaignsFlow
 * would, and each row is mapped to the UI Campaign shape.
 */
export async function fetchCampaigns(): Promise<{ data: Campaign[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(CAMPAIGNS_TABLE)
      .select('*')
      .neq('campaign_type', 'sequence')
      .order('created_at', { ascending: false })

    if (error) return { data: [], error: error.message }
    const rows = (data as CampaignRow[] | null) ?? []
    const scheduleByCampaign = await fetchCampaignSchedules()
    const decorated = await decorateCampaignRowsWithMetrics(rows)
    return {
      data: decorated.map((r) => mapRowToCampaign(r, scheduleByCampaign[String(r.id)])),
      error: null,
    }
  } catch (err) {
    return {
      data: [],
      error: err instanceof Error ? err.message : 'Failed to fetch campaigns',
    }
  }
}

export async function insertCampaign(input: CampaignInput): Promise<{ data: Campaign | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(CAMPAIGNS_TABLE)
      .insert({ ...toInsertRow(input), created_at: new Date().toISOString() })
      .select('*')

    if (error) return { data: null, error: error.message }
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as CampaignRow) : null
    return { data: row ? mapRowToCampaign(row) : null, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Failed to create campaign' }
  }
}

export async function updateCampaign(id: string, input: CampaignInput): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from(CAMPAIGNS_TABLE)
      .update(toInsertRow(input))
      .eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update campaign' }
  }
}

export async function deleteCampaign(id: string): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(CAMPAIGNS_TABLE).delete().eq('id', id)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete campaign' }
  }
}

export async function deleteCampaigns(ids: string[]): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase.from(CAMPAIGNS_TABLE).delete().in('id', ids)
    return { error: error?.message ?? null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete campaigns' }
  }
}

/**
 * Fetch all active email templates from the `templates` table.
 *
 * Only rows with is_active = true are returned so the composer never offers
 * archived/draft templates.
 */
export async function fetchTemplates(): Promise<{ data: EmailTemplate[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(TEMPLATES_TABLE)
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true })

    if (error) return { data: [], error: error.message }
    const rows = (data as Record<string, any>[] | null) ?? []
    return { data: rows.map(mapTemplateRow), error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch templates' }
  }
}

// ─── HTML email template upload (reuses the existing templates table + the
//     existing `email template` Storage bucket) ─────────────────────────────

const HTML_TEMPLATE_EXT_RE = /\.(html?|htm)$/i

/**
 * Derive a human-readable template name from an uploaded filename.
 * 'my-outreach-template.html' → 'My Outreach Template'
 */
export function templateNameFromFilename(filename: string): string {
  const base = String(filename || '')
    .replace(HTML_TEMPLATE_EXT_RE, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
  return base || 'Uploaded Template'
}

/**
 * Lightweight sanity check that a file holds real HTML email content (at least
 * one opening tag). Placeholders like {{first_name}} are left exactly as
 * authored — validation never rewrites or replaces the content.
 */
function isValidEmailHtml(content: string): boolean {
  const text = String(content || '').trim()
  if (!text) return false
  return /<[a-z][^>]*>/i.test(text)
}

/**
 * Upload a .html/.htm email template through the EXISTING template
 * architecture: the file bytes go to the `email template` Storage bucket and a
 * metadata row is inserted into the `templates` table with
 * template_source='storage' + storage_bucket + storage_path, exactly like the
 * built-in storage-backed templates. The returned template resolves through the
 * same fetchTemplates / template-selection path used everywhere else, so it
 * appears in Load Template and the Template Library immediately and survives a
 * page refresh.
 */
export async function uploadEmailTemplate(file: File): Promise<EmailTemplate> {
  const fileName = String(file.name || '').trim()

  if (!HTML_TEMPLATE_EXT_RE.test(fileName)) {
    throw new Error(
      'Unsupported file type. Only .html and .htm files can be uploaded as email templates.'
    )
  }
  if (file.size <= 0) throw new Error(`'${fileName}' is empty and cannot be uploaded.`)

  const html = await file.text()
  if (!isValidEmailHtml(html)) {
    throw new Error(`'${fileName}' does not contain valid HTML email content.`)
  }

  const templateName = templateNameFromFilename(fileName)
  const path = `uploads/${Date.now()}-${sanitizeStorageName(fileName)}`

  const { error: uploadError } = await supabase.storage
    .from(TEMPLATES_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      contentType: 'text/html',
      upsert: false,
    })
  if (uploadError) {
    throw new Error(`Failed to upload template '${fileName}': ${uploadError.message}`)
  }

  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .insert({
      name: templateName,
      category: 'Uploaded',
      description: 'Uploaded HTML email template',
      subject: '',
      body: html,
      is_active: true,
      template_source: 'storage',
      storage_bucket: TEMPLATES_BUCKET,
      storage_path: path,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (error) {
    // Best-effort rollback of the stored file so a failed save leaves no orphan.
    await supabase.storage.from(TEMPLATES_BUCKET).remove([path])
    throw new Error(`Failed to save template record for '${fileName}': ${error.message}`)
  }

  return mapTemplateRow(data as Record<string, any>)
}

/**
 * Persist visual-editor changes back to an EXISTING template without changing
 * its identity: the template ID, name, category and description stay exactly as
 * authored — only the HTML body (and, for storage-backed templates, the stored
 * file) is replaced.
 *
 * Storage files are replaced by uploading a NEW object and then deleting the
 * old one. The anon/publishable key used by the browser only has INSERT +
 * SELECT + DELETE policies on the `email template` bucket (never UPDATE), so a
 * same-path upsert would be rejected — the delete-after-upload dance keeps the
 * template readable at every step and leaves no orphaned file behind.
 */
export async function updateEmailTemplate(
  template: EmailTemplate,
  html: string
): Promise<EmailTemplate> {
  const content = String(html || '').trim()
  if (!content) throw new Error('Email HTML cannot be empty.')

  const storageBucket = template.storage_bucket || ''
  let storagePath = template.storage_path || ''

  if (template.template_source === 'storage' && storageBucket && storagePath) {
    const fileName = storagePath.split('/').pop() || 'template.html'
    const newPath = `uploads/${Date.now()}-${sanitizeStorageName(fileName)}`

    // 1) Write the new content FIRST (only INSERT needed) so a failure below
    //    never leaves the template file unreadable.
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(newPath, new Blob([content], { type: 'text/html' }), {
        cacheControl: '3600',
        contentType: 'text/html',
        upsert: false,
      })
    if (uploadError) {
      throw new Error(`Failed to save the updated template file: ${uploadError.message}`)
    }

    // 2) Remove the superseded file (best-effort).
    await supabase.storage.from(storageBucket).remove([storagePath])

    storagePath = newPath
  }

  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .update({
      body: content,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      updated_at: new Date().toISOString(),
    })
    .eq('id', template.id)
    .select('*')
    .single()

  if (error) {
    if (storagePath && storagePath !== template.storage_path) {
      await supabase.storage.from(storageBucket).remove([storagePath])
    }
    throw new Error(`Failed to save template '${template.name}': ${error.message}`)
  }

  return mapTemplateRow(data as Record<string, any>)
}

/**
 * Create a BRAND-NEW template row from raw HTML (used by the Template Editor's
 * "+ New Template" → Save and "Save As" flows). Rows are database-backed
 * (template_source = 'database', HTML lives in the `body` column), so they
 * resolve through the exact same fetchTemplates / Load Template / Template
 * Library path as every other template — no second storage system is created.
 */
export async function createEmailTemplate(name: string, html: string): Promise<EmailTemplate> {
  const content = String(html || '').trim()
  const templateName = String(name || '').trim() || 'Untitled Template'
  if (!content) throw new Error('Email HTML cannot be empty.')

  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .insert({
      name: templateName,
      category: 'Custom',
      description: 'Created in the Template Editor',
      subject: '',
      body: content,
      is_active: true,
      template_source: 'database',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single()

  if (error) {
    throw new Error(`Failed to create template '${templateName}': ${error.message}`)
  }

  return mapTemplateRow(data as Record<string, any>)
}

export interface DeleteTemplateResult {
  ok: boolean
  /** True when a campaign currently references this template and it cannot be deleted. */
  inUse: boolean
  error: string | null
}

/**
 * Delete an email template by its REAL database ID (`templates.id`) — never by
 * name. Storage-backed templates also have their HTML file removed from the
 * `email template` bucket (best-effort: the object may already be gone).
 *
 * A template that is still referenced by a campaign (campaigns.template_name)
 * is NOT deleted — the caller gets `{ ok: false, inUse: true }` so the UI can
 * show the "Template In Use" warning instead of silently breaking a live
 * campaign. This is the single delete path shared by Campaigns → Load
 * Template, the Template Library and the Template Editor, so a deletion here
 * disappears from every surface that reads `public.templates`.
 */
export async function deleteEmailTemplate(
  template: EmailTemplate
): Promise<DeleteTemplateResult> {
  try {
    const { data: usingCampaigns, error: usageError } = await supabase
      .from(CAMPAIGNS_TABLE)
      .select('id')
      .eq('template_name', template.name)
    if (usageError) {
      return {
        ok: false,
        inUse: false,
        error: `Failed to check template usage: ${usageError.message}`,
      }
    }
    if ((usingCampaigns ?? []).length > 0) {
      return { ok: false, inUse: true, error: null }
    }

    if (template.template_source === 'storage' && template.storage_bucket && template.storage_path) {
      const { error: storageError } = await supabase.storage
        .from(template.storage_bucket)
        .remove([template.storage_path])
      if (storageError) {
        console.error('Template storage file removal failed:', storageError.message)
      }
    }

    const { error } = await supabase
      .from(TEMPLATES_TABLE)
      .delete()
      .eq('id', template.id)
    if (error) {
      return { ok: false, inUse: false, error: error.message }
    }
    return { ok: true, inUse: false, error: null }
  } catch (err) {
    return {
      ok: false,
      inUse: false,
      error: err instanceof Error ? err.message : 'Failed to delete template',
    }
  }
}

/**
 * Upload an image file into the `email template` Storage bucket's `images/`
 * folder and return its public URL. The browser-visible anon key can INSERT
 * into this bucket (migration 20260819000000) and the bucket is public, so the
 * returned URL renders directly inside sent emails. A new path is generated per
 * upload so an existing image is never overwritten.
 */
export async function uploadEmailImage(file: File): Promise<string> {
  if (file.size <= 0) throw new Error(`'${file.name}' is empty and cannot be uploaded.`)
  const extMatch = String(file.name || '').match(/\.([a-zA-Z0-9]+)$/)
  const ext = extMatch ? extMatch[1].toLowerCase() : 'png'
  const path = `images/${Date.now()}-${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from(TEMPLATES_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'image/png',
      upsert: false,
    })
  if (uploadError) {
    throw new Error(`Failed to upload image '${file.name}': ${uploadError.message}`)
  }

  const { data } = supabase.storage.from(TEMPLATES_BUCKET).getPublicUrl(path)
  if (!data?.publicUrl) {
    throw new Error(`Could not resolve the uploaded image URL (${path}).`)
  }
  return data.publicUrl
}

// ─── Cloud campaign launch (no local backend required) ─────────────────────

export interface CampaignLaunchPayload {
  /** Present when editing an existing campaign row (upsert). */
  id?: string | null
  campaign_name: string
  subject_line: string
  from_name: string
  audience_segment: string
  campaign_type: string
  html_content: string
  schedule_date?: string
  schedule_time?: string
  template_name?: string | null
  /** Recurring schedule settings persisted to `campaign_schedules`. */
  schedule?: CampaignScheduleInput | null
  /**
   * Attachment metadata (files already uploaded to Supabase Storage). Sent Now
   * hands this to the send-campaign Edge Function, which persists it against
   * the campaign and attaches the files to every email.
   */
  attachments?: CampaignAttachmentPayload[]
  /** Batch sending configuration */
  send_in_batches?: boolean
  batch_size?: number
  first_batch_delay_hours?: number
  subsequent_batch_delay_hours?: number
  /** Explicitly selected contact IDs from drag-and-drop (takes precedence over audience_segment) */
  selected_contact_ids?: string[]
}

/**
 * Storage-backed attachment metadata carried in the send/schedule payload.
 * The file bytes never leave Supabase Storage — the senders download them by
 * storage_bucket + storage_path and embed them in the MIME message.
 */
export interface CampaignAttachmentPayload {
  file_name: string
  file_type: string
  file_size: number
  storage_bucket: string
  storage_path: string
}

export interface CampaignLaunchResult {
  campaign_id: string
  status?: string
  message?: string
  scheduled_at?: string
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/**
 * Parse a time string into { hours, minutes, seconds }.
 * Ported from backend/services/campaignScheduler.js.
 */
function parseTime(timeStr?: string | null): { hours: number; minutes: number; seconds: number } | null {
  if (!timeStr) return null
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i)
  if (!match) return null
  let hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const seconds = match[3] ? parseInt(match[3], 10) : 0
  const meridian = (match[4] || '').toUpperCase()
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  if (meridian === 'PM' && hours !== 12) hours += 12
  if (meridian === 'AM' && hours === 12) hours = 0
  return { hours, minutes, seconds }
}

function istDateTimeToUtc(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null
  const dateMatch = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dateMatch) return null
  const time = parseTime(timeStr)
  if (!time) return null
  const year = parseInt(dateMatch[1], 10)
  const month = parseInt(dateMatch[2], 10)
  const day = parseInt(dateMatch[3], 10)
  const localCalendar = new Date(Date.UTC(year, month - 1, day))
  if (
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() !== month - 1 ||
    localCalendar.getUTCDate() !== day
  ) {
    return null
  }
  const asUtc = Date.UTC(year, month - 1, day, time.hours, time.minutes, time.seconds)
  const utcInstant = new Date(asUtc - IST_OFFSET_MS)
  return Number.isNaN(utcInstant.getTime()) ? null : utcInstant
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
}
const WEEK_NUMBERS = ['First', 'Second', 'Third', 'Fourth', 'Last']

function todayISTDateStr(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS)
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * Compute the next run instant (as a UTC Date) for a campaign_schedules row.
 * Ported from backend/services/campaignScheduler.js so cloud-saved schedules
 * carry the same next_run value the backend would have written.
 */
function computeNextRun(schedule: Record<string, any>): Date | null {
  if (!schedule || !schedule.schedule_type) return null
  const time = parseTime(schedule.send_time)
  if (!time) return null

  const anchorStr = schedule.start_date || todayISTDateStr()
  const match = String(anchorStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null

  const nowUtc = Date.now()

  const instant = (y: number, mo: number, d: number) =>
    istDateTimeToUtc(
      `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      schedule.send_time
    )

  if (schedule.schedule_type === 'one_time') {
    return instant(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }

  if (schedule.schedule_type === 'weekly') {
    const days = Array.isArray(schedule.weekly_days)
      ? schedule.weekly_days
      : String(schedule.weekly_days || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (days.length === 0) return null
    const selectedIdx = new Set(days.map((d) => WEEKDAY_INDEX[d]).filter((i) => i != null))
    if (selectedIdx.size === 0) return null

    const interval = Math.max(1, Number(schedule.repeat_interval) || 1)
    const anchorDay = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    const anchorEpochDays = Math.floor(anchorDay.getTime() / 86400000)

    for (let offset = 0; offset < 365; offset++) {
      const candidate = new Date((anchorEpochDays + offset) * 86400000)
      if (!selectedIdx.has(candidate.getUTCDay())) continue
      const weeksElapsed = Math.floor(offset / 7)
      if (weeksElapsed % interval !== 0) continue
      const next = instant(
        candidate.getUTCFullYear(),
        candidate.getUTCMonth(),
        candidate.getUTCDate()
      )
      if (next && next.getTime() >= nowUtc) return next
    }
    return null
  }

  if (schedule.schedule_type === 'monthly') {
    const interval = Math.max(1, Number(schedule.repeat_interval) || 1)
    let y = Number(match[1])
    let mo = Number(match[2]) - 1

    for (let i = 0; i < 120; i++) {
      const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
      let candidateDay

      if (schedule.monthly_type === 'day_of_month') {
        candidateDay = Math.max(1, Math.min(daysInMonth, Number(schedule.day_of_month) || 1))
      } else {
        const wd = WEEKDAY_INDEX[schedule.weekday]
        const wn = WEEK_NUMBERS.indexOf(schedule.week_number)
        if (wd == null || wn === -1) return null

        const firstWeekday = new Date(Date.UTC(y, mo, 1)).getUTCDay()
        if (wn === WEEK_NUMBERS.length - 1) {
          const lastWeekday = new Date(Date.UTC(y, mo, daysInMonth)).getUTCDay()
          candidateDay = daysInMonth - ((lastWeekday - wd + 7) % 7)
        } else {
          candidateDay = 1 + ((wd - firstWeekday + 7) % 7) + wn * 7
        }
      }

      const next = instant(y, mo, candidateDay)
      if (next && next.getTime() >= nowUtc) return next

      const nextMonth = new Date(Date.UTC(y, mo + interval, 1))
      y = nextMonth.getUTCFullYear()
      mo = nextMonth.getUTCMonth()
    }
    return null
  }

  return null
}

function normalizeTimeToStore(timeStr?: string | null): string | null {
  if (!timeStr) return null
  const t = parseTime(timeStr)
  if (!t) return String(timeStr).trim()
  return [
    String(t.hours).padStart(2, '0'),
    String(t.minutes).padStart(2, '0'),
    String(t.seconds).padStart(2, '0'),
  ].join(':')
}

export function buildScheduleRow(input: CampaignScheduleInput): Record<string, any> {
  const row: Record<string, any> = {
    schedule_type: input.schedule_type,
    start_date: input.start_date || null,
    send_time: normalizeTimeToStore(input.send_time),
    repeat_interval:
      input.repeat_interval != null ? Math.max(1, Number(input.repeat_interval) || 1) : 1,
    weekly_days:
      Array.isArray(input.weekly_days) && input.weekly_days.length > 0
        ? input.weekly_days.join(', ')
        : null,
    monthly_type: input.monthly_type || null,
    day_of_month: input.day_of_month != null ? Number(input.day_of_month) : null,
    week_number: input.week_number || null,
    weekday: input.weekday || null,
    timezone: input.timezone || 'Asia/Kolkata',
  }
  const next = computeNextRun(row)
  return { ...row, next_run: next ? next.toISOString() : null }
}

function buildCampaignRecord(payload: CampaignLaunchPayload, status: string): Record<string, any> {
  const subjectLine = payload.subject_line !== undefined ? payload.subject_line : undefined

  const missing: string[] = []
  if (!payload.campaign_name || !String(payload.campaign_name).trim()) missing.push('campaign_name')
  if (subjectLine === undefined || subjectLine === null || !String(subjectLine).trim()) missing.push('subject_line')
  if (!payload.from_name || !String(payload.from_name).trim()) missing.push('from_name')
  if (!payload.audience_segment || !String(payload.audience_segment).trim()) missing.push('audience_segment')
  if (!payload.html_content || !String(payload.html_content).trim()) missing.push('html_content')
  if (missing.length > 0) throw new Error(`Missing required fields: ${missing.join(', ')}`)

  const record: Record<string, any> = {
    id: payload.id ? String(payload.id) : null,
    campaign_name: String(payload.campaign_name).trim(),
    subject_line: String(subjectLine).trim(),
    from_name: String(payload.from_name).trim(),
    audience_segment: String(payload.audience_segment).trim(),
    campaign_type: String(payload.campaign_type || 'Campaign').trim(),
    email_body: payload.html_content,
    html_content: payload.html_content,
    template_name: payload.template_name ? String(payload.template_name).trim() : null,
    schedule_date: payload.schedule_date ? String(payload.schedule_date).trim() : null,
    schedule_time: payload.schedule_time ? String(payload.schedule_time).trim() : null,
    status,
  }

  // Persist batch-sending configuration so the scheduler's isBatchedCampaignDue
  // can pace subsequent batches correctly. Without this, a scheduled or draft
  // campaign with batching enabled would lose send_in_batches and send to all
  // recipients at once when the scheduler picks it up.
  if (payload.send_in_batches) {
    record.send_in_batches = true
    record.batch_size = Number(payload.batch_size) > 0 ? Number(payload.batch_size) : 30
    record.first_batch_delay_hours = Number.isFinite(Number(payload.first_batch_delay_hours))
      ? Number(payload.first_batch_delay_hours)
      : 2
    record.subsequent_batch_delay_hours = Number.isFinite(Number(payload.subsequent_batch_delay_hours))
      ? Number(payload.subsequent_batch_delay_hours)
      : 1
  } else {
    record.send_in_batches = false
    record.current_batch_number = 0
    record.next_batch_at = null
  }

  return record
}

async function saveCampaignCloud(record: Record<string, any>): Promise<any> {
  const { id, ...fields } = record
  const base = { ...fields, updated_at: new Date().toISOString() }

  if (id) {
    const { data, error } = await supabase
      .from(CAMPAIGNS_TABLE)
      .update(base)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new Error(`Failed to save campaign: ${error.message}`)
    return data
  }

  const { data, error } = await supabase
    .from(CAMPAIGNS_TABLE)
    .insert({ ...base, created_at: new Date().toISOString() })
    .select('*')
    .single()
  if (error) throw new Error(`Failed to save campaign: ${error.message}`)
  return data
}

async function persistScheduleIfPresent(saved: any, payload: CampaignLaunchPayload): Promise<void> {
  if (
    !payload.schedule ||
    !['one_time', 'weekly', 'monthly'].includes(payload.schedule.schedule_type)
  ) {
    return
  }
  const row = buildScheduleRow(payload.schedule)
  const { error: deleteError } = await supabase
    .from(CAMPAIGN_SCHEDULES_TABLE)
    .delete()
    .eq('campaign_id', saved.id)
  if (deleteError) throw new Error(`Failed to clear previous campaign schedule: ${deleteError.message}`)

  const { error } = await supabase
    .from(CAMPAIGN_SCHEDULES_TABLE)
    .insert({ campaign_id: saved.id, ...row })
  if (error) throw new Error(`Failed to save campaign schedule: ${error.message}`)
}

/**
 * Pull the real reason out of an invoke error. `FunctionsHttpError` wraps the
 * function's Response in `error.context`; without this the UI would only ever
 * show the SDK's generic "Edge Function returned a non-2xx status code".
 */
async function extractFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: string } | null
      if (body?.error) return body.error
    } catch {
      // Response body not JSON — fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : 'Failed to send campaign'
}

/**
 * Send Now — cloud path. Invokes the `send-campaign` Edge Function which sends
 * directly to Gmail SMTP, so no local backend is required. Returns the same
 * envelope shape the backend returned (campaign_id + status).
 */
export async function sendCampaign(payload: CampaignLaunchPayload): Promise<CampaignLaunchResult> {
  const { data, error } = await supabase.functions.invoke('send-campaign', { body: payload })
  if (error) {
    throw new Error(await extractFunctionError(error))
  }
  const body = data as { success?: boolean; data?: CampaignLaunchResult; error?: { message?: string } } | null
  if (!body || body.success === false) {
    throw new Error(body?.error?.message || 'Failed to send campaign')
  }
  return body.data || { campaign_id: '' }
}

/**
 * Schedule — cloud path. Validates, saves the campaign as "scheduled", and
 * persists the schedule to `campaign_schedules`. Future sending stays on the
 * pg_cron → scheduled-campaign-runner path (nothing here waits for the time).
 */
export async function scheduleCampaign(payload: CampaignLaunchPayload): Promise<CampaignLaunchResult> {
  const record = buildCampaignRecord(payload, 'scheduled')
  const saved = await saveCampaignCloud(record)
  await persistScheduleIfPresent(saved, payload)
  return {
    campaign_id: String(saved.id),
    status: 'scheduled',
    scheduled_at: `${payload.schedule_date} ${payload.schedule_time}`,
    message: 'Campaign scheduled.',
  }
}

/**
 * Save Draft — cloud path. Validates and saves the campaign as a draft.
 */
export async function saveDraft(payload: CampaignLaunchPayload): Promise<CampaignLaunchResult & Record<string, any>> {
  const record = buildCampaignRecord(payload, 'draft')
  const saved = await saveCampaignCloud(record)
  await persistScheduleIfPresent(saved, payload)
  return saved
}

// ─── Campaign attachments (Supabase Storage) ───────────────────────────────

/**
 * Strip characters that are unsafe in a Storage object path (slash, quotes,
 * control chars) and transliterate accents so file names stay filesystem- and
 * URL-friendly. Always falls back to a plain, non-empty name.
 */
function sanitizeStorageName(name: string): string {
  const base = String(name || 'file')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return base || 'file'
}

/**
 * Sanitize a campaign name for use as a Storage folder segment. Spaces are kept
 * (folders may contain spaces) but runs of whitespace are collapsed and leading
 * / trailing whitespace and dots are stripped. Characters that are unsafe in
 * Storage paths (slashes, control characters, quotes, etc.) are replaced so the
 * readable campaign name still maps to a valid folder.
 */
export function sanitizeCampaignFolderName(name: string): string {
  const cleaned = String(name || '')
    .replace(/[/\\]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
  const base = [...cleaned]
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 120)
  return base || 'campaign'
}

/** Load the stored campaign_name of an existing campaign (used for the attachment folder). */
async function fetchCampaignName(campaignId: string): Promise<string> {
  const { data, error } = await supabase
    .from(CAMPAIGNS_TABLE)
    .select('campaign_name')
    .eq('id', campaignId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the campaign for this attachment: ${error.message}`)
  if (!data || !data.campaign_name) throw new Error('Campaign has no name to use for the attachment folder.')
  return String(data.campaign_name).trim()
}

/**
 * Relocate a Storage object within a bucket using ONLY the existing anon
 * policies (SELECT on the public bucket + INSERT + DELETE). The Storage `move()`
 * API requires an UPDATE policy, which this project does not grant to the anon
 * role, so the bytes are read from the object's public URL, re-uploaded under
 * the final path, and the source is removed (best-effort cleanup).
 */
async function relocateStorageObject(bucket: string, fromPath: string, toPath: string): Promise<void> {
  if (fromPath === toPath) return
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fromPath)
  if (!urlData?.publicUrl) throw new Error(`Could not resolve the uploaded file URL (${fromPath}).`)
  const response = await fetch(urlData.publicUrl)
  if (!response.ok) throw new Error(`Failed to read the uploaded file from Storage (HTTP ${response.status}).`)
  const blob = await response.blob()
  const { error: uploadError } = await supabase.storage.from(bucket).upload(toPath, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  })
  if (uploadError) throw new Error(`Failed to store the attachment under the campaign folder: ${uploadError.message}`)
  const { error: removeError } = await supabase.storage.from(bucket).remove([fromPath])
  if (removeError) console.error('[Campaign Attachment] Temp file cleanup failed:', removeError.message)
}

/**
 * Move a brand-new composer's not-yet-persisted attachments (uploaded to a
 * temporary path before the campaign existed) into the campaign's Storage folder
 * (`campaign-attachments/{campaign_name}/{file_name}`) so storage_path always
 * matches the real object location. Attachments already persisted under a
 * campaign (persisted !== false) are returned unchanged.
 */
export async function relocatePendingAttachments(
  campaignName: string,
  attachments: CampaignAttachment[]
): Promise<CampaignAttachment[]> {
  const folder = sanitizeCampaignFolderName(campaignName)
  const result: CampaignAttachment[] = []
  for (const att of attachments) {
    if (att.persisted !== false) {
      result.push(att)
      continue
    }
    const oldPath = att.storage_path
    const fileName = oldPath.split('/').pop() || sanitizeStorageName(att.file_name)
    const newPath = `${folder}/${fileName}`
    if (oldPath === newPath) {
      result.push({ ...att, storage_path: newPath, persisted: true })
      continue
    }
    await relocateStorageObject(att.storage_bucket || CAMPAIGN_ATTACHMENTS_BUCKET, oldPath, newPath)
    console.log(`[Campaign Attachment] Moved ${oldPath} → ${newPath}`)
    result.push({ ...att, storage_path: newPath, persisted: true })
  }
  return result
}

/**
 * Upload a file to Supabase Storage (`campaign-attachments` bucket) and return
 * the attachment metadata for the composer.
 *
 * - With an existing `campaignId`: the campaign_name is fetched from the
 *   `campaigns` record, the file is uploaded DIRECTLY into
 *   `campaign-attachments/{campaign_name}/{file_name}`, the metadata is
 *   persisted as a `campaign_attachments` row immediately, and the REAL database
 *   record is returned (persisted=true).
 * - Without a campaign id (brand-new composer): the file is uploaded to a
 *   temporary path only; no `campaigns` / `campaign_attachments` row is created
 *   (a campaign must never be inserted without its required subject_line). A
 *   temporary record (campaign_id = '', persisted = false) is kept in composer
 *   state and relocated into `campaign-attachments/{campaign_name}/{file_name}`
 *   once the campaign is saved (Save Draft / Send Now / Schedule).
 *
 * The file name is sanitized so collisions are impossible and the binary is
 * never stored in the campaigns table.
 */
export async function uploadCampaignAttachment(
  file: File,
  campaignId?: string | null
): Promise<CampaignAttachment> {
  if (file.size <= 0) throw new Error(`'${file.name}' is empty and cannot be uploaded.`)
  if (file.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new Error(`'${file.name}' exceeds the 20 MB per-file limit.`)
  }

  const fileName = sanitizeStorageName(file.name)

  // Brand-new composer (no campaign id yet): upload to a temporary path and keep
  // the metadata in composer state. No campaign row is created — the file is
  // moved into the campaign folder once the campaign is saved.
  if (!campaignId) {
    const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}/${fileName}`
    const { error } = await supabase.storage.from(CAMPAIGN_ATTACHMENTS_BUCKET).upload(path, file, {
      cacheControl: '3600',
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
    if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`)
    console.log(`[Campaign Attachment] Upload successful: ${CAMPAIGN_ATTACHMENTS_BUCKET}/${path}`)
    console.log(`[Campaign Attachment] No campaign yet — keeping '${file.name}' in temporary composer state.`)
    return {
      id: `temp-${crypto.randomUUID()}`,
      campaign_id: '',
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: CAMPAIGN_ATTACHMENTS_BUCKET,
      storage_path: path,
      persisted: false,
    }
  }

  // Existing campaign: upload directly into the campaign's folder using its
  // stored campaign_name, then persist the metadata row with the real
  // campaign_id / storage_bucket / storage_path.
  const campaignName = await fetchCampaignName(String(campaignId))
  const folder = sanitizeCampaignFolderName(campaignName)
  const path = `${folder}/${fileName}`
  const { error } = await supabase.storage.from(CAMPAIGN_ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(`Upload failed for '${file.name}': ${error.message}`)
  console.log(`[Campaign Attachment] Upload successful: ${CAMPAIGN_ATTACHMENTS_BUCKET}/${path}`)

  const owningCampaignId = String(campaignId)
  const { data: inserted, error: dbError } = await supabase
    .from(CAMPAIGN_ATTACHMENTS_TABLE)
    .insert({
      campaign_id: owningCampaignId,
      file_name: file.name,
      file_type: file.type || 'application/octet-stream',
      file_size: file.size,
      storage_bucket: CAMPAIGN_ATTACHMENTS_BUCKET,
      storage_path: path,
    })
    .select('*')
    .single()
  if (dbError) throw new Error(`Failed to save attachment record for '${file.name}': ${dbError.message}`)
  console.log(`[Campaign Attachment] DB record created: ${inserted.id} for campaign ${owningCampaignId}`)

  return { ...(inserted as CampaignAttachment), persisted: true }
}

/** Fetch the attachment metadata rows saved against a campaign. */
export async function fetchCampaignAttachments(
  campaignId: string
): Promise<{ data: CampaignAttachment[]; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from(CAMPAIGN_ATTACHMENTS_TABLE)
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: true })
    if (error) return { data: [], error: error.message }
    return { data: (data as CampaignAttachment[] | null) ?? [], error: null }
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to fetch attachments' }
  }
}

/**
 * Replace the campaign's attachment metadata with the given list (delete +
 * re-insert, so removed files drop out of the saved campaign). Called after a
 * campaign is saved/scheduled as a draft; the Send Now path persists the list
 * inside the send-campaign Edge Function instead.
 */
export async function replaceCampaignAttachments(
  campaignId: string,
  attachments: CampaignAttachmentPayload[]
): Promise<{ error: string | null }> {
  try {
    const { error: deleteError } = await supabase
      .from(CAMPAIGN_ATTACHMENTS_TABLE)
      .delete()
      .eq('campaign_id', campaignId)
    if (deleteError) return { error: `Failed to clear previous attachments: ${deleteError.message}` }

    const rows = attachments
      .filter((a) => a.storage_path)
      .map((a) => ({
        campaign_id: campaignId,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        storage_bucket: a.storage_bucket,
        storage_path: a.storage_path,
      }))
    if (rows.length === 0) return { error: null }

    const { error } = await supabase.from(CAMPAIGN_ATTACHMENTS_TABLE).insert(rows)
    if (error) return { error: `Failed to save attachments: ${error.message}` }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save attachments' }
  }
}

/**
 * Remove an attachment: deletes the Storage object (best-effort — it may
 * already be gone) and, when the file was persisted against a campaign, its
 * metadata row.
 */
export async function removeCampaignAttachment(
  attachment: CampaignAttachment
): Promise<{ error: string | null }> {
  const { error: storageError } = await supabase.storage
    .from(attachment.storage_bucket || CAMPAIGN_ATTACHMENTS_BUCKET)
    .remove([attachment.storage_path])
  if (storageError) {
    console.error('Attachment storage removal failed:', storageError.message)
  }

  if (attachment.campaign_id && attachment.id) {
    const { error: dbError } = await supabase
      .from(CAMPAIGN_ATTACHMENTS_TABLE)
      .delete()
      .eq('id', attachment.id)
    if (dbError) return { error: `Failed to remove attachment: ${dbError.message}` }
  }
  return { error: null }
}

// ─── Follow-up config (cloud path, mirrors followupService.js) ─────────────

export async function fetchFollowupConfig(campaignId: string): Promise<FollowupConfig | null> {
  try {
    const { data, error } = await supabase
      .from('campaign_followups')
      .select('*')
      .eq('campaign_id', campaignId)
      .maybeSingle()
    if (error) return null
    return (data as FollowupConfig | null) ?? null
  } catch {
    return null
  }
}

export async function saveFollowupConfig(
  campaignId: string,
  config: { is_active: boolean; followup_mode: FollowupMode; followup_campaign_id: string | null }
): Promise<FollowupConfig | null> {
  const active = Boolean(config.is_active)
  const followupCampaignId = config.followup_campaign_id
    ? String(config.followup_campaign_id).trim()
    : null

  // Disabled / no follow-up campaign selected → clear the stored config.
  if (!active || !followupCampaignId) {
    const { error } = await supabase
      .from('campaign_followups')
      .delete()
      .eq('campaign_id', campaignId)
    if (error) throw new Error(`Failed to clear follow-up settings: ${error.message}`)
    return null
  }

  if (String(followupCampaignId) === String(campaignId)) {
    throw new Error('A campaign cannot be its own follow-up campaign')
  }

  const mode = config.followup_mode === 'automatic' ? 'automatic' : 'manual'

  // Replace any existing row for this campaign (mirrors the backend).
  const { error: deleteError } = await supabase
    .from('campaign_followups')
    .delete()
    .eq('campaign_id', campaignId)
  if (deleteError) throw new Error(`Failed to replace follow-up settings: ${deleteError.message}`)

  const { data, error } = await supabase
    .from('campaign_followups')
    .insert({
      campaign_id: campaignId,
      followup_campaign_id: followupCampaignId,
      trigger_type: 'opened',
      followup_mode: mode,
      is_active: true,
    })
    .select('*')
    .single()
  if (error) throw new Error(`Failed to save follow-up settings: ${error.message}`)
  return (data as FollowupConfig | null) ?? null
}

// ─── Broken image URL fixup ────────────────────────────────────────────────
// Imported templates (especially from Mailchimp) may contain external image
// URLs that have since been deleted or restricted (403/404). When the
// corresponding images exist in the 'email template' Storage bucket, this
// helper swaps the broken <img src> with the correct Supabase Storage public
// URL so the template renders in the editor and at send time.
//
// Every replacement is logged to the console for debugging.

const SUPABASE_STORAGE_BASE =
  `https://novreeapdwjnpzflyiey.supabase.co/storage/v1/object/public/${encodeURIComponent(TEMPLATES_BUCKET)}/images/`

/**
 * Known broken external image URLs → correct Supabase Storage path mappings.
 * Keys are substrings matched inside the `<img src="…">` attribute value.
 * Values are the Storage filename (inside the `images/` prefix).
 */
const BROKEN_URL_MAP: Record<string, string> = {
  'dim.mcusercontent.com/cs/dd402479fe7ccc7f2368df88d/images/bd92a65e-d695-3e45-ff13-1db600fa2d42.png':
    '1787132745709-12c51e99-a810-4177-a6eb-e786c09414b5.png',
  'mcusercontent.com/dd402479fe7ccc7f2368df88d/images/cb81ce7c-f511-f4fe-b1f4-61d40d079f8d.png':
    '1787132938768-8e65639a-9623-47f8-971c-e5ca9c664a87.png',
  'mcusercontent.com/dd402479fe7ccc7f2368df88d/images/49537ed3-8501-6626-0d3e-aefa05a29744.png':
    '1787133144108-64cea352-9900-4ce5-8b05-c298190f33f5.jpg',
  'mcusercontent.com/dd402479fe7ccc7f2368df88d/images/687b83d2-1acb-bc04-3e8a-ced6c1d02748.png':
    '1787158141897-75872154-a880-4b14-b4c3-2ec4846a2629.jpg',
  'dim.mcusercontent.com/cs/dd402479fe7ccc7f2368df88d/images/a39d5db0-8804-dfe6-61f0-0da573a39a23.png':
    '1787200994235-4fae3afb-f916-4950-8f3b-7bb0a1a34745.jpg',
}

/**
 * Replace known-broken external `<img src>` URLs with correct Supabase
 * Storage public URLs. Returns the (possibly unchanged) HTML string.
 */
export function fixBrokenImageUrls(html: string): string {
  if (!html) return html
  let result = html
  let replacementCount = 0

  for (const [brokenFragment, storageFile] of Object.entries(BROKEN_URL_MAP)) {
    if (!result.includes(brokenFragment)) continue

    const replacementUrl = SUPABASE_STORAGE_BASE + encodeURIComponent(storageFile)

    // Match the full src attribute value that contains the broken fragment,
    // including any query-string suffixes (dpr, rect, w, h params).
    const pattern = new RegExp(
      `(src=")[^"]*${brokenFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"`,
      'g'
    )

    result = result.replace(pattern, (_match, prefix: string) => {
      replacementCount++
      console.log(
        `[fixBrokenImageUrls] Replaced broken image URL:\n` +
        `  original:  ${_match.slice(prefix.length, -1)}\n` +
        `  replaced:  ${replacementUrl}`
      )
      return `${prefix}${replacementUrl}"`
    })
  }

  if (replacementCount > 0) {
    console.log(`[fixBrokenImageUrls] Total replacements: ${replacementCount}`)
  }
  return result
}
