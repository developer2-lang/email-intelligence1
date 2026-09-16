/**
 * Campaign API client — fully cloud-native (direct Supabase calls).
 *
 * The old backend (Express at email-9qpb.vercel.app) is dead.
 * Every function now talks directly to Supabase via the anon key
 * (same trust level as the rest of the app) or, for sending,
 * to Edge Functions — NO Vercel backend dependency.
 */
import { supabase } from '../supabase'
import type {
  FollowupConfig,
  FollowupConfigApiResult,
  FollowupConfigRow,
  FollowupMode,
  OpenedContact,
  PendingFollowup,
} from '../types/campaign'

// ─── Campaign list ──────────────────────────────────────────────────

/** GET /api/campaigns — full campaign list including live engagement metrics
 * (delivered_count, opened_count, clicked_count, open_rate, click_rate)
 * fetched directly from Supabase campaigns table.
 */
export async function fetchCampaignsFromApi(): Promise<CampaignLaunchApiRow[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .neq('campaign_type', 'sequence')
    .order('created_at', { ascending: false })
  if (error) throw new Error(`Failed to fetch campaigns: ${error.message}`)
  const rows = (data as Record<string, any>[]) || []
  return rows.map((r) => ({
    id: r.id,
    campaign_name: r.campaign_name,
    subject_line: r.subject_line,
    from_name: r.from_name,
    audience_segment: r.audience_segment,
    campaign_type: r.campaign_type,
    schedule_date: r.schedule_date,
    schedule_time: r.schedule_time,
    email_body: r.email_body,
    html_content: r.html_content,
    template_name: r.template_name,
    status: r.status,
    mailchimp_campaign_id: r.mailchimp_campaign_id,
    recipient_count: r.recipient_count,
    sent_at: r.sent_at,
    scheduled_at: r.scheduled_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    delivered_count: r.delivered_count || 0,
    opened_count: r.opened_count || 0,
    clicked_count: r.clicked_count || 0,
    open_rate: r.open_rate || 0,
    click_rate: r.click_rate || 0,
    schedule_text: r.schedule_text || null,
  }))
}

// ─── Follow-up automation ──────────────────────────────────────────

export interface FollowupConfigPayload {
  is_active: boolean
  followup_mode: FollowupMode
  followup_campaign_id: string | null
}

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
  followup_mode: FollowupMode
  is_active: boolean
}

export interface UpdateFollowupConfigPayload {
  followup_mode?: FollowupMode
  is_active?: boolean
}

