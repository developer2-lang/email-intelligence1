/**
 * Cloud follow-up automation service.
 *
 * Fully cloud-based replacement for the previous backend-only follow-up API
 * (backend/routes/followupRoutes.js + backend/services/followupService.js).
 * Every function talks directly to Supabase through the anon/publishable key
 * (same trust level as the rest of the app) or, for sending, to the
 * `send-followup` Edge Function — NO localhost:5000 dependency.
 *
 * Recipient rule (unchanged, enforced here AND inside the Edge Function):
 * follow-up recipients are ALWAYS the ORIGINAL campaign's openers
 * (email_logs opened=true) — never a segment, never the full contact list.
 */
import { supabase } from '../supabase'
import { buildScheduleRow, buildScheduleText } from './campaignService'
import type {
  CampaignScheduleInput,
  CreateFollowupConfigPayload,
  FollowupConfig,
  FollowupConfigApiResult,
  FollowupConfigPayload,
  FollowupConfigRow,
  OpenedContact,
  PendingFollowup,
  SendSelectedFollowupResult,
  SendSelectedFollowupsPayload,
  UpdateFollowupConfigPayload,
} from '../types/campaign'

const CONFIG_TABLE = 'campaign_followups'
const LOG_TABLE = 'campaign_followup_logs'
const SCHEDULE_TABLE = 'campaign_schedules'
const TRIGGER_TYPE = 'opened'

/** Sentinel on campaigns.mailchimp_campaign_id flagging an "All" follow-up. */
const ALL_FOLLOWUP_MARKER = '__ALL_FOLLOWUP__'

const DEFAULT_FROM_NAME = 'Rupali Sirsath — IUOVA Design Consultancy'

function normalizeEmail(email?: string | null): string {
  return String(email || '').trim().toLowerCase()
}

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
  return error instanceof Error ? error.message : 'Failed to send follow-up'
}

// ─── Per-campaign config (campaign_followups) ──────────────────────────────

async function getFollowupConfig(campaignId: string): Promise<FollowupConfig | null> {
  if (!campaignId) return null
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle()
  if (error) {
    if (error.code === '42P01') return null // table not created yet
    throw new Error(`Failed to fetch follow-up settings: ${error.message}`)
  }
  return (data as FollowupConfig | null) || null
}

async function saveFollowupConfig(
  campaignId: string,
  config: FollowupConfigPayload
): Promise<FollowupConfig | null> {
  if (!campaignId) throw new Error('campaign_id is required')

  const active = Boolean(config && config.is_active)
  const followupCampaignId = config && config.followup_campaign_id
    ? String(config.followup_campaign_id).trim()
    : null

  // Disabled / no follow-up campaign selected → clear the stored config.
  if (!active || !followupCampaignId) {
    const { error } = await supabase
      .from(CONFIG_TABLE)
      .delete()
      .eq('campaign_id', campaignId)
    if (error && error.code !== '42P01') {
      throw new Error(`Failed to clear follow-up settings: ${error.message}`)
    }
    return null
  }

  if (String(followupCampaignId) === String(campaignId)) {
    throw new Error('A campaign cannot be its own follow-up campaign')
  }

  const mode = config.followup_mode === 'automatic' ? 'automatic' : 'manual'

  // Replace any existing row for this campaign (mirrors the backend).
  const { error: deleteError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('campaign_id', campaignId)
  if (deleteError && deleteError.code !== '42P01') {
    throw new Error(`Failed to replace follow-up settings: ${deleteError.message}`)
  }

  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .insert({
      campaign_id: campaignId,
      followup_campaign_id: followupCampaignId,
      trigger_type: TRIGGER_TYPE,
      followup_mode: mode,
      is_active: true,
    })
    .select('*')
    .single()
  if (error) throw new Error(`Failed to save follow-up settings: ${error.message}`)
  return (data as FollowupConfig | null) || null
}

// ─── Config list (Follow-ups page Active table) ────────────────────────────

async function listAllFollowupCampaigns(): Promise<Record<string, any>[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name, created_at')
    .eq('mailchimp_campaign_id', ALL_FOLLOWUP_MARKER)
  if (error) {
    if (error.code === '42P01' || error.code === '42703') return []
    throw new Error(`Failed to fetch all-campaign follow-ups: ${error.message}`)
  }
  return (data as Record<string, any>[]) || []
}

async function listFollowupTypeCampaigns(): Promise<Record<string, any>[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name, created_at')
    .eq('campaign_type', 'Follow Up')
  if (error) {
    if (error.code === '42P01' || error.code === '42703') return []
    throw new Error(`Failed to fetch follow-up campaigns: ${error.message}`)
  }
  return (data as Record<string, any>[]) || []
}

async function listEligibleOriginalCampaigns(): Promise<Record<string, any>[]> {
  const { data: campaigns, error: campaignsError } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })
  if (campaignsError) throw new Error(`Failed to fetch campaigns: ${campaignsError.message}`)

  const { data: configs, error: configError } = await supabase
    .from(CONFIG_TABLE)
    .select('followup_campaign_id')
  if (configError && configError.code !== '42P01') {
    throw new Error(`Failed to fetch follow-up settings: ${configError.message}`)
  }

  const followupIds = new Set((configs || []).map((r) => String(r.followup_campaign_id)))
  const markedAll = await listAllFollowupCampaigns()
  for (const c of markedAll) followupIds.add(String(c.id))

  return (campaigns || []).filter((c) => c && c.id && !followupIds.has(String(c.id)))
}

async function computeAllOpenedUnion(): Promise<number> {
  try {
    const eligible = await listEligibleOriginalCampaigns()
    if (eligible.length === 0) return 0
    const ids = eligible.map((c) => String(c.id))
    const { data: logs, error } = await supabase
      .from('email_logs')
      .select('contact_id, email')
      .in('campaign_id', ids)
      .eq('opened', true)
    if (error) return 0
    const seen = new Set<string>()
    for (const log of logs || []) {
      const key = String(log.contact_id) || normalizeEmail(log.email)
      if (key) seen.add(key)
    }
    return seen.size
  } catch {
    return 0
  }
}

function engagementFields(
  followupId: string,
  followupMetrics: Map<string, { delivered: number; opened: number; clicked: number }>
) {
  const m = followupMetrics.get(String(followupId)) || { delivered: 0, opened: 0, clicked: 0 }
  return {
    followup_delivered: m.delivered,
    followup_opened: m.opened,
    followup_clicked: m.clicked,
    followup_open_rate: m.delivered > 0 ? Number(((m.opened / m.delivered) * 100).toFixed(1)) : 0,
    followup_click_rate: m.delivered > 0 ? Number(((m.clicked / m.delivered) * 100).toFixed(1)) : 0,
  }
}

async function fetchFollowupConfigs(): Promise<FollowupConfigRow[]> {
  const { data: configs, error } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
  if (error) {
    if (error.code === '42P01') return []
    throw new Error(`Failed to list follow-up settings: ${error.message}`)
  }

  const rows = (configs as Record<string, any>[]) || []
  const allFollowups = await listAllFollowupCampaigns()
  const followupCampaigns = await listFollowupTypeCampaigns()
  if (rows.length === 0 && allFollowups.length === 0 && followupCampaigns.length === 0) return []

  // Decorate with campaign names (best-effort).
  const nameById = new Map<string, string>()
  const createdById = new Map<string, string>()
  try {
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, campaign_name, created_at')
    for (const c of campaigns || []) {
      nameById.set(String(c.id), c.campaign_name || '')
      if (c.created_at) createdById.set(String(c.id), c.created_at)
    }
  } catch {
    // Campaign names are decorative — leave them as placeholders.
  }

  const markerFollowupIds = new Set(allFollowups.map((c) => String(c.id)))
  const allFollowupIds = new Set(markerFollowupIds)
  for (const r of rows) allFollowupIds.add(String(r.followup_campaign_id))
  for (const c of followupCampaigns) allFollowupIds.add(String(c.id))

  // Already-sent counts per (original, follow-up) pair, already-sent recipients
  // per FOLLOW-UP campaign (union across originals), and the most recent
  // ORIGINAL campaign per follow-up (used to anchor follow-ups that no longer
  // have a config row so they are still displayed).
  const sentByPair = new Map<string, number>()
  const sentByFollowup = new Map<string, Set<string>>()
  const originalByFollowup = new Map<string, string>()
  const latestLogTsByFollowup = new Map<string, number>()
  try {
    const { data: logs, error: logsError } = await supabase
      .from(LOG_TABLE)
      .select('campaign_id, followup_campaign_id, contact_id, status, created_at')
      .in('followup_campaign_id', [...allFollowupIds])
    if (!logsError) {
      for (const log of logs || []) {
        const fupId = String(log.followup_campaign_id)
        if (['sent', 'already_sent'].includes(log.status)) {
          const key = `${String(log.campaign_id)}|${fupId}`
          sentByPair.set(key, (sentByPair.get(key) || 0) + 1)
          if (!sentByFollowup.has(fupId)) sentByFollowup.set(fupId, new Set())
          sentByFollowup.get(fupId)!.add(String(log.contact_id))
        }
        if (log.campaign_id) {
          const ts = new Date(log.created_at || 0).getTime()
          if (ts >= (latestLogTsByFollowup.get(fupId) || 0)) {
            latestLogTsByFollowup.set(fupId, ts)
            originalByFollowup.set(fupId, String(log.campaign_id))
          }
        }
      }
    }
  } catch {
    // Best-effort decoration.
  }

  // Eligible recipients per ORIGINAL campaign: email_logs opened=true. These
  // are the follow-up's ELIGIBLE recipients — never its "opened" count.
  const originalIds = [
    ...new Set([
      ...rows.map((r) => String(r.campaign_id)),
      ...originalByFollowup.values(),
    ]),
  ]
  const openedByOriginal = new Map<string, number>()
  try {
    if (originalIds.length > 0) {
      const { data: openedLogs, error: openedError } = await supabase
        .from('email_logs')
        .select('campaign_id, contact_id, email')
        .in('campaign_id', originalIds)
        .eq('opened', true)
      if (!openedError) {
        const sets = new Map(originalIds.map((id) => [String(id), new Set<string>()]))
        for (const log of openedLogs || []) {
          const set = sets.get(String(log.campaign_id))
          if (set) set.add(String(log.contact_id) || normalizeEmail(log.email))
        }
        for (const [id, set] of sets) openedByOriginal.set(id, set.size)
      }
    }
  } catch {
    // Best-effort decoration.
  }

  // The FOLLOW-UP campaign's OWN engagement from ITS email_logs.
  const followupMetrics = new Map<string, { delivered: number; opened: number; clicked: number }>()
  try {
    const { data: emailLogs, error: logsError } = await supabase
      .from('email_logs')
      .select('campaign_id, status, opened, clicked')
      .in('campaign_id', [...allFollowupIds])
    if (!logsError) {
      for (const log of emailLogs || []) {
        const id = String(log.campaign_id)
        if (!followupMetrics.has(id)) followupMetrics.set(id, { delivered: 0, opened: 0, clicked: 0 })
        const m = followupMetrics.get(id)!
        if (log.status === 'sent') m.delivered += 1
        if (log.opened === true) m.opened += 1
        if (log.clicked === true) m.clicked += 1
      }
    }
  } catch {
    // Best-effort decoration.
  }

  const allOpenedUnion = await computeAllOpenedUnion()

  // Recurring schedule info per FOLLOW-UP campaign (campaign_schedules keyed by
  // the follow-up campaign id). Only rows that are actually scheduled
  // (schedule_type present) are surfaced for display + gating.
  const schedulesByCampaign = new Map<string, Record<string, any>>()
  try {
    if (allFollowupIds.size > 0) {
      const { data: schedules, error: schedulesError } = await supabase
        .from(SCHEDULE_TABLE)
        .select('*')
        .in('campaign_id', [...allFollowupIds])
      if (!schedulesError) {
        for (const s of schedules || []) {
          if (s && s.campaign_id && s.schedule_type) {
            schedulesByCampaign.set(String(s.campaign_id), s)
          }
        }
      }
    }
  } catch {
    // Best-effort decoration.
  }

  const grouped = new Map<string, Record<string, any>[]>()
  for (const row of rows) {
    const fupId = String(row.followup_campaign_id)
    if (!grouped.has(fupId)) grouped.set(fupId, [])
    grouped.get(fupId)!.push(row)
  }

  const ctx = { nameById, createdById, openedByOriginal, sentByPair, sentByFollowup, originalByFollowup, followupMetrics, allOpenedUnion, schedulesByCampaign }

  const result: FollowupConfigRow[] = []
  const handledIds = new Set<string>()
  for (const [fupId, group] of grouped) {
    handledIds.add(fupId)
    const distinctOriginals = new Set(group.map((r) => String(r.campaign_id)))
    const isAll = markerFollowupIds.has(fupId) || distinctOriginals.size > 1
    result.push(isAll ? buildAllFollowupRow(fupId, group[0], ctx) : buildIndividualFollowupRow(group[0], ctx))
  }

  // All follow-ups that could not be anchored to a real campaign still show via the marker.
  for (const camp of allFollowups) {
    if (handledIds.has(String(camp.id))) continue
    handledIds.add(String(camp.id))
    result.push(buildAllFollowupRow(String(camp.id), null, ctx))
  }

  // Every follow-up campaign in the database — including follow-ups that no
  // longer have a config row (replaced/disabled) — is shown as its own row so
  // older follow-ups are never hidden. Each is anchored to the most recent
  // ORIGINAL campaign recorded in the follow-up logs.
  for (const camp of followupCampaigns) {
    if (handledIds.has(String(camp.id))) continue
    handledIds.add(String(camp.id))
    result.push(buildOrphanFollowupRow(String(camp.id), ctx))
  }

  result.sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0
    return tb - ta
  })

  return result
}