/** GET /api/followups — list configured follow-up relationships with decorators. */
export async function fetchFollowupConfigs(): Promise<FollowupConfigRow[]> {
  const CONFIG_TABLE = 'campaign_followups'
  const ALL_FOLLOWUP_MARKER = '__ALL_FOLLOWUP__'

  const { data: configs, error } = await supabase
    .from(CONFIG_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
  if (error) {
    if (error.code === '42P01') return []
    throw new Error(`Failed to list follow-up settings: ${error.message}`)
  }

  const rows = (configs as Record<string, any>[]) || []

  const { data: allFollowups } = await supabase
    .from('campaigns')
    .select('id, campaign_name')
    .eq('mailchimp_campaign_id', ALL_FOLLOWUP_MARKER)
  const allFollowupsList = (allFollowups || []).map((c: Record<string, any>) => ({ id: c.id, campaign_name: c.campaign_name }))

  const { data: followupCampaigns } = await supabase
    .from('campaigns')
    .select('id, campaign_name')
    .eq('campaign_type', 'Follow Up')
  const followupCampaignsList = (followupCampaigns || []).map((c: Record<string, any>) => ({ id: c.id, campaign_name: c.campaign_name }))

  if (rows.length === 0 && allFollowupsList.length === 0 && followupCampaignsList.length === 0) return []

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, campaign_name, created_at, send_in_batches, batch_size, first_batch_delay_hours, subsequent_batch_delay_hours, next_batch_at')
  const campaignsMap = new Map<string, Record<string, any>>()
  const batchMap = new Map<string, Record<string, any>>()
  if (campaigns) {
    for (const c of campaigns) {
      campaignsMap.set(String(c.id), c)
      if (c.send_in_batches) {
        batchMap.set(String(c.id), { send_in_batches: true, batch_size: c.batch_size, first_batch_delay_hours: c.first_batch_delay_hours, subsequent_batch_delay_hours: c.subsequent_batch_delay_hours, next_batch_at: c.next_batch_at })
      }
    }
  }

  const allFollowupIds = new Set([...allFollowupsList.map((c: any) => c.id), ...followupCampaignsList.map((c: any) => c.id)])
  for (const r of rows) allFollowupIds.add(String(r.followup_campaign_id))

  const { data: logs } = await supabase
    .from('campaign_followup_logs')
    .select('campaign_id, followup_campaign_id, contact_id, status, created_at')
    .in('followup_campaign_id', [...allFollowupIds])

  const sentByPair = new Map<string, number>()
  const sentByFollowup = new Map<string, Set<string>>()
  const originalByFollowup = new Map<string, string>()
  if (logs) {
    for (const log of logs) {
      const fupId = String(log.followup_campaign_id)
      if (['sent', 'already_sent'].includes(log.status)) {
        const key = `${String(log.campaign_id)}|${fupId}`
        sentByPair.set(key, (sentByPair.get(key) || 0) + 1)
        if (!sentByFollowup.has(fupId)) sentByFollowup.set(fupId, new Set())
        sentByFollowup.get(fupId)!.add(String(log.contact_id))
      }
      if (log.campaign_id) {
        const ts = new Date(log.created_at || 0).getTime()
        if (ts >= Number(originalByFollowup.get(fupId) || 0)) {
          originalByFollowup.set(fupId, String(log.campaign_id))
        }
      }
    }
  }

  const originalIds = [...new Set([...rows.map((r) => String(r.campaign_id)), ...originalByFollowup.values()])]
  const openedByOriginal = new Map<string, number>()
  const notOpenedByOriginal = new Map<string, number>()
  if (originalIds.length > 0) {
    const { data: openedLogs } = await supabase
      .from('email_logs')
      .select('campaign_id, contact_id, email, opened')
      .in('campaign_id', originalIds)
    if (openedLogs) {
      const openedSets = new Map(originalIds.map((id) => [String(id), new Set<string>()]))
      const notOpenedSets = new Map(originalIds.map((id) => [String(id), new Set<string>()]))
      for (const log of openedLogs) {
        const key = String(log.contact_id) || log.email
        const set = log.opened === true ? openedSets : notOpenedSets
        set.get(String(log.campaign_id))?.add(key)
      }
      for (const [id, set] of openedSets) openedByOriginal.set(id, set.size)
      for (const [id, set] of notOpenedSets) notOpenedByOriginal.set(id, set.size)
    }
  }

  const followupMetrics = new Map<string, { delivered: number; opened: number; clicked: number }>()
  const { data: emailLogs } = await supabase
    .from('email_logs')
    .select('campaign_id, status, opened, clicked')
    .in('campaign_id', [...allFollowupIds])
  if (emailLogs) {
    for (const log of emailLogs) {
      const id = String(log.campaign_id)
      if (!followupMetrics.has(id)) followupMetrics.set(id, { delivered: 0, opened: 0, clicked: 0 })
      const m = followupMetrics.get(id)!
      if (log.status === 'sent') m.delivered += 1
      if (log.opened === true) m.opened += 1
      if (log.clicked === true) m.clicked += 1
    }
  }

  const { data: schedules } = await supabase
    .from('campaign_schedules')
    .select('*')
    .in('campaign_id', [...allFollowupIds])
  const schedulesByCampaign = new Map<string, Record<string, any>>()
  if (schedules) {
    for (const s of schedules) {
      if (s?.campaign_id && s?.schedule_type) schedulesByCampaign.set(String(s.campaign_id), s)
    }
  }

  const openedByCampaign = new Map<String, number>()
  const notOpenedByCampaign = new Map<String, number>()
  const { data: allCampaignLogs } = await supabase
    .from('email_logs')
    .select('campaign_id, contact_id, email, opened')
  if (allCampaignLogs) {
    const openedSets = new Map<string, Set<string>>()
    const notOpenedSets = new Map<string, Set<string>>()
    const allIds = [...new Set([...rows.map((r) => String(r.campaign_id)), ...allFollowupsList.map((c: any) => c.id)])]
    for (const id of allIds) { openedSets.set(id, new Set()); notOpenedSets.set(id, new Set()) }
    for (const log of allCampaignLogs) {
      const set = log.opened === true ? openedSets : notOpenedSets
      const lid = String(log.campaign_id)
      if (set.has(lid)) set.get(lid)?.add(String(log.contact_id) || log.email)
    }
    for (const [id, set] of openedSets) openedByCampaign.set(id, set.size)
    for (const [id, set] of notOpenedSets) notOpenedByCampaign.set(id, set.size)
  }

  const result: FollowupConfigRow[] = []
  const grouped = new Map<string, Record<string, any>[]>()
  for (const row of rows) {
    const fupId = String(row.followup_campaign_id)
    if (!grouped.has(fupId)) grouped.set(fupId, [])
    grouped.get(fupId)!.push(row)
  }

  for (const [fupId, group] of grouped) {
    const pairKey = `${String(group[0].campaign_id)}|${fupId}`
    const opened = openedByOriginal.get(String(group[0].campaign_id)) || 0
    const notOpened = notOpenedByOriginal.get(String(group[0].campaign_id)) || 0
    const audience = group[0].trigger_type === 'not_opened' ? 'not_opened' : 'opened'
    const sent = sentByPair.get(pairKey) || 0
    const nameById = new Map(campaigns?.map((c: any) => [String(c.id), c.campaign_name]) || [])
    const schedule = schedulesByCampaign.get(fupId)
    const batch = batchMap.get(fupId)
    result.push({
      ...group[0],
      original_campaign_name: nameById.get(String(group[0].campaign_id)) || '—',
      followup_campaign_name: nameById.get(fupId) || '—',
      opened_count: opened,
      not_opened_count: notOpened,
      audience,
      sent_count: sent,
      followup_delivered: followupMetrics.get(fupId)?.delivered || 0,
      followup_opened: followupMetrics.get(fupId)?.opened || 0,
      followup_clicked: followupMetrics.get(fupId)?.clicked || 0,
      followup_open_rate: (followupMetrics.get(fupId)?.delivered || 0) > 0 ? Number(((followupMetrics.get(fupId)?.opened || 0) / (followupMetrics.get(fupId)?.delivered || 0) * 100).toFixed(1)) : 0,
      followup_click_rate: (followupMetrics.get(fupId)?.delivered || 0) > 0 ? Number(((followupMetrics.get(fupId)?.clicked || 0) / (followupMetrics.get(fupId)?.delivered || 0) * 100).toFixed(1)) : 0,
      remaining_eligible: Math.max(0, (audience === 'not_opened' ? notOpened : opened) - sent),
      is_all: false,
      is_scheduled: !!schedule,
      schedule_text: schedule ? '' : '',
      batch_enabled: !!batch,
      batch_size: batch?.batch_size ?? null,
      first_batch_delay_hours: batch?.first_batch_delay_hours ?? null,
      subsequent_batch_delay_hours: batch?.subsequent_batch_delay_hours ?? null,
      next_batch_at: batch?.next_batch_at ?? null,
    } as FollowupConfigRow)
  }

  result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return result
}

/** POST /api/followups — create a follow-up (original + follow-up campaign).
 *
 * TODO: This previously required the backend to sync Mailchimp.
 * Replace with: supabase.functions.invoke('create-followup', { body: payload })
 * if Mailchimp sync is still needed.
 */
export async function createFollowupConfig(
  payload: CreateFollowupConfigPayload
): Promise<FollowupConfigApiResult> {
  // TODO: Replace with Edge Function invoke('create-followup', { body: payload })
  // when Mailchimp sync is required. For now, create the config row directly.
  const { data, error } = await supabase
    .from('campaign_followups')
    .insert({
      campaign_id: payload.original_campaign_id,
      followup_campaign_id: payload.followup_campaign_id || null,
      trigger_type: 'opened',
      followup_mode: payload.followup_mode,
      is_active: payload.is_active,
    })
    .select('*')
    .single()
  if (error) throw new Error(`Failed to create follow-up config: ${error.message}`)
  return {
    config: data as FollowupConfig,
    original_campaign_id: payload.original_campaign_id,
    followup_campaign_id: payload.followup_campaign_id || null,
    created: true,
  }
}

/** PATCH /api/followups/:id — update follow-up mode / active state. */
export async function updateFollowupConfig(
  configId: string,
  payload: UpdateFollowupConfigPayload
): Promise<FollowupConfig | null> {
  const updates: Record<string, unknown> = {}
  if (payload.followup_mode !== undefined) updates.followup_mode = payload.followup_mode
  if (payload.is_active !== undefined) updates.is_active = payload.is_active
  const { data, error } = await supabase
    .from('campaign_followups')
    .update(updates)
    .eq('id', configId)
    .select('*')
    .single()
  if (error) throw new Error(`Failed to update follow-up config: ${error.message}`)
  return (data as FollowupConfig) || null
}

/** DELETE /api/followups/:id — delete a follow-up configuration. */
export async function deleteFollowupConfig(configId: string): Promise<FollowupConfig | null> {
  const { data, error } = await supabase
    .from('campaign_followups')
    .delete()
    .eq('id', configId)
    .select('*')
    .single()
  if (error) throw new Error(`Failed to delete follow-up config: ${error.message}`)
  return (data as FollowupConfig) || null
}

/** GET /api/campaigns/:id/followup — fetch a campaign's follow-up settings. */
export async function fetchFollowupConfig(campaignId: string): Promise<FollowupConfig | null> {
  const { data, error } = await supabase
    .from('campaign_followups')
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle()
  if (error) return null
  return (data as FollowupConfig) || null
}

/** POST /api/campaigns/:id/followup — create / update follow-up settings. */
export async function saveFollowupConfig(
  campaignId: string,
  payload: FollowupConfigPayload
): Promise<FollowupConfig | null> {
  const active = Boolean(payload.is_active)
  const followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id).trim()
    : null

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

  const mode = payload.followup_mode === 'automatic' ? 'automatic' : 'manual'

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
  return (data as FollowupConfig) || null
}