function buildIndividualFollowupRow(row: Record<string, any>, ctx: Record<string, any>): FollowupConfigRow {
  const followupId = String(row.followup_campaign_id)
  const pairKey = `${String(row.campaign_id)}|${followupId}`
  const opened = ctx.openedByOriginal.get(String(row.campaign_id)) || 0
  const sent = ctx.sentByPair.get(pairKey) || 0
  return {
    ...row,
    ...scheduleDecorators(ctx, followupId),
    original_campaign_name: ctx.nameById.get(String(row.campaign_id)) || '—',
    followup_campaign_name: ctx.nameById.get(followupId) || '—',
    opened_count: opened,
    sent_count: sent,
    ...engagementFields(followupId, ctx.followupMetrics),
    remaining_eligible: Math.max(0, opened - sent),
    is_all: false,
  } as FollowupConfigRow
}

function scheduleDecorators(ctx: Record<string, any>, followupId: string): {
  is_scheduled: boolean
  schedule_text: string
} {
  const schedule = ctx.schedulesByCampaign?.get(String(followupId))
  if (!schedule) return { is_scheduled: false, schedule_text: '' }
  return {
    is_scheduled: true,
    schedule_text: buildScheduleText(schedule),
  }
}

function buildAllFollowupRow(
  followupId: string,
  sampleRow: Record<string, any> | null,
  ctx: Record<string, any>
): FollowupConfigRow {
  const opened = ctx.allOpenedUnion
  const sent = (ctx.sentByFollowup.get(String(followupId)) || new Set<string>()).size
  return {
    id: followupId,
    campaign_id: 'all',
    followup_campaign_id: followupId,
    ...scheduleDecorators(ctx, followupId),
    trigger_type: (sampleRow && sampleRow.trigger_type) || TRIGGER_TYPE,
    followup_mode: (sampleRow && sampleRow.followup_mode) || 'manual',
    is_active: true,
    created_at: ctx.createdById.get(String(followupId)) || (sampleRow && sampleRow.created_at) || null,
    original_campaign_name: 'All',
    followup_campaign_name: ctx.nameById.get(String(followupId)) || '—',
    opened_count: opened,
    sent_count: sent,
    ...engagementFields(String(followupId), ctx.followupMetrics),
    remaining_eligible: Math.max(0, opened - sent),
    is_all: true,
  } as FollowupConfigRow
}

/**
 * Build a row for a follow-up campaign that exists in the database but no
 * longer has a `campaign_followups` config row. The follow-up is still shown
 * (never hidden) with its real engagement values; the original campaign is
 * anchored to the most recent one recorded in the follow-up logs.
 */
function buildOrphanFollowupRow(followupId: string, ctx: Record<string, any>): FollowupConfigRow {
  const originalId = ctx.originalByFollowup.get(String(followupId)) || null
  const opened = originalId ? (ctx.openedByOriginal.get(originalId) || 0) : 0
  const sent = (ctx.sentByFollowup.get(String(followupId)) || new Set<string>()).size
  return {
    id: followupId,
    campaign_id: originalId || 'all',
    followup_campaign_id: followupId,
    ...scheduleDecorators(ctx, followupId),
    trigger_type: TRIGGER_TYPE,
    followup_mode: 'manual',
    is_active: false,
    created_at: ctx.createdById.get(String(followupId)) || null,
    original_campaign_name: originalId ? (ctx.nameById.get(originalId) || '—') : '—',
    followup_campaign_name: ctx.nameById.get(String(followupId)) || '—',
    opened_count: opened,
    sent_count: sent,
    ...engagementFields(String(followupId), ctx.followupMetrics),
    remaining_eligible: Math.max(0, opened - sent),
    is_all: false,
  } as FollowupConfigRow
}

// ─── Create / update / delete config ───────────────────────────────────────

/**
 * Persist a follow-up schedule to `campaign_schedules` (keyed by the follow-up
 * campaign id) and mark that follow-up campaign `status='scheduled'` so the
 * existing `scheduled-campaign-runner` delivers it to openers only at the
 * scheduled times. Reuses the campaign scheduling machinery — no new scheduler.
 *
 * When `schedule` is null/absent the follow-up keeps today's behaviour
 * (automatic = on open, manual = queue); any previous schedule row and the
 * `scheduled` status are cleared.
 */
async function persistFollowupSchedule(
  followupCampaignId: string,
  schedule?: CampaignScheduleInput | null
): Promise<void> {
  // Clear any previous schedule + revert status for unscheduled follow-ups.
  const { error: deleteError } = await supabase
    .from(SCHEDULE_TABLE)
    .delete()
    .eq('campaign_id', followupCampaignId)
  if (deleteError && deleteError.code !== '42P01') {
    throw new Error(`Failed to clear previous follow-up schedule: ${deleteError.message}`)
  }

  const scheduled =
    !!schedule && ['one_time', 'weekly', 'monthly'].includes(schedule.schedule_type)

  const { error: statusError } = await supabase
    .from('campaigns')
    .update({ status: scheduled ? 'scheduled' : 'draft', updated_at: new Date().toISOString() })
    .eq('id', followupCampaignId)
  if (statusError) throw new Error(`Failed to update follow-up campaign status: ${statusError.message}`)

  if (!scheduled) return

  const row = buildScheduleRow(schedule)
  const { error } = await supabase
    .from(SCHEDULE_TABLE)
    .insert({ campaign_id: followupCampaignId, ...row })
  if (error) throw new Error(`Failed to save follow-up schedule: ${error.message}`)
}

async function campaignExists(campaignId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .maybeSingle()
  if (error && error.code !== '42P01') throw new Error(`Failed to verify campaign: ${error.message}`)
  return Boolean(data)
}

async function isFollowupCampaign(campaignId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select('followup_campaign_id')
    .eq('followup_campaign_id', campaignId)
    .limit(1)
  if (error && error.code !== '42P01') throw new Error(`Failed to check follow-up status: ${error.message}`)
  return (data || []).length > 0
}