/** GET /api/followups/pending — list follow-up records (manual queue + history). */
export async function fetchPendingFollowups(): Promise<PendingFollowup[]> {
  const LOG_TABLE = 'campaign_followup_logs'
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
  const { data: campaigns } = await supabase.from('campaigns').select('id, campaign_name')
  if (campaigns) {
    for (const c of campaigns) nameById.set(String(c.id), c.campaign_name || '')
  }

  const contactById = await resolveContactNames()
  return rows.map((row: Record<string, any>) => ({
    ...row,
    campaign_name: nameById.get(String(row.campaign_id)) || '—',
    followup_campaign_name: nameById.get(String(row.followup_campaign_id)) || '—',
    recipient_name: contactById.get(String(row.contact_id))?.full_name || '',
  })) as PendingFollowup[]
}

/** POST /api/followups/send/:id — send one pending follow-up now. */
export async function sendPendingFollowup(id: string): Promise<{ id: string; status: string }> {
  const { data, error } = await supabase.functions.invoke('send-followup', {
    body: { action: 'send_pending', pending_id: id },
  })
  if (error) throw new Error(`Failed to send pending follow-up: ${error.message}`)
  return (data as { id: string; status: string }) || { id, status: 'sent' }
}

/** GET /api/campaigns/:id/opened-contacts — contacts who opened the campaign. */
export async function fetchOpenedContacts(campaignId: string): Promise<OpenedContact[]> {
  if (!campaignId) throw new Error('campaign_id is required')

  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .eq('campaign_id', campaignId)
    .order('opened_at', { ascending: false })
  if (error) throw new Error(`Failed to fetch opened contacts: ${error.message}`)

  const contactById = await resolveContactNames()
  return logs.map((row: Record<string, any>) => {
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

/** GET /api/followups/opened/all — union of opened contacts across all eligible campaigns (deduped). */
export async function fetchOpenedContactsForAll(): Promise<OpenedContact[]> {
  const { data: campaigns } = await supabase.from('campaigns').select('id')
  const ids = ((campaigns as Record<string, any>[]) || []).map((c) => String(c.id))
  if (ids.length === 0) return []

  const { data: logs, error } = await supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .in('campaign_id', ids)
    .eq('opened', true)
  if (error) throw new Error(`Failed to fetch opened contacts for all: ${error.message}`)

  const contactById = await resolveContactNames()
  const seen = new Set<string>()
  return (logs || []).map((row: Record<string, any>) => {
    const key = String(row.contact_id)
    if (seen.has(key)) return null
    seen.add(key)
    const contact = contactById.get(key) || {}
    return {
      contact_id: row.contact_id,
      name: contact.full_name || contact.name || '',
      email: row.email || contact.email || '',
      company: contact.company || '',
      designation: contact.designation || '',
      opened_at: row.opened_at,
      campaign_id: row.campaign_id,
    }
  }).filter(Boolean) as OpenedContact[]
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

/** POST /api/campaigns/:id/followup/send-selected — send follow-up to the selected opened contacts. */
export async function sendSelectedFollowups(
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
  if (error) throw new Error(`Failed to send selected follow-ups: ${error.message}`)
  const body = data as { success?: boolean; data?: SendSelectedFollowupResult[]; error?: { message?: string } } | null
  if (!body || body.success === false) {
    throw new Error(body?.error?.message || 'Failed to send selected follow-ups')
  }
  return body.data || []
}

// ─── Helpers ────────────────────────────────────────────────────────

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

export interface CampaignLaunchApiRow {
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
  delivered_count: number
  opened_count: number
  clicked_count: number
  open_rate: number
  click_rate: number
  /** Optional pre-rendered schedule text (not currently returned by the backend). */
  schedule_text?: string | null
}