async function createFollowupCampaignRecord(payload: CreateFollowupConfigPayload): Promise<string> {
  const missing: string[] = []
  if (!payload.campaign_name || !String(payload.campaign_name).trim()) missing.push('campaign_name')
  if (!payload.subject_line || !String(payload.subject_line).trim()) missing.push('subject_line')
  if (!payload.html_content || !String(payload.html_content).trim()) missing.push('html_content')
  if (missing.length > 0) throw new Error(`Missing required fields: ${missing.join(', ')}`)

  const baseFields = {
    campaign_name: String(payload.campaign_name).trim(),
    subject_line: String(payload.subject_line).trim(),
    from_name: String(payload.from_name || '').trim() || DEFAULT_FROM_NAME,
    audience_segment: null,
    campaign_type: String(payload.campaign_type || 'Follow Up').trim(),
    email_body: String(payload.html_content),
    html_content: String(payload.html_content),
    template_name: payload.template_name ? String(payload.template_name).trim() : null,
    schedule_date: null,
    schedule_time: null,
    status: 'draft',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // The follow-up batch size is HARDCODED to 30 (not configurable). The first
  // batch delay is the user-configured value; subsequent batches always wait
  // 1 hour. These batch fields are written when the columns exist. If the
  // underlying public.campaigns table has not yet had the batching migration
  // applied (missing send_in_batches / batch_size / first_batch_delay_hours /
  // subsequent_batch_delay_hours columns), the insert falls back to the base
  // fields so creating the follow-up never fails.
  const batchFields: Record<string, unknown> = {
    send_in_batches: payload.send_in_batches === true,
    batch_size: 30,
    first_batch_delay_hours:
      payload.send_in_batches && Number.isFinite(payload.first_batch_delay_hours)
        ? payload.first_batch_delay_hours
        : 1,
    subsequent_batch_delay_hours: 1,
  }

  const { data, error } = await supabase
    .from('campaigns')
    .insert({ ...baseFields, ...batchFields })
    .select('*')
    .single()

  // Missing-column (schema cache) error → the batching migration has not been
  // applied to this database yet. Retry WITHOUT the batch columns so follow-up
  // creation still succeeds. The columns only matter at send time, where they
  // must be present.
  if (error) {
    const message = String(error.message || '').toLowerCase()
    const isMissingColumn =
      error.code === '42703' ||
      message.includes('could not find the') ||
      message.includes('schema cache') ||
      message.includes('column') && message.includes('of') && message.includes('in the schema')
    if (isMissingColumn) {
      const retry = await supabase
        .from('campaigns')
        .insert(baseFields)
        .select('*')
        .single()
      if (retry.error) {
        throw new Error(`Failed to create follow-up campaign: ${retry.error.message}`)
      }
      return String(retry.data.id)
    }
    throw new Error(`Failed to create follow-up campaign: ${error.message}`)
  }

  return String(data.id)
}

async function createFollowupConfig(
  payload: CreateFollowupConfigPayload
): Promise<FollowupConfigApiResult> {
  const originalCampaignId = payload.original_campaign_id
    ? String(payload.original_campaign_id).trim()
    : ''
  if (!originalCampaignId) throw new Error('original_campaign_id is required')

  // "All" — recipients are the union of openers across every eligible campaign.
  if (originalCampaignId === 'all') {
    return createAllCampaignsFollowup(payload)
  }

  const originalExists = await campaignExists(originalCampaignId)
  if (!originalExists) throw new Error('Original campaign not found')

  if (await isFollowupCampaign(originalCampaignId)) {
    throw new Error('A follow-up campaign cannot be used as an original campaign')
  }

  const mode = payload.followup_mode === 'automatic' ? 'automatic' : 'manual'
  const isActive = payload.is_active !== false

  let followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id).trim()
    : null
  let created = false

  if (followupCampaignId) {
    if (followupCampaignId === originalCampaignId) {
      throw new Error('A campaign cannot be its own follow-up campaign')
    }
    const followupExists = await campaignExists(followupCampaignId)
    if (!followupExists) throw new Error('Selected follow-up campaign not found')
    if (await isFollowupCampaign(followupCampaignId)) {
      throw new Error('That campaign is already configured as a follow-up')
    }
  } else {
    followupCampaignId = await createFollowupCampaignRecord(payload)
    created = true
  }

  const config = await saveFollowupConfig(originalCampaignId, {
    is_active: isActive,
    followup_mode: mode,
    followup_campaign_id: followupCampaignId,
  })

  await persistFollowupSchedule(followupCampaignId, payload.schedule)

  return {
    config,
    original_campaign_id: originalCampaignId,
    followup_campaign_id: followupCampaignId,
    created,
  }
}

async function createAllCampaignsFollowup(
  payload: CreateFollowupConfigPayload
): Promise<FollowupConfigApiResult & { linked_campaign_count: number; total_campaigns: number }> {
  const mode = payload.followup_mode === 'automatic' ? 'automatic' : 'manual'
  const isActive = payload.is_active !== false

  const eligible = await listEligibleOriginalCampaigns()
  if (eligible.length === 0) {
    throw new Error('No eligible campaigns found for an all-campaigns follow-up')
  }

  let followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id).trim()
    : null
  let created = false

  if (followupCampaignId) {
    if (eligible.some((c) => String(c.id) === followupCampaignId)) {
      throw new Error('A campaign cannot be its own follow-up campaign')
    }
    const followupExists = await campaignExists(followupCampaignId)
    if (!followupExists) throw new Error('Selected follow-up campaign not found')
    if (await isFollowupCampaign(followupCampaignId)) {
      throw new Error('That campaign is already configured as a follow-up')
    }
  } else {
    followupCampaignId = await createFollowupCampaignRecord(payload)
    created = true
  }

  // Flag the follow-up campaign as an "All" follow-up via the (unused, nullable)
  // mailchimp_campaign_id sentinel — mirrors the backend marker.
  const { error: markerError } = await supabase
    .from('campaigns')
    .update({ mailchimp_campaign_id: ALL_FOLLOWUP_MARKER })
    .eq('id', followupCampaignId)
  if (markerError) throw new Error(`Failed to mark all-campaigns follow-up: ${markerError.message}`)

  // Link eligible campaigns that do not already have a follow-up. Existing
  // per-campaign configurations are preserved untouched.
  let linkedCampaignCount = 0
  if (isActive) {
    for (const campaign of eligible) {
      if (String(campaign.id) === String(followupCampaignId)) continue
      const existing = await getFollowupConfig(String(campaign.id))
      if (existing) continue
      await saveFollowupConfig(String(campaign.id), {
        is_active: true,
        followup_mode: mode,
        followup_campaign_id: followupCampaignId,
      })
      linkedCampaignCount += 1
    }
  }

  await persistFollowupSchedule(followupCampaignId, payload.schedule)

  return {
    config: null,
    original_campaign_id: 'all',
    followup_campaign_id: followupCampaignId,
    created,
    linked_campaign_count: linkedCampaignCount,
    total_campaigns: eligible.length,
  }
}

async function getFollowupCampaignIfAll(campaignId: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name')
    .eq('id', campaignId)
    .eq('mailchimp_campaign_id', ALL_FOLLOWUP_MARKER)
    .maybeSingle()
  if (error) return null
  return (data as Record<string, any>) || null
}

async function removeAllFollowup(followupCampaignId: string): Promise<void> {
  const { error: configError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId)
  if (configError && configError.code !== '42P01') {
    throw new Error(`Failed to remove all-campaign follow-up configuration: ${configError.message}`)
  }
  const { error: markerError } = await supabase
    .from('campaigns')
    .update({ mailchimp_campaign_id: null })
    .eq('id', followupCampaignId)
  if (markerError) throw new Error(`Failed to remove all-campaign follow-up marker: ${markerError.message}`)
}

async function updateFollowupConfig(
  configId: string,
  payload: UpdateFollowupConfigPayload
): Promise<FollowupConfig | null> {
  if (!configId) throw new Error('config_id is required')

  const allFollowup = await getFollowupCampaignIfAll(configId)
  if (allFollowup) {
    return updateAllFollowup(configId, payload)
  }

  const { data: existing, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('id', configId)
    .maybeSingle()
  if (fetchError) throw new Error(`Failed to fetch follow-up configuration: ${fetchError.message}`)
  if (!existing) throw new Error('Follow-up configuration not found')

  if (payload.is_active === false) {
    const { error: deleteError } = await supabase
      .from(CONFIG_TABLE)
      .delete()
      .eq('id', configId)
    if (deleteError && deleteError.code !== '42P01') {
      throw new Error(`Failed to disable follow-up configuration: ${deleteError.message}`)
    }
    return null
  }

  const mode = payload.followup_mode === 'automatic' || payload.followup_mode === 'manual'
    ? payload.followup_mode
    : existing.followup_mode
  const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : existing.is_active

  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .update({ followup_mode: mode, is_active: isActive })
    .eq('id', configId)
    .select('*')
    .single()
  if (error) throw new Error(`Failed to update follow-up configuration: ${error.message}`)
  return (data as FollowupConfig | null) || null
}

async function updateAllFollowup(
  followupCampaignId: string,
  payload: UpdateFollowupConfigPayload
): Promise<FollowupConfig | null> {
  if (payload.is_active === false) {
    await removeAllFollowup(followupCampaignId)
    return null
  }

  const { data: rows, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('followup_campaign_id', followupCampaignId)
  if (fetchError && fetchError.code !== '42P01') {
    throw new Error(`Failed to fetch all-campaigns follow-up configuration: ${fetchError.message}`)
  }

  const updates: Record<string, unknown> = {}
  const mode = payload.followup_mode
  if (mode === 'automatic' || mode === 'manual') updates.followup_mode = mode
  if (payload.is_active !== undefined) updates.is_active = Boolean(payload.is_active)

  if (Object.keys(updates).length > 0 && (rows || []).length > 0) {
    const { error: updateError } = await supabase
      .from(CONFIG_TABLE)
      .update(updates)
      .eq('followup_campaign_id', followupCampaignId)
    if (updateError) {
      throw new Error(`Failed to update all-campaigns follow-up configuration: ${updateError.message}`)
    }
  }

  return (rows && rows[0]) || {
    id: followupCampaignId,
    campaign_id: 'all',
    followup_campaign_id: followupCampaignId,
    trigger_type: TRIGGER_TYPE,
    followup_mode: mode || 'manual',
    is_active: true,
  } as FollowupConfig
}

async function deleteFollowupConfig(configId: string): Promise<FollowupConfig | null> {
  if (!configId) throw new Error('config_id is required')

  // Resolve the follow-up campaign id. A campaign_followups row id is an
  // individual follow-up → use its followup_campaign_id. Anything else
  // (synthesized "All" / orphan rows) is already the follow-up campaign id.
  let followupCampaignId = ''
  let configRow: Record<string, any> | null = null
  const { data: configLookup, error: fetchError } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .eq('id', configId)
    .maybeSingle()
  if (fetchError && fetchError.code !== '42P01') {
    throw new Error(`Failed to fetch follow-up configuration: ${fetchError.message}`)
  }
  if (configLookup) {
    configRow = configLookup
    followupCampaignId = String(configLookup.followup_campaign_id || '')
  } else {
    const { data: campaignLookup, error: campaignFetchError } = await supabase
      .from('campaigns')
      .select('id')
      .eq('id', configId)
      .maybeSingle()
    if (campaignFetchError && campaignFetchError.code !== '42P01') {
      throw new Error(`Failed to fetch follow-up campaign: ${campaignFetchError.message}`)
    }
    if (campaignLookup) followupCampaignId = String(campaignLookup.id)
  }

  if (!followupCampaignId) throw new Error('Follow-up configuration not found')

  // campaign_followup_logs has no FK to campaigns — remove its rows explicitly
  // so the follow-up's pending/sent records are not orphaned.
  const { error: logError } = await supabase
    .from(LOG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId)
  if (logError && logError.code !== '42P01') {
    throw new Error(`Failed to delete follow-up records: ${logError.message}`)
  }

  // followup_history references the follow-up campaign — remove explicitly.
  const { error: historyError } = await supabase
    .from('followup_history')
    .delete()
    .eq('followup_campaign_id', followupCampaignId)
  if (historyError && historyError.code !== '42P01') {
    throw new Error(`Failed to delete follow-up history: ${historyError.message}`)
  }

  // Config rows referencing this follow-up campaign (either direction).
  const { error: configError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('followup_campaign_id', followupCampaignId)
  if (configError && configError.code !== '42P01') {
    throw new Error(`Failed to remove follow-up configuration: ${configError.message}`)
  }
  const { error: configAsOriginalError } = await supabase
    .from(CONFIG_TABLE)
    .delete()
    .eq('campaign_id', followupCampaignId)
  if (configAsOriginalError && configAsOriginalError.code !== '42P01') {
    throw new Error(`Failed to remove follow-up configuration: ${configAsOriginalError.message}`)
  }

  // The follow-up campaign's own related rows are deleted explicitly too
  // (their ON DELETE CASCADE FKs would also do it, but this works regardless
  // of the live FK set). Only records belonging to this follow-up campaign are
  // touched — never the original campaign, contacts, or unrelated email logs.
  const relatedDeletes = [
    ['campaign_analytics', 'campaign_id'],
    ['campaign_attachments', 'campaign_id'],
    ['campaign_contacts', 'campaign_id'],
    ['campaign_schedules', 'campaign_id'],
    ['email_logs', 'campaign_id'],
  ] as const
  for (const [table, column] of relatedDeletes) {
    const { error: relError } = await supabase
      .from(table)
      .delete()
      .eq(column, followupCampaignId)
    if (relError && relError.code !== '42P01') {
      throw new Error(`Failed to delete related ${table} records: ${relError.message}`)
    }
  }

  // Finally delete the follow-up campaign itself.
  const { data, error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', followupCampaignId)
    .select('*')
    .maybeSingle()
  if (error && error.code !== '42P01') {
    throw new Error(`Failed to delete follow-up campaign: ${error.message}`)
  }
  if (!data) throw new Error('Follow-up configuration not found')

  return {
    id: configRow ? String(configRow.id) : followupCampaignId,
    campaign_id: configRow ? String(configRow.campaign_id) : 'all',
    followup_campaign_id: followupCampaignId,
    trigger_type: (configRow && configRow.trigger_type) || TRIGGER_TYPE,
    followup_mode: (configRow && configRow.followup_mode) || 'manual',
    is_active: configRow ? Boolean(configRow.is_active) : false,
  } as FollowupConfig
}

// ─── Opened contacts ───────────────────────────────────────────────────────

async function resolveContactNames(): Promise<Map<string, Record<string, any>>> {
  const contactById = new Map<string, Record<string, any>>()
  try {
    const { data, error } = await supabase.from('contacts').select('*')
    if (!error) {
      for (const c of data || []) contactById.set(String(c.id), c)
    }
  } catch {
    // Contact names are decorative.
  }
  return contactById
}

async function fetchOpenedContacts(
  campaignId: string,
  followupCampaignId?: string | null
): Promise<OpenedContact[]> {
  if (!campaignId) throw new Error('campaign_id is required')

  // The synthesized "All" row anchors its send panel to the union of openers
  // across every eligible original campaign.
  if (String(campaignId) === 'all') {
    return fetchOpenedContactsForAll(followupCampaignId)
  }

  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .eq('campaign_id', campaignId)
    .eq('opened', true)
    .order('opened_at', { ascending: false })
  if (error) throw new Error(`Failed to fetch opened contacts: ${error.message}`)

  let rows = (logs as Record<string, any>[]) || []
  if (rows.length === 0) return []

  // Exclude contacts who have already received this follow-up. The manual
  // panel says "Only contacts who opened and have NOT received this
  // follow-up are shown", so already-sent contacts must not appear.
  if (followupCampaignId) {
    const fupId = String(followupCampaignId)
    const { data: sentLogs, error: sentError } = await supabase
      .from(LOG_TABLE)
      .select('contact_id')
      .eq('campaign_id', campaignId)
      .eq('followup_campaign_id', fupId)
      .in('status', ['sent', 'already_sent'])
    if (sentError) throw new Error(`Failed to check already-sent contacts: ${sentError.message}`)
    const sentIds = new Set((sentLogs || []).map((l: any) => String(l.contact_id)))
    if (sentIds.size > 0) {
      rows = rows.filter((row) => !sentIds.has(String(row.contact_id)))
      if (rows.length === 0) return []
    }
  }

  const contactById = await resolveContactNames()

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id)) || {}
    return {
      contact_id: row.contact_id,
      name: contact.full_name || contact.name || '',
      email: row.email || contact.email || '',
      company: contact.company || '',
      designation: contact.designation || '',
      opened_at: row.opened_at,
      campaign_id: row.campaign_id,
    }
  })
}

async function fetchOpenedContactsForAll(
  followupCampaignId?: string | null
): Promise<OpenedContact[]> {
  const eligible = await listEligibleOriginalCampaigns()
  if (eligible.length === 0) return []

  const ids = eligible.map((c) => String(c.id))
  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .in('campaign_id', ids)
    .eq('opened', true)
  if (error) throw new Error(`Failed to fetch opened contacts: ${error.message}`)

  const byKey = new Map<string, Record<string, any>>()
  for (const log of logs || []) {
    const key = String(log.contact_id || '') || normalizeEmail(log.email)
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing || new Date(log.opened_at || 0) > new Date(existing.opened_at || 0)) {
      byKey.set(key, log)
    }
  }

  // Exclude contacts who already received this follow-up from ANY eligible
  // original campaign (a (campaign_id, contact_id, follow-up) sent row).
  if (followupCampaignId) {
    const fupId = String(followupCampaignId)
    const { data: sentLogs, error: sentError } = await supabase
      .from(LOG_TABLE)
      .select('contact_id')
      .in('campaign_id', ids)
      .eq('followup_campaign_id', fupId)
      .in('status', ['sent', 'already_sent'])
    if (sentError) throw new Error(`Failed to check already-sent contacts: ${sentError.message}`)
    const sentIds = new Set((sentLogs || []).map((l: any) => String(l.contact_id)))
    if (sentIds.size > 0) {
      for (const key of [...byKey.keys()]) {
        if (sentIds.has(key)) byKey.delete(key)
      }
    }
  }

  const rows = [...byKey.values()].sort(
    (a, b) => new Date(b.opened_at || 0).getTime() - new Date(a.opened_at || 0).getTime()
  )

  const contactById = await resolveContactNames()

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id)) || {}
    return {
      contact_id: row.contact_id,
      name: contact.full_name || contact.name || '',
      email: row.email || contact.email || '',
      company: contact.company || '',
      designation: contact.designation || '',
      opened_at: row.opened_at,
      campaign_id: row.campaign_id,
    }
  })
}

// ─── Pending follow-ups (manual queue + history) ───────────────────────────

async function fetchPendingFollowups(): Promise<PendingFollowup[]> {
  // Cloud reconciliation: materialize manual-mode pending rows for contacts who
  // opened the original campaign since the last visit (best-effort — the list
  // still renders if the sync call fails).
  try {
    await supabase.functions.invoke('send-followup', { body: { action: 'sync_pending' } })
  } catch {
    // best-effort
  }

  const { data: logs, error } = await supabase
    .from(LOG_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(`Failed to fetch follow-up records: ${error.message}`)

  const rows = (logs as Record<string, any>[]) || []

  const nameById = new Map<string, string>()
  try {
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, campaign_name')
    for (const c of campaigns || []) nameById.set(String(c.id), c.campaign_name || '')
  } catch {
    // Decorative.
  }

  const contactById = await resolveContactNames()

  return rows.map((row) => {
    const contact = contactById.get(String(row.contact_id))
    return {
      ...row,
      campaign_name: nameById.get(String(row.campaign_id)) || '—',
      followup_campaign_name: nameById.get(String(row.followup_campaign_id)) || '—',
      recipient_name: contact ? (contact.full_name || contact.name || '') : '',
    } as PendingFollowup
  })
}

// ─── Sending (via the send-followup Edge Function) ─────────────────────────

async function sendSelectedFollowups(
  campaignId: string,
  payload: SendSelectedFollowupsPayload
): Promise<SendSelectedFollowupResult[]> {
  const { data, error } = await supabase.functions.invoke('send-followup', {
    body: {
      action: 'send_selected',
      campaign_id: campaignId,
      contact_ids: payload.contact_ids,
      followup_campaign_id: payload.followup_campaign_id,
    },
  })
  if (error) throw new Error(await extractFunctionError(error))
  const body = data as
    | { success?: boolean; data?: SendSelectedFollowupResult[]; error?: { message?: string } }
    | null
  if (!body || body.success === false) {
    throw new Error(body?.error?.message || 'Failed to send follow-ups')
  }
  return body.data || []
}

async function sendPendingFollowup(id: string): Promise<{ id: string; status: string }> {
  const { data, error } = await supabase.functions.invoke('send-followup', {
    body: { action: 'send_pending', pending_id: id },
  })
  if (error) throw new Error(await extractFunctionError(error))
  const body = data as
    | { success?: boolean; data?: { id: string; status: string }; error?: { message?: string } }
    | null
  if (!body || body.success === false) {
    throw new Error(body?.error?.message || 'Failed to send follow-up')
  }
  return body.data || { id, status: 'sent' }
}

export {
  fetchFollowupConfigs,
  createFollowupConfig,
  updateFollowupConfig,
  deleteFollowupConfig,
  fetchOpenedContacts,
  fetchOpenedContactsForAll,
  sendSelectedFollowups,
  fetchPendingFollowups,
  sendPendingFollowup,
}
