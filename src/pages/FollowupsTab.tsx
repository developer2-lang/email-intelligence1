import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CircularProgress from '@mui/material/CircularProgress'
import {
  AV_COLORS,
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_COLORS,
  CAMPAIGN_TYPE_FALLBACK_COLOR,
} from '../constants/constants'
import {
  fetchCampaigns,
  fetchTemplates,
  fetchCampaignAttachments,
  removeCampaignAttachment,
  fixBrokenImageUrls,
  formatFileSize,
  buildScheduleInput,
} from '../services/campaignService'
import {
  uploadFollowupAttachment,
  relocatePendingFollowupAttachments,
} from '../services/followupAttachmentService'
import {
  fetchFollowupConfigs,
  createFollowupConfig,
  updateFollowupConfig,
  deleteFollowupConfig,
  fetchOpenedContacts,
  fetchOpenedContactsForAll,
  sendSelectedFollowups,
  fetchPendingFollowups,
  sendPendingFollowup,
} from '../services/followupService'
import { supabase } from '../supabase'
import type {
  CampaignAttachment,
  CampaignScheduleInput,
  EmailTemplate,
  FollowupConfigRow,
  FollowupMode,
  OpenedContact,
  PendingFollowup,
  ScheduleType,
} from '../types/campaign'

interface FollowupsTabProps {
  campaigns: any[]
  onPersistCampaigns: (campaigns: any[]) => void
  onToast: (msg: string, type?: string) => void
  onNavigate: (tab: 'campaigns') => void
}

const DEFAULT_FROM_NAME = 'Rupali Sirsath — IUOVA Design Consultancy'

const MERGE_TAGS = ['{{first_name}}', '{{company}}', '{{designation}}', '{{city}}', '{{month}}']

const FOLLOWUP_PAGE_SIZE = 10

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHLY_POSITIONS = ['First', 'Second', 'Third', 'Fourth', 'Last']
const MONTHLY_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const MONTHLY_RULES = MONTHLY_POSITIONS.flatMap((p) => MONTHLY_WEEKDAYS.map((d) => `${p} ${d}`))

function formatDateTime(input?: string | null): string {
  if (!input) return '—'
  const date = new Date(input)
  if (isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function stripHtmlTags(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * True when the stored template body is a full HTML email document (as saved by
 * the Template Editor or an uploaded .html file). Such bodies are used verbatim
 * so the rendered email matches the saved design exactly; only legacy
 * plain-text bodies fall back to the strip-to-text behaviour.
 */
function isFullHtmlDocument(content: string): boolean {
  return /<(?:!doctype|html|head|body)\b/i.test(String(content || '').trim())
}

// Style for the Email Body view-mode toggle pills (Plain Text · HTML ·
// Preview). `active` renders the pill as selected.
function bodyTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    border: active ? '1px solid #2563EB' : '1px solid #E2E8F0',
    background: active ? '#EFF6FF' : '#FFFFFF',
    color: active ? '#1D4ED8' : '#64748B',
    transition: 'all 0.15s ease',
  }
}

function RateCell({
  rate,
  count,
  delivered,
  label,
}: {
  rate: number
  count: number
  delivered: number
  label: 'opened' | 'clicked'
}) {
  const value = Math.min(100, Math.max(0, Number(rate) || 0))
  return (
    <div className="fu-rate">
      <div className="fu-rate-top">
        <div className="fu-rate-track">
          <div className="fu-rate-fill" style={{ width: `${value}%` }} />
        </div>
        <div className="fu-rate-pct">{value.toFixed(1)}%</div>
      </div>
      <div className="fu-rate-sub">
        {count}/{delivered} {label}
      </div>
    </div>
  )
}

function CampaignTypeChip({ type }: { type?: string }) {
  const label = type || 'Follow Up'
  const colors = CAMPAIGN_TYPE_COLORS[label] || CAMPAIGN_TYPE_FALLBACK_COLOR
  return (
    <span
      className="fu-type"
      style={{ background: colors.bg, color: colors.color }}
    >
      {label}
    </span>
  )
}

function avatarColor(name: string): string {
  const s = String(name || '')
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return AV_COLORS[h % AV_COLORS.length]
}

function getInitials(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '—'
}

function FollowupAvatar({ name }: { name: string }) {
  const color = avatarColor(name)
  return (
    <span
      className="fu-avatar"
      style={{ background: `${color}1A`, color }}
    >
      {getInitials(name)}
    </span>
  )
}

export default function FollowupsTab({
  campaigns,
  onPersistCampaigns,
  onToast,
  onNavigate,
}: FollowupsTabProps) {
  const [tab, setTab] = useState<'active' | 'compose' | 'pending'>('active')

  const [configs, setConfigs] = useState<FollowupConfigRow[]>([])
  const [configsLoading, setConfigsLoading] = useState(true)
  const [configsError, setConfigsError] = useState<string | null>(null)
  const [activePage, setActivePage] = useState(1)

  const [pending, setPending] = useState<PendingFollowup[]>([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [sendingPendingId, setSendingPendingId] = useState<string | null>(null)

  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null)
  // id of the template currently fetching its HTML from Supabase Storage.
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null)
  // Error shown when a storage-backed template fails to load — the editor is
  // never silently populated with a different/empty template.
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null)

  const [originalId, setOriginalId] = useState('')
  const [followupMode, setFollowupMode] = useState<FollowupMode>('manual')
  const [reuseExisting, setReuseExisting] = useState(false)
  const [existingFollowupId, setExistingFollowupId] = useState('')
  const [campaignName, setCampaignName] = useState('')
  const [subjectLine, setSubjectLine] = useState('')
  const [fromName, setFromName] = useState('')
  const [campaignType, setCampaignType] = useState('Follow Up')
  const [htmlContent, setHtmlContent] = useState('')
  // How the Email Body is shown in the composer:
  //  - 'preview' = the template's HTML rendered visually in a sandboxed iframe;
  //  - 'text'    = the plain-text version of the body;
  //  - 'html'    = the raw HTML source (editable).
  const [bodyMode, setBodyMode] = useState<'preview' | 'text' | 'html'>('preview')
  const [isActive, setIsActive] = useState(true)
  const [creating, setCreating] = useState(false)

  // ─── FOLLOW-UP SCHEDULE STATE (composer) ───
  const [enableSchedule, setEnableSchedule] = useState(false)
  const [scheduleType, setScheduleType] = useState<ScheduleType>('one_time')
  const [compDate, setCompDate] = useState('')
  const [compTime, setCompTime] = useState('10:00 AM')
  const [repeatEvery, setRepeatEvery] = useState(1)
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [monthlyOption, setMonthlyOption] = useState<'day' | 'weekday'>('day')
  const [dayOfMonth, setDayOfMonth] = useState(15)
  const [weekdayRule, setWeekdayRule] = useState('First Monday')

  // ─── ATTACHMENTS STATE (composer) ───
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)

  // ─── BATCH SENDING STATE (composer — mirrors Campaigns) ───
  // Follow-up batch size is user-configurable: a positive integer, capped at
  // the number of eligible remaining recipients. It is persisted to the
  // follow-up campaign's campaigns row and honored at send time by the UI
  // slicing AND the send-followup Edge Function (server-side cap).
  const FOLLOWUP_DEFAULT_BATCH_SIZE = 30
  const [batchSize, setBatchSize] = useState<number>(FOLLOWUP_DEFAULT_BATCH_SIZE)
  const [sendInBatches, setSendInBatches] = useState(false)
  const [batchDelayHours, setBatchDelayHours] = useState(1)

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
]

  const [activeConfig, setActiveConfig] = useState<FollowupConfigRow | null>(null)
  const [openedContacts, setOpenedContacts] = useState<OpenedContact[]>([])
  const [openedLoading, setOpenedLoading] = useState(false)
  const [openedError, setOpenedError] = useState<string | null>(null)
  const [selectedOpenedIds, setSelectedOpenedIds] = useState<string[]>([])
  const [sendingSelected, setSendingSelected] = useState(false)

  const [allOpened, setAllOpened] = useState<OpenedContact[]>([])
  const [allOpenedLoading, setAllOpenedLoading] = useState(false)
  const [allOpenedError, setAllOpenedError] = useState<string | null>(null)

  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const campaignsById = useMemo(() => {
    const map = new Map<string, any>()
    for (const c of campaigns || []) {
      if (c && c.id) map.set(String(c.id), c)
    }
    return map
  }, [campaigns])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(configs.length / FOLLOWUP_PAGE_SIZE)),
    [configs.length],
  )

  const effectivePage = Math.min(activePage, totalPages)

  const visibleConfigs = useMemo(() => {
    const start = (effectivePage - 1) * FOLLOWUP_PAGE_SIZE
    return configs.slice(start, start + FOLLOWUP_PAGE_SIZE)
  }, [configs, effectivePage])

  const alreadyFollowupCampaignIds = useMemo(
    () => new Set(configs.map((c) => String(c.followup_campaign_id || ''))),
    [configs],
  )

  const originalOptions = useMemo(
    () =>
      (campaigns || []).filter((c) => {
        const id = String(c.id || '')
        if (!id) return false
        if (alreadyFollowupCampaignIds.has(id)) return false
        return true
      }),
    [campaigns, alreadyFollowupCampaignIds],
  )

  const reuseOptions = useMemo(
    () =>
      (campaigns || []).filter((c) => {
        const id = String(c.id || '')
        if (!id || id === originalId) return false
        if (alreadyFollowupCampaignIds.has(id)) return false
        return true
      }),
    [campaigns, originalId, alreadyFollowupCampaignIds],
  )

  const selectedOriginal = useMemo(
    () => (campaigns || []).find((c) => String(c.id || '') === originalId) || null,
    [campaigns, originalId],
  )

  const loadCampaigns = useCallback(async () => {
    const { data, error } = await fetchCampaigns()
    if (error) {
      console.error('Follow-ups: failed to refresh campaigns:', error)
      return
    }
    onPersistCampaigns(data)
  }, [onPersistCampaigns])

  const loadConfigs = useCallback(async () => {
    setConfigsLoading(true)
    setConfigsError(null)
    try {
      const data = await fetchFollowupConfigs()
      setConfigs(data || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load follow-up configurations'
      setConfigsError(msg)
      setConfigs([])
    } finally {
      setConfigsLoading(false)
    }
  }, [])

  const loadPending = useCallback(async () => {
    setPendingLoading(true)
    setPendingError(null)
    try {
      const data = await fetchPendingFollowups()
      setPending(data || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load pending follow-ups'
      setPendingError(msg)
      setPending([])
    } finally {
      setPendingLoading(false)
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    setTemplatesError(null)
    const { data, error } = await fetchTemplates()
    if (error) {
      setTemplatesError(error)
      setTemplates([])
    } else {
      setTemplates(data || [])
    }
    setTemplatesLoading(false)
  }, [])

  const loadOpenedContacts = useCallback(async (campaignId: string, followupCampaignId?: string | null) => {
    setOpenedLoading(true)
    setOpenedError(null)
    try {
      const data = await fetchOpenedContacts(campaignId, followupCampaignId)
      setOpenedContacts(data || [])
      setSelectedOpenedIds([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load opened contacts'
      setOpenedError(msg)
      setOpenedContacts([])
    } finally {
      setOpenedLoading(false)
    }
  }, [])

  const loadAllOpened = useCallback(async () => {
    setAllOpenedLoading(true)
    setAllOpenedError(null)
    try {
      const data = await fetchOpenedContactsForAll()
      setAllOpened(data || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load all-campaign openers'
      setAllOpenedError(msg)
      setAllOpened([])
    } finally {
      setAllOpenedLoading(false)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadConfigs(), loadPending(), loadAllOpened()])
    await loadCampaigns()
  }, [loadConfigs, loadPending, loadAllOpened, loadCampaigns])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAll()
      void loadTemplates()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshAll, loadTemplates])

  // Auto-refresh the campaigns + follow-up config data while the Active
  // Follow-ups tab is on screen so the follow-up Open Rate updates as
  // recipients engage.
  useEffect(() => {
    if (tab !== 'active') return
    const interval = window.setInterval(() => {
      void loadConfigs()
      void loadCampaigns()
    }, 15000)
    return () => window.clearInterval(interval)
  }, [tab, loadConfigs, loadCampaigns])

  const handleSelectConfig = (config: FollowupConfigRow) => {
    setActiveConfig(config)
    setSelectedOpenedIds([])
    void loadOpenedContacts(config.campaign_id, config.followup_campaign_id)
  }

  const openComposer = () => {
    setOriginalId('')
    setFollowupMode('manual')
    setReuseExisting(false)
    setExistingFollowupId('')
    setCampaignName('')
    setSubjectLine('')
    setFromName('')
    setCampaignType('Follow Up')
    setHtmlContent('')
    setBodyMode('preview')
    setIsActive(true)
    setSelectedTemplate(null)
    setTemplateLoadingId(null)
    setTemplateLoadError(null)
    setAttachments([])
    setAttachmentError(null)
    setSendInBatches(false)
    setBatchSize(FOLLOWUP_DEFAULT_BATCH_SIZE)
    setBatchDelayHours(1)
    setTab('compose')
  }

  const openEditConfig = (config: FollowupConfigRow) => {
    setOriginalId(String(config.campaign_id))
    setFollowupMode(config.followup_mode === 'automatic' ? 'automatic' : 'manual')
    setSelectedTemplate(null)
    setTemplateLoadingId(null)
    setTemplateLoadError(null)
    setAttachments([])
    setAttachmentError(null)
    setTab('compose')
  }

  /**
   * Load the EXACT selected template's content from its database record and
   * apply it to the Follow-up composer. The Subject Line is never touched by
   * template selection — it is always typed manually by the user.
   *
   *  - template_source === 'database': the template's `body` (the same HTML the
   *    Template Editor saved) fills the Email Body. Full HTML email documents
   *    are used VERBATIM and shown as a rendered visual preview — the HTML/CSS
   *    source is never dumped into the plain-text body. Only legacy plain-text
   *    bodies keep the strip-to-text behaviour. Placeholders stay intact.
   *  - template_source === 'storage': the HTML file is fetched from Supabase
   *    Storage using the row's storage_bucket / storage_path, loaded verbatim
   *    (never stripped, never replaced) and shown as a rendered preview.
   *
   * On failure the previous subject/body are kept untouched and a clear error
   * is shown — the editor is never silently populated with another template or
   * an empty body.
   */
  const handleSelectTemplate = async (t: EmailTemplate) => {
    setSelectedTemplate(t)
    setTemplateLoadError(null)

    if (t.template_source === 'storage') {
      if (!t.storage_bucket || !t.storage_path) {
        setTemplateLoadError(`Template '${t.name}' is missing a storage bucket or file path.`)
        return
      }
      setTemplateLoadingId(t.id)
      try {
        const { data } = supabase.storage
          .from(t.storage_bucket)
          .getPublicUrl(t.storage_path)
        if (!data?.publicUrl) {
          throw new Error('Could not resolve the template file URL.')
        }
        const response = await fetch(data.publicUrl)
        if (!response.ok) {
          throw new Error(`Failed to fetch template file (HTTP ${response.status}).`)
        }
        const html = await response.text()
        if (!html.trim()) {
          throw new Error('The template file is empty.')
        }
        setHtmlContent(fixBrokenImageUrls(html))
        setBodyMode('preview')
        onToast(`Template '${t.name}' loaded successfully.`, 'success')
      } catch (err) {
        setTemplateLoadError(err instanceof Error ? err.message : 'Failed to load template from storage.')
      } finally {
        setTemplateLoadingId(null)
      }
      return
    }

    if (isFullHtmlDocument(t.body || '')) {
      setHtmlContent(t.body || '')
      setBodyMode('preview')
    } else {
      setHtmlContent(stripHtmlTags(t.body || ''))
      setBodyMode('text')
    }
    onToast(`Template '${t.name}' loaded successfully.`, 'success')
  }

  const insertMergeTag = (tag: string) => {
    const ta = bodyRef.current
    if (!ta) {
      setHtmlContent((prev) => prev + tag)
      return
    }
    const start = ta.selectionStart ?? htmlContent.length
    const end = ta.selectionEnd ?? htmlContent.length
    const next = htmlContent.slice(0, start) + tag + htmlContent.slice(end)
    setHtmlContent(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + tag.length
      ta.setSelectionRange(pos, pos)
    })
  }

  /**
   * Reuse a saved follow-up campaign: load its existing attachments into the
   * composer (mirrors the Campaign editor's edit flow) so the saved
   * associations are preserved when the config is re-saved.
   */
  const handleReuseChange = async (value: string) => {
    setExistingFollowupId(value)
    setAttachmentError(null)
    if (!value) {
      setAttachments([])
      return
    }
    const { data, error } = await fetchCampaignAttachments(value)
    if (error) {
      setAttachmentError(error)
      return
    }
    setAttachments(data.map((a) => ({ ...a, persisted: true })))
  }

  /**
   * Upload the chosen files to Supabase Storage and add their metadata to the
   * composer's attachment list. A REUSED follow-up campaign already exists, so
   * files upload directly into its Storage folder and are persisted immediately;
   * a brand-new follow-up campaign uploads to a temporary path and the files are
   * relocated + persisted once the follow-up campaign is created.
   */
  const handleAddAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploadingAttachment(true)
    setAttachmentError(null)
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadFollowupAttachment(
          file,
          reuseExisting && existingFollowupId ? existingFollowupId : null,
        )
        setAttachments((prev) => [...prev, uploaded])
      }
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to upload attachment')
    } finally {
      setUploadingAttachment(false)
      if (attachmentInputRef.current) attachmentInputRef.current.value = ''
    }
  }

  /**
   * Remove an attachment: delete its Storage object (best-effort) and, when the
   * metadata was already persisted against a saved campaign, its DB row, then
   * drop it from the composer's list.
   */
  const handleRemoveAttachment = async (attachment: CampaignAttachment) => {
    const { error } = await removeCampaignAttachment(attachment)
    if (error) {
      onToast(error, 'error')
      return
    }
    const remaining = attachments.filter((a) => a.storage_path !== attachment.storage_path)
    setAttachments(remaining)
    onToast(`Removed ${attachment.file_name}`, 'info')
  }

  const handleCreate = async () => {
    if (!originalId) {
      onToast('Select an original campaign first', 'error')
      return
    }
    if (reuseExisting && !existingFollowupId) {
      onToast('Select an existing follow-up campaign to reuse', 'error')
      return
    }
    if (!reuseExisting) {
      if (!campaignName.trim()) {
        onToast('Follow-up campaign name is required', 'error')
        return
      }
      if (!subjectLine.trim()) {
        onToast('Subject line is required', 'error')
        return
      }
      if (!htmlContent.trim()) {
        onToast('Email body is required', 'error')
        return
      }
    }

    if (enableSchedule) {
      if (scheduleType === 'one_time' && !compDate) {
        onToast('Select a schedule date for the one-time follow-up', 'error')
        return
      }
      if (scheduleType === 'weekly' && selectedDays.length === 0) {
        onToast('Select at least one weekday for the weekly follow-up', 'error')
        return
      }
    }

    if (sendInBatches) {
      const eligibleRemaining =
        originalId === 'all'
          ? allOpened.length
          : Number(selectedOriginal?.opened ?? 0)
      if (!Number.isInteger(batchSize) || batchSize <= 0) {
        onToast('Batch size must be a whole number greater than 0', 'error')
        return
      }
      if (eligibleRemaining > 0 && batchSize > eligibleRemaining) {
        onToast(`Batch size cannot exceed the ${eligibleRemaining} eligible remaining contact(s)`, 'error')
        return
      }
    }

    setCreating(true)
    try {
      const schedule: CampaignScheduleInput | null = enableSchedule
        ? buildScheduleInput({
            scheduleType,
            compDate,
            compTime,
            repeatEvery,
            selectedDays,
            monthlyOption,
            dayOfMonth,
            weekdayRule,
          })
        : null

      const result = await createFollowupConfig({
        original_campaign_id: originalId,
        followup_campaign_id: reuseExisting ? existingFollowupId : null,
        campaign_name: reuseExisting ? undefined : campaignName.trim(),
        subject_line: reuseExisting ? undefined : subjectLine.trim(),
        from_name: reuseExisting ? undefined : fromName.trim() || DEFAULT_FROM_NAME,
        html_content: reuseExisting ? undefined : htmlContent,
        campaign_type: reuseExisting ? undefined : campaignType,
        template_name: selectedTemplate?.name || undefined,
        followup_mode: followupMode,
        is_active: isActive,
        schedule,
        send_in_batches: sendInBatches,
        batch_size: sendInBatches ? batchSize : undefined,
        first_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
        subsequent_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
      })

      // Persist the follow-up's attachments against the follow-up campaign
      // (campaign_attachments + followup-attachments Storage bucket — the
      // follow-up's own attachment infrastructure, never the Campaign flow).
      // Brand-new composer files move from their temporary path into
      // followup/{followup_name}/{unique}-{file} and their metadata row is
      // saved. If any attachment cannot be stored, this throws and the
      // follow-up is NOT reported as created.
      const followupCampaignId = result.followup_campaign_id
        ? String(result.followup_campaign_id)
        : null
      if (followupCampaignId && attachments.length > 0) {
        const relocated = await relocatePendingFollowupAttachments(
          followupCampaignId,
          attachments,
        )
        setAttachments(relocated)
      }

      onToast(
        result.original_campaign_id === 'all'
          ? result.created
            ? 'Follow-up created for all eligible campaigns. Recipients are the unique openers across those campaigns only.'
            : 'Follow-up configured for all eligible campaigns.'
          : result.created
            ? 'Follow-up created. Recipients will be the original campaign\u2019s openers only.'
            : 'Follow-up configured.',
        'success',
      )

      setCampaignName('')
      setSubjectLine('')
      setFromName('')
      setHtmlContent('')
      setBodyMode('preview')
      setExistingFollowupId('')
      setOriginalId('')
      setFollowupMode('manual')
      setIsActive(true)
      setSelectedTemplate(null)
      setTemplateLoadingId(null)
      setTemplateLoadError(null)
      setAttachments([])
      setAttachmentError(null)
      setEnableSchedule(false)
      setScheduleType('one_time')
      setCompDate('')
      setCompTime('10:00 AM')
      setRepeatEvery(1)
      setSelectedDays([])
      setMonthlyOption('day')
      setDayOfMonth(15)
      setWeekdayRule('First Monday')
      setSendInBatches(false)
      setBatchSize(FOLLOWUP_DEFAULT_BATCH_SIZE)
      setBatchDelayHours(1)

      await refreshAll()
      setTab('active')

      if (followupMode === 'manual' && result.config?.id) {
        const fresh = (await fetchFollowupConfigs()).find(
          (c) => String(c.id) === String(result.config?.id),
        )
        if (fresh) handleSelectConfig(fresh)
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to create follow-up', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleSendSelected = async () => {
    if (!activeConfig) return
    if (selectedOpenedIds.length === 0) {
      onToast('Select at least one opened contact', 'error')
      return
    }
    if (!window.confirm(`Send the follow-up to ${selectedOpenedIds.length} selected opened contact(s)?`)) {
      return
    }
    setSendingSelected(true)
    try {
      const originCampaignId = String(activeConfig.campaign_id)
      const followupCampaignId = activeConfig.followup_campaign_id

      // The follow-up campaign's campaigns row is the source of truth for the
      // batch settings. The composer value is used only as a fallback while the
      // batch columns are missing (pre-migration).
      let sendInBatches = true
      let configuredBatchSize =
        Number.isInteger(batchSize) && batchSize > 0
          ? batchSize
          : FOLLOWUP_DEFAULT_BATCH_SIZE
      let firstBatchDelayHours = batchDelayHours
      let subsequentBatchDelayHours = batchDelayHours
      if (followupCampaignId) {
        try {
          const { data: fuCampaign } = await supabase
            .from('campaigns')
            .select('send_in_batches, batch_size, first_batch_delay_hours, subsequent_batch_delay_hours')
            .eq('id', String(followupCampaignId))
            .maybeSingle()
          if (fuCampaign) {
            if (typeof fuCampaign.send_in_batches === 'boolean') {
              sendInBatches = fuCampaign.send_in_batches
            }
            const storedBatchSize = Number(fuCampaign.batch_size)
            if (Number.isInteger(storedBatchSize) && storedBatchSize > 0) {
              configuredBatchSize = storedBatchSize
            }
            const storedFirst = Number(fuCampaign.first_batch_delay_hours)
            if (Number.isFinite(storedFirst) && storedFirst >= 0) {
              firstBatchDelayHours = storedFirst
            }
            const storedSubsequent = Number(fuCampaign.subsequent_batch_delay_hours)
            if (Number.isFinite(storedSubsequent) && storedSubsequent >= 0) {
              subsequentBatchDelayHours = storedSubsequent
            }
          }
        } catch {
          // batch column may be missing before the migration — keep composer value
        }
      }

      // Batching on → QUEUE cloud-driven batches. The follow-up campaign is
      // placed status='scheduled' with next_batch_at = now + the configured
      // first-batch delay (the batch delay columns stored on the campaign row).
      // Persisting the FUTURE next_batch_at up front means the Schedule column
      // immediately shows the exact next batch time (e.g. "Next batch: 12:45 PM")
      // instead of "now" or "Queued — starting soon" while the cron catches up.
      // The every-minute `scheduled-campaign-runner` Edge Function sees a fresh
      // batch campaign (current_batch_number=0) and sends the FIRST batch
      // immediately, then advances next_batch_at after each batch and marks the
      // follow-up "Completed" when every eligible opener is drained. This works
      // with the laptop closed — no browser setTimeout loop, and never a batch
      // larger than the configured batch_size. The already-sent recipients are
      // naturally excluded (their email_logs are already 'sent' and never
      // re-claimed).
      if (sendInBatches) {
        if (!followupCampaignId) {
          throw new Error('Follow-up campaign is required for batched sending')
        }
        // Gap AFTER the first batch — the scheduler computes the same value
        // (first_batch_delay_hours) once it delivers it, so mirror it here.
        const firstDelayMs = Math.max(0, Number(firstBatchDelayHours) || 0) * 60 * 60 * 1000
        const nextBatchAt = new Date(Date.now() + firstDelayMs).toISOString()
        const { error: queueError } = await supabase
          .from('campaigns')
          .update({
            status: 'scheduled',
            next_batch_at: nextBatchAt,
            current_batch_number: 0,
            send_in_batches: true,
            batch_size: configuredBatchSize,
            first_batch_delay_hours: firstBatchDelayHours,
            subsequent_batch_delay_hours: subsequentBatchDelayHours,
            updated_at: new Date().toISOString(),
          })
          .eq('id', String(followupCampaignId))
        if (queueError) {
          throw new Error(`Failed to queue batched follow-up: ${queueError.message}`)
        }
        onToast(
          `Batched follow-up queued — ${configuredBatchSize} per batch, starting immediately. ` +
          `Next batch at ${formatDateTime(nextBatchAt)}.`,
          'success',
        )
        setSelectedOpenedIds([])
        await loadOpenedContacts(originCampaignId, followupCampaignId)
        await refreshAll()
        return
      }

      // Batching off: deliver the follow-up to every selected recipient in a
      // single pass (no artificial throttling).
      let sent = 0
      let skipped = 0
      let failed = 0
      const results = await sendSelectedFollowups(originCampaignId, {
        contact_ids: [...selectedOpenedIds],
        followup_campaign_id: followupCampaignId,
      })
      for (const r of results) {
        if (r.status === 'sent') sent++
        else if (r.status === 'skipped') skipped++
        else if (r.status === 'failed') failed++
      }

      const parts: string[] = []
      if (sent > 0) parts.push(`${sent} sent`)
      if (skipped > 0) parts.push(`${skipped} skipped`)
      if (failed > 0) parts.push(`${failed} failed`)
      onToast(`Follow-up processed: ${parts.join(', ') || 'no recipients'}`, 'success')
      setSelectedOpenedIds([])
      await loadOpenedContacts(originCampaignId, followupCampaignId)
      await refreshAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to send follow-up', 'error')
    } finally {
      setSendingSelected(false)
    }
  }

  const handleSendPending = async (id: string) => {
    if (sendingPendingId) return
    if (!window.confirm('Send this follow-up email now?')) return
    setSendingPendingId(id)
    try {
      await sendPendingFollowup(id)
      onToast('Follow-up sent', 'success')
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to send follow-up', 'error')
    } finally {
      setSendingPendingId(null)
      await refreshAll()
    }
  }

  const handleModeChange = async (config: FollowupConfigRow, mode: FollowupMode) => {
    try {
      await updateFollowupConfig(String(config.id), { followup_mode: mode })
      onToast(`Follow-up mode set to ${mode}`, 'success')
      await refreshAll()
      if (activeConfig && String(activeConfig.id) === String(config.id)) {
        setActiveConfig((prev) => (prev ? { ...prev, followup_mode: mode } : prev))
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update follow-up', 'error')
    }
  }

  const handleToggleActive = async (config: FollowupConfigRow) => {
    const next = !config.is_active
    if (!next && !window.confirm('Disable this follow-up configuration?')) return
    try {
      const result = await updateFollowupConfig(String(config.id), { is_active: next })
      if (result === null) {
        onToast('Follow-up disabled', 'success')
      } else {
        onToast('Follow-up enabled', 'success')
      }
      if (activeConfig && String(activeConfig.id) === String(config.id)) {
        setActiveConfig(null)
        setOpenedContacts([])
        setSelectedOpenedIds([])
      }
      await refreshAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update follow-up', 'error')
    }
  }

  const handleDelete = async (config: FollowupConfigRow) => {
    if (!window.confirm(
      `Delete this follow-up for "${config.original_campaign_name}"? ` +
      'The original campaign, its contacts and email logs are kept.',
    )) return
    try {
      await deleteFollowupConfig(String(config.id))
      onToast('Follow-up deleted', 'success')
      if (activeConfig && String(activeConfig.id) === String(config.id)) {
        setActiveConfig(null)
        setOpenedContacts([])
        setSelectedOpenedIds([])
      }
      await refreshAll()
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete follow-up', 'error')
    }
  }

  const cardStyle = {
    padding: '24px',
    background: '#FFFFFF',
    borderRadius: '16px',
    border: '1px solid #E5E7EB',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
  } as const

  const sectionLabel: React.CSSProperties = {
    fontSize: '12px',
    letterSpacing: '0.05em',
    color: '#8A94A6',
    marginBottom: '16px',
    fontWeight: 700,
    textTransform: 'uppercase',
  }

  const fieldLabel: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 600,
    color: '#334155',
    display: 'block',
    marginBottom: '6px',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    height: '48px',
    padding: '0 16px',
    border: '1px solid #E2E8F0',
    borderRadius: '10px',
    fontSize: '13px',
    outline: 'none',
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    background: '#FFFFFF',
    cursor: 'pointer',
  }

  const radioStyle: React.CSSProperties = {
    accentColor: '#2563EB',
    width: '16px',
    height: '16px',
    cursor: 'pointer',
    margin: 0,
  }

  const radioLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    color: '#334155',
    cursor: 'pointer',
    fontWeight: 500,
  }

  return (
    <div className="page active">
      <div className="fu-header">
        <div>
          <div className="fu-title">Follow-ups</div>
          <div className="fu-sub">Build and manage follow-ups for campaign openers</div>
        </div>
        <div className="fu-header-actions">
          {tab !== 'compose' && (
            <button className="btn btn-primary btn-sm" onClick={openComposer}>
              + New Follow-up
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => void refreshAll()}>
            ⟳ Refresh
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onNavigate('campaigns')}>
            Open Campaigns
          </button>
        </div>
      </div>

      <div className="tabs">
        <div className={`tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>
          Active Follow-ups
        </div>
        <div className={`tab ${tab === 'compose' ? 'active' : ''}`} onClick={openComposer}>
          Composer & Editor
        </div>
        <div className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
          Pending Follow-ups
        </div>
      </div>

      {tab === 'active' && (
        <div>
          <div className="fu-banner">
            <span className="fu-banner-ic" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
            <div className="fu-banner-text">
              Follow-up recipients are always the contacts who opened the original campaign (
              <span style={{ fontFamily: 'var(--mono)' }}>email_logs WHERE opened = true</span>).
              A follow-up is never sent to a segment or the full audience — if nobody opened, the
              follow-up is not sent at all. Each recipient receives the follow-up once.
            </div>
          </div>

          <div className="fu-panel">
            <div className="fu-panel-head">
              <div>
                <div className="fu-panel-title">Active Follow-ups</div>
                <div className="fu-panel-count">
                  {configs.length} {configs.length === 1 ? 'follow-up' : 'follow-ups'} configured
                </div>
              </div>
            </div>

            <div className="fu-table-wrap">
              <table className="fu-table">
                <colgroup>
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '9%' }} />
                  <col style={{ width: '6%' }} />
                  <col style={{ width: '10%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Follow-up Name</th>
                    <th>Original Campaign</th>
                    <th>Type</th>
                    <th>Openers</th>
                    <th>Sent</th>
                    <th>Schedule</th>
                    <th>Delivered</th>
                    <th>Open Rate</th>
                    <th>Click Rate</th>
                    <th>Status</th>
                    <th className="fu-actions-th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {configsLoading ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty-state">
                          <div className="empty-icon">⟳</div>
                          <div className="empty-title">Loading follow-ups…</div>
                        </div>
                      </td>
                    </tr>
                  ) : configsError ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty-state">
                          <div className="empty-icon">⚠</div>
                          <div className="empty-title">Could not load follow-ups</div>
                          <div className="empty-sub">{configsError}</div>
                        </div>
                      </td>
                    </tr>
                  ) : configs.length === 0 ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty-state">
                          <div className="empty-icon">↪</div>
                          <div className="empty-title">No follow-ups configured</div>
                          <div className="empty-sub">
                            Create one in the Composer & Editor tab — the follow-up is only ever sent
                            to the original campaign's openers.
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    visibleConfigs.map((config) => {
                      const isSelected = activeConfig && String(activeConfig.id) === String(config.id)
                      const followUpCampaign = campaignsById.get(String(config.followup_campaign_id || ''))
                      let scheduleText =
                        (config.schedule_text && config.schedule_text !== '--')
                          ? config.schedule_text
                          : (followUpCampaign?.scheduleText && followUpCampaign.scheduleText !== '--')
                            ? followUpCampaign.scheduleText
                            : '—'
                      // Cloud-batched follow-up: the Schedule column shows the NEXT
                      // BATCH send time from the DB (next_batch_at), or "Completed"
                      // when every eligible opener has been drained. A batch whose
                      // next_batch_at is null despite recipients remaining (or whose
                      // next_batch_at is already in the past) is DUE — it is picked
                      // up immediately by the every-minute scheduler, so we show that
                      // rather than a stale "Queued — starting soon", which should
                      // only appear when a genuinely future batch is pending.
                      //
                      // A SCHEDULED batched follow-up before its first batch fires
                      // has no next_batch_at yet (null) but is NOT due — its first
                      // batch is gated by the calendar schedule (e.g. 2:05 PM). We
                      // must show that scheduled time, NOT "Processing — due now",
                      // while the schedule is still in the future.
                      if (config.batch_enabled) {
                        if (config.remaining_eligible === 0) {
                          scheduleText = 'Completed'
                        } else if (config.next_batch_at && new Date(config.next_batch_at).getTime() > Date.now()) {
                          scheduleText = `Next batch: ${formatDateTime(config.next_batch_at)}`
                        } else if (
                          config.is_scheduled &&
                          scheduleText &&
                          scheduleText !== '—'
                        ) {
                          scheduleText = `Next batch: ${scheduleText.replace(/^Next batch:\s*/i, '')}`
                        } else {
                          scheduleText = 'Processing — due now'
                        }
                      }
                      const delivered = config.followup_delivered
                      return (
                        <tr key={String(config.id)} className={isSelected ? 'fu-selected' : undefined}>
                          <td>
                            <div className="fu-name-cell">
                              <FollowupAvatar name={config.followup_campaign_name || 'FU'} />
                              <div className="fu-name-col">
                                <div className="fu-name" title={config.followup_campaign_name || '—'}>
                                  {config.followup_campaign_name || '—'}
                                </div>
                                <div className="fu-id">
                                  {String(config.followup_campaign_id || '').slice(0, 8)}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="fu-camp" title={config.original_campaign_name || '—'}>
                              {config.original_campaign_name || '—'}
                            </div>
                          </td>
                          <td>
                            <CampaignTypeChip type={followUpCampaign?.campaignType || 'Follow Up'} />
                          </td>
                          <td>
                            <div className="fu-num">{config.opened_count}</div>
                            <div className="fu-num-label">openers</div>
                          </td>
                          <td>
                            <div className="fu-num">{config.sent_count}</div>
                            <div className="fu-num-label">
                              {config.remaining_eligible > 0
                                ? `${config.remaining_eligible} eligible`
                                : 'all eligible sent'}
                            </div>
                          </td>
                          <td>
                            <div className={`fu-schedule${scheduleText !== '—' ? '' : ' fu-schedule-muted'}`}>
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <circle cx="12" cy="12" r="10" />
                                <polyline points="12 6 12 12 16 14" />
                              </svg>
                              <span title={scheduleText}>{scheduleText}</span>
                            </div>
                          </td>
                          <td>
                            <div className="fu-num">{delivered > 0 ? delivered : '—'}</div>
                            <div className="fu-num-label">{delivered > 0 ? 'delivered' : 'no sends yet'}</div>
                          </td>
                          <td>
                            {delivered > 0 ? (
                              <RateCell
                                rate={config.followup_open_rate}
                                count={config.followup_opened}
                                delivered={delivered}
                                label="opened"
                              />
                            ) : (
                              <span className="fu-empty-val">—</span>
                            )}
                          </td>
                          <td>
                            {delivered > 0 ? (
                              <RateCell
                                rate={config.followup_click_rate}
                                count={config.followup_clicked}
                                delivered={delivered}
                                label="clicked"
                              />
                            ) : (
                              <span className="fu-empty-val">—</span>
                            )}
                          </td>
                          <td>
                            <span className={`tag ${config.is_active ? 'tag-client' : 'tag-draft'}`}>
                              {config.is_active ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                          <td>
                            <div className="fu-cell-actions">
                              <div className="fu-cell-actions-row">
                                {config.is_scheduled ? (
                                  <span
                                    className="tag tag-client"
                                    title={scheduleText}
                                  >
                                    Scheduled
                                  </span>
                                ) : config.followup_mode === 'manual' &&
                                  (config.remaining_eligible > 0 ? (
                                    <button
                                      className="fu-btn-xs"
                                      onClick={() => handleSelectConfig(config)}
                                    >
                                      {isSelected ? 'Openers…' : 'Send'}
                                    </button>
                                  ) : (
                                    <span
                                      className="tag tag-draft"
                                      title="Every eligible opener has already received this follow-up"
                                    >
                                      All sent
                                    </span>
                                  ))}
                                <select
                                  value={config.followup_mode === 'automatic' ? 'automatic' : 'manual'}
                                  onChange={(e) => void handleModeChange(config, e.target.value as FollowupMode)}
                                  className="fu-mode-select"
                                  title={config.is_scheduled ? 'Scheduled follow-ups are delivered at their schedule' : 'Follow-up mode'}
                                  disabled={config.is_scheduled}
                                >
                                  <option value="manual">Manual</option>
                                  <option value="automatic">Automatic</option>
                                </select>
                              </div>
                              <div className="fu-cell-actions-row">
                                <button
                                  className="fu-btn-xs"
                                  onClick={() => void handleToggleActive(config)}
                                  title={config.is_active ? 'Disable follow-up' : 'Enable follow-up'}
                                >
                                  {config.is_active ? 'Disable' : 'Enable'}
                                </button>
                                <button
                                  className="ct-ibtn ct-ibtn-edit"
                                  title="Edit follow-up in composer"
                                  onClick={() => openEditConfig(config)}
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    width="15"
                                    height="15"
                                  >
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                    <path d="m15 5 4 4" />
                                  </svg>
                                </button>
                                <button
                                  className="ct-ibtn ct-ibtn-danger"
                                  title="Delete follow-up (keeps the original campaign)"
                                  onClick={() => void handleDelete(config)}
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    width="15"
                                    height="15"
                                  >
                                    <path d="M3 6h18" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    <line x1="10" y1="11" x2="10" y2="17" />
                                    <line x1="14" y1="11" x2="14" y2="17" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {!configsLoading && !configsError && configs.length > 0 && (
              <div className="fu-foot">
                <div className="fu-foot-info">
                  Showing{' '}
                  <strong>{configs.length > 0 ? (effectivePage - 1) * FOLLOWUP_PAGE_SIZE + 1 : 0}</strong> to{' '}
                  <strong>{Math.min(effectivePage * FOLLOWUP_PAGE_SIZE, configs.length)}</strong> of{' '}
                  <strong>{configs.length}</strong> follow-ups
                </div>
                <div className="pagination">
                  <button
                    className="pg-btn"
                    disabled={effectivePage === 1}
                    onClick={() => setActivePage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={`pg-btn ${p === effectivePage ? 'active' : ''}`}
                      onClick={() => setActivePage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    className="pg-btn"
                    disabled={effectivePage === totalPages}
                    onClick={() => setActivePage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>

          {activeConfig && (
            <div className="card" style={{ ...cardStyle, marginTop: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div>
                  <div style={sectionLabel}>
                    {activeConfig.is_scheduled
                      ? `Send Follow-up · Scheduled`
                      : `Send Follow-up · Manual Mode`}
                  </div>
                  <div style={{ fontSize: '13px', color: '#334155', fontWeight: 600, marginTop: '4px' }}>
                    {activeConfig.original_campaign_name} → {activeConfig.followup_campaign_name}
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#8A94A6', marginTop: '2px' }}>
                    {activeConfig.is_scheduled ? (
                      <>
                        This follow-up is scheduled for automatic delivery — manual on-demand sending is
                        disabled. Delivery: <strong>{activeConfig.schedule_text || '—'}</strong> (IST).
                      </>
                    ) : (
                      <>
                        Only contacts who opened the original campaign are shown. Already-sent contacts are
                        skipped.
                        {activeConfig.remaining_eligible === 0
                          ? ' Every eligible opener has already received the follow-up.'
                          : ` ${activeConfig.remaining_eligible} eligible opener(s) still remain.`}
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={openedLoading}
                  onClick={() => void loadOpenedContacts(activeConfig.campaign_id, activeConfig.followup_campaign_id)}
                >
                  {openedLoading ? 'Loading…' : '⟳ Refresh'}
                </button>
              </div>

              {openedError ? (
                <div style={{ fontSize: '12.5px', color: '#DC2626' }}>{openedError}</div>
              ) : openedLoading ? (
                <div style={{ fontSize: '12.5px', color: '#8A94A6' }}>Loading opened contacts…</div>
              ) : openedContacts.length === 0 ? (
                <div style={{ fontSize: '12.5px', color: '#8A94A6' }}>
                  No contacts have opened "{activeConfig.original_campaign_name}" yet. When nobody opens, the follow-up is not sent.
                </div>
              ) : (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: '#334155', cursor: 'pointer', fontWeight: 600, marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={selectedOpenedIds.length === openedContacts.length}
                      onChange={(e) => setSelectedOpenedIds(e.target.checked ? openedContacts.map((c) => c.contact_id) : [])}
                      style={{ accentColor: '#2563EB', width: '14px', height: '14px', cursor: 'pointer', margin: 0 }}
                    />
                    Select All ({openedContacts.length})
                  </label>
                  <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid #E2E8F0', borderRadius: '10px' }}>
                    {openedContacts.map((c) => (
                      <label
                        key={c.contact_id}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', borderBottom: '1px solid #F1F5F9', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedOpenedIds.includes(c.contact_id)}
                          onChange={(e) => {
                            setSelectedOpenedIds((prev) =>
                              e.target.checked
                                ? [...prev, c.contact_id]
                                : prev.filter((id) => id !== c.contact_id),
                            )
                          }}
                          style={{ accentColor: '#2563EB', width: '14px', height: '14px', cursor: 'pointer', marginTop: '2px' }}
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                          <span style={{ fontSize: '13px', fontWeight: 500, color: '#334155' }}>{c.name || '—'}</span>
                          <span style={{ fontSize: '11.5px', color: '#8A94A6' }}>
                            {c.email}
                            {c.company ? ` • ${c.company}` : ''}
                            {c.designation ? ` • ${c.designation}` : ''}
                          </span>
                          <span style={{ fontSize: '11px', color: '#94A3B8', fontFamily: 'var(--mono)' }}>
                            Opened: {formatDateTime(c.opened_at)}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleSendSelected()}
                    disabled={activeConfig.is_scheduled || sendingSelected || selectedOpenedIds.length === 0 || activeConfig.remaining_eligible === 0}
                    style={{
                      marginTop: '12px',
                      background: '#2563EB',
                      color: '#FFFFFF',
                      border: 'none',
                      borderRadius: '10px',
                      padding: '0 20px',
                      height: '42px',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor:
                        activeConfig.is_scheduled || sendingSelected || selectedOpenedIds.length === 0 || activeConfig.remaining_eligible === 0
                          ? 'not-allowed'
                          : 'pointer',
                      opacity:
                        activeConfig.is_scheduled || sendingSelected || selectedOpenedIds.length === 0 || activeConfig.remaining_eligible === 0
                          ? 0.5
                          : 1,
                    }}
                  >
                    {activeConfig.is_scheduled
                      ? 'Scheduled · Manual send disabled'
                      : sendingSelected
                        ? 'Sending…'
                        : `Send Follow-up to Selected (${selectedOpenedIds.length})`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'compose' && (
        <div className="composer-layout" style={{ fontFamily: '"Inter", sans-serif' }}>
          <div className="composer-left">
            <div className="card" style={cardStyle}>
              <div style={sectionLabel}>Follow-up Details</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={fieldLabel}>Original Campaign *</label>
                  <select value={originalId} onChange={(e) => setOriginalId(e.target.value)} style={selectStyle}>
                    <option value="">Select the campaign whose openers receive the follow-up…</option>
                    <option value="all">All</option>
                    {originalOptions.map((c) => (
                      <option key={String(c.id)} value={String(c.id)}>
                        {String(c.name || 'Unnamed')} · {String(c.campaignType || c.type || '')} · {String(c.opened ?? 0)} opened
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div style={{ ...fieldLabel, marginBottom: '8px' }}>Follow-up Mode</div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    {([
                      { key: 'manual', label: 'Manual' },
                      { key: 'automatic', label: 'Automatic' },
                    ] as { key: FollowupMode; label: string }[]).map(({ key, label }) => (
                      <label key={key} style={radioLabelStyle}>
                        <input
                          type="radio"
                          name="followupMode"
                          checked={followupMode === key}
                          onChange={() => setFollowupMode(key)}
                          style={radioStyle}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: '11px', color: '#8A94A6', marginTop: '4px' }}>
                    Manual queues a follow-up for review before sending; Automatic sends immediately to each opener.
                  </div>
                </div>

                <div>
                  <div style={{ ...fieldLabel, marginBottom: '8px' }}>Follow-up Campaign</div>
                  <div style={{ display: 'flex', gap: '24px', marginBottom: '12px' }}>
                    {([
                      { key: false, label: 'Create a new follow-up campaign' },
                      { key: true, label: 'Reuse an existing campaign' },
                    ] as { key: boolean; label: string }[]).map(({ key, label }) => (
                      <label key={label} style={radioLabelStyle}>
                        <input
                          type="radio"
                          name="reuseExisting"
                          checked={reuseExisting === key}
                          onChange={() => setReuseExisting(key)}
                          style={radioStyle}
                        />
                        {label}
                      </label>
                    ))}
                  </div>

                  {reuseExisting ? (
                    <select
                      value={existingFollowupId}
                      onChange={(e) => void handleReuseChange(e.target.value)}
                      style={selectStyle}
                    >
                      <option value="">Select an existing campaign to use as the follow-up…</option>
                      {reuseOptions.map((c) => (
                        <option key={String(c.id)} value={String(c.id)}>
                          {String(c.name || 'Unnamed')} · {String(c.status || '')}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={fieldLabel}>Follow-up Name *</label>
                          <input
                            type="text"
                            value={campaignName}
                            onChange={(e) => setCampaignName(e.target.value)}
                            placeholder="e.g. Follow-up: track1 openers"
                            style={inputStyle}
                          />
                        </div>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={fieldLabel}>Campaign Type</label>
                          <select
                            value={campaignType}
                            onChange={(e) => setCampaignType(e.target.value)}
                            style={selectStyle}
                          >
                            {CAMPAIGN_TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={fieldLabel}>Subject Line *</label>
                          <input
                            type="text"
                            value={subjectLine}
                            onChange={(e) => setSubjectLine(e.target.value)}
                            placeholder="Did you see this?"
                            style={inputStyle}
                          />
                        </div>
                        <div className="form-group" style={{ margin: 0 }}>
                          <label style={fieldLabel}>From Name</label>
                          <input
                            type="text"
                            value={fromName}
                            onChange={(e) => setFromName(e.target.value)}
                            placeholder={DEFAULT_FROM_NAME}
                            style={inputStyle}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ ...fieldLabel, marginBottom: '8px' }}>Audience / Recipients</div>
                  <div
                    style={{
                      fontSize: '12px',
                      color: '#475569',
                      background: '#F8FAFC',
                      border: '1px solid #E2E8F0',
                      borderRadius: '10px',
                      padding: '10px 14px',
                      lineHeight: 1.5,
                    }}
                  >
                    {originalId === 'all' ? (
                      allOpenedLoading ? (
                        <>Loading all-campaign openers…</>
                      ) : allOpenedError ? (
                        <span style={{ color: 'var(--red)' }}>{allOpenedError}</span>
                      ) : (
                        <>
                          Follow-up recipients are{' '}
                          <strong>{allOpened.length}</strong> unique opened
                          recipient(s) across <strong>all eligible campaigns</strong> —
                          contacts who did not open any eligible campaign are never included,
                          and a contact who opened several campaigns is counted once.
                        </>
                      )
                    ) : selectedOriginal ? (
                      <>
                        Follow-up recipients are{' '}
                        <strong>{String(selectedOriginal.opened ?? 0)}</strong> opened recipient(s)
                        of "<strong>{String(selectedOriginal.name)}</strong>" — contacts who did not
                        open it are never included.
                      </>
                    ) : (
                      <>
                        Select an original campaign above to see who will receive the follow-up.
                        Recipients are determined only from contacts who opened that campaign.
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="card" style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: '12px' }}>Follow-up Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={radioLabelStyle}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    style={radioStyle}
                  />
                  Enable follow-up automation
                </label>
                <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                  When a recipient opens the original campaign's email, the follow-up is sent
                  (Automatic) or queued for review (Manual) to that opener only.
                </div>
              </div>
            </div>

            <div className="card" style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: '12px' }}>Follow-up Schedule Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <label style={radioLabelStyle}>
                  <input
                    type="checkbox"
                    checked={enableSchedule}
                    onChange={(e) => setEnableSchedule(e.target.checked)}
                    style={radioStyle}
                  />
                  Schedule this follow-up for automatic delivery
                </label>
                <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                  When a schedule is set, the follow-up is delivered by the campaign scheduler to
                  the original campaign's openers only at the scheduled times (One Time / Weekly /
                  Monthly, IST). A scheduled follow-up is not sent on-open and its Manual send
                  controls are disabled. Toggle off to keep automatic / manual on-open delivery.
                </div>

                {enableSchedule && (
                  <>
                    <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
                    <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Schedule Settings</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Schedule Type</div>
                        <div style={{ display: 'flex', gap: '24px' }}>
                          {([
                            { key: 'one_time', label: 'One Time' },
                            { key: 'weekly', label: 'Weekly' },
                            { key: 'monthly', label: 'Monthly' },
                          ] as { key: ScheduleType; label: string }[]).map(({ key, label }) => (
                            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                              <input
                                type="radio"
                                name="fuScheduleType"
                                checked={scheduleType === key}
                                onChange={() => setScheduleType(key)}
                                style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>

                      {scheduleType === 'one_time' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '12px' }}>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Schedule Date</label>
                            <input
                              type="date"
                              value={compDate}
                              onChange={(e) => setCompDate(e.target.value)}
                              style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                            />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                            <input
                              type="text"
                              value={compTime}
                              onChange={(e) => setCompTime(e.target.value)}
                              style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                            />
                          </div>
                        </div>
                      )}

                      {scheduleType === 'weekly' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                            <input
                              type="number"
                              min={1}
                              value={repeatEvery}
                              onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                              style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                            />
                            <span style={{ fontSize: '13px', color: '#64748B' }}>Week(s)</span>
                          </div>
                          <div>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Send On</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
                              {WEEKDAY_NAMES.map((day) => {
                                const isChecked = selectedDays.includes(day)
                                return (
                                  <label key={day} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => setSelectedDays((prev) => (isChecked ? prev.filter((d) => d !== day) : [...prev, day]))}
                                      style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                                    />
                                    {day}
                                  </label>
                                )
                              })}
                            </div>
                          </div>
                          <div>
                            <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                            <input
                              type="text"
                              value={compTime}
                              onChange={(e) => setCompTime(e.target.value)}
                              style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                            />
                          </div>
                        </div>
                      )}

                      {scheduleType === 'monthly' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                            <input
                              type="number"
                              min={1}
                              value={repeatEvery}
                              onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                              style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                            />
                            <span style={{ fontSize: '13px', color: '#64748B' }}>Month(s)</span>
                          </div>
                          <div>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Monthly Schedule</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                                <input
                                  type="radio"
                                  name="fuMonthlyOption"
                                  checked={monthlyOption === 'day'}
                                  onChange={() => setMonthlyOption('day')}
                                  style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                                />
                                Day of Month
                                <input
                                  type="number"
                                  min={1}
                                  max={31}
                                  value={dayOfMonth}
                                  disabled={monthlyOption !== 'day'}
                                  onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                                  style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center', background: monthlyOption === 'day' ? '#FFFFFF' : '#F8FAFC', opacity: monthlyOption === 'day' ? 1 : 0.5 }}
                                />
                              </label>
                              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                                <input
                                  type="radio"
                                  name="fuMonthlyOption"
                                  checked={monthlyOption === 'weekday'}
                                  onChange={() => setMonthlyOption('weekday')}
                                  style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                                />
                                Weekday
                                <select
                                  value={weekdayRule}
                                  disabled={monthlyOption !== 'weekday'}
                                  onChange={(e) => setWeekdayRule(e.target.value)}
                                  style={{ height: '40px', padding: '0 10px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: monthlyOption === 'weekday' ? '#FFFFFF' : '#F8FAFC', cursor: 'pointer', opacity: monthlyOption === 'weekday' ? 1 : 0.5, minWidth: '150px' }}
                                >
                                  {MONTHLY_RULES.map((rule) => (
                                    <option key={rule} value={rule}>{rule}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          </div>
                          <div>
                            <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                            <input
                              type="text"
                              value={compTime}
                              onChange={(e) => setCompTime(e.target.value)}
                              style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="card" style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: '12px' }}>Sending Limits</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    checked={sendInBatches}
                    onChange={(e) => setSendInBatches(e.target.checked)}
                    style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                  />
                  Send in batches
                </label>

                {sendInBatches && (() => {
                  const audienceEligible =
                    originalId === 'all'
                      ? allOpened.length
                      : Number(selectedOriginal?.opened ?? 0)
                  const batchSizeInvalid =
                    !Number.isInteger(batchSize) ||
                    batchSize <= 0 ||
                    (audienceEligible > 0 && batchSize > audienceEligible)
                  const estimatedBatches =
                    audienceEligible > 0 && batchSize > 0
                      ? Math.ceil(audienceEligible / batchSize)
                      : 0
                  const delayLabel = DELAY_OPTIONS.find(o => o.value === batchDelayHours)?.label || '1 Hour'
                  const audienceLabel =
                    originalId === 'all'
                      ? 'All eligible campaigns'
                      : originalId && selectedOriginal
                        ? String(selectedOriginal.name)
                        : originalId
                          ? 'Selected campaign'
                          : 'No campaign selected'

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px' }}>
                      <div style={{ display: 'flex', gap: '24px' }}>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <label style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Batch Size</label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="number"
                              value={batchSize}
                              onChange={(e) => setBatchSize(Math.max(0, parseInt(e.target.value, 10) || 0))}
                              min={1}
                              max={Math.max(1, audienceEligible)}
                              step={1}
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
                          {batchSizeInvalid && (
                            <div style={{ fontSize: '12px', color: '#DC2626', fontWeight: 500 }}>
                              {!Number.isInteger(batchSize) || batchSize <= 0
                                ? 'Batch size must be a whole number greater than 0.'
                                : `Batch size cannot exceed the ${audienceEligible} eligible remaining contact(s).`}
                            </div>
                          )}
                          <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                            {audienceEligible > 0
                              ? `Whole number between 1 and ${audienceEligible} eligible remaining contact(s).`
                              : 'Whole number of contacts sent per batch.'}
                          </div>
                        </div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <label style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Send next batch after</label>
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
                            {DELAY_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                          <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                            Waiting period between every pair of consecutive batches.
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '13px', color: '#1D4ED8', fontWeight: 500 }}>
                          {batchSize > 0 ? `${batchSize} contacts will be sent every ${delayLabel}.` : 'Enter a batch size to see the sending plan.'}
                        </div>
                        <div style={{ fontSize: '12px', color: '#475569' }}>
                          Audience: {audienceLabel} ({audienceEligible})
                        </div>
                        <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                          Remaining eligible contacts: {audienceEligible}
                        </div>
                        <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                          Estimated batches: {estimatedBatches}
                        </div>

                        {estimatedBatches > 0 && (
                          <div style={{
                            maxHeight: '200px',
                            overflowY: 'auto',
                            fontSize: '12px',
                            color: '#334155',
                            background: '#FFFFFF',
                            border: '1px solid #E2E8F0',
                            borderRadius: '8px',
                            padding: '12px'
                          }}>
                            {Array.from({ length: estimatedBatches }, (_, i) => {
                              const start = i * batchSize + 1
                              const end = Math.min((i + 1) * batchSize, audienceEligible)
                              return (
                                <div key={i} style={{ padding: '4px 0', borderBottom: i < estimatedBatches - 1 ? '1px solid #F1F5F9' : 'none' }}>
                                  Batch {i + 1}: S.No. {start}–{end}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}
              </div>
            </div>

            <div className="card" style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: '12px' }}>Attachments</div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                }}
              >
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={uploadingAttachment}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  {uploadingAttachment ? 'Uploading…' : '＋ Upload Attachment'}
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => void handleAddAttachments(e.target.files)}
                />
                <span style={{ fontSize: '11px', color: 'var(--text4)' }}>
                  Max {formatFileSize(20 * 1024 * 1024)} per file. Files are sent with every follow-up email.
                </span>
              </div>

              {attachmentError && (
                <div
                  style={{
                    fontSize: '12px',
                    color: '#DC2626',
                    padding: '8px 10px',
                    marginTop: '10px',
                    background: '#FEF2F2',
                    border: '1px solid #FECACA',
                    borderRadius: '8px',
                  }}
                >
                  {attachmentError}
                </div>
              )}

              {attachments.length > 0 ? (
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {attachments.map((att) => (
                    <div
                      key={att.storage_path}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px solid #E2E8F0',
                        background: '#F8FAFC',
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: '#1E293B',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {att.file_name}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--text4)' }}>
                          {att.file_type || 'unknown type'} · {formatFileSize(att.file_size)}
                        </span>
                      </div>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => void handleRemoveAttachment(att)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '10px' }}>
                  No attachments. Optional — attached files are included when follow-ups are sent.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating}
                className="btn btn-primary"
                style={{ height: '44px', padding: '0 24px', fontSize: '13px', fontWeight: 600 }}
              >
                {creating ? 'Creating…' : 'Create Follow-up'}
              </button>
            </div>
          </div>

          <div className="composer-right">
            <div className="card" style={cardStyle}>
              <div style={{ ...sectionLabel, marginBottom: '14px' }}>Load Template</div>
              {templatesLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                  <CircularProgress size={26} />
                </div>
              ) : templatesError ? (
                <div style={{ fontSize: '12px', color: 'var(--red)', padding: '8px 0' }}>
                  {templatesError}
                </div>
              ) : templates.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text4)', padding: '8px 0' }}>
                  No templates available
                </div>
              ) : (
                <>
                  {templateLoadError && (
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#DC2626',
                        padding: '8px 10px',
                        marginBottom: '10px',
                        background: '#FEF2F2',
                        border: '1px solid #FECACA',
                        borderRadius: '8px',
                      }}
                    >
                      {templateLoadError}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    {templates.map((tmpl) => {
                      const isActive = selectedTemplate?.id === tmpl.id
                      const isLoading = templateLoadingId === tmpl.id
                      return (
                        <div
                          key={tmpl.id}
                          onClick={() => void handleSelectTemplate(tmpl)}
                          style={{
                            height: '72px',
                            padding: '12px 14px',
                            borderRadius: '12px',
                            border: isActive ? '2px solid #2563EB' : '1px solid #E5E7EB',
                            background: isActive ? '#EFF6FF' : '#FFFFFF',
                            cursor: isLoading ? 'default' : 'pointer',
                            opacity: isLoading ? 0.6 : 1,
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'center',
                            boxSizing: 'border-box',
                            position: 'relative',
                          }}
                          onMouseOver={(e) => {
                            if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#CBD5E1'
                          }}
                          onMouseOut={(e) => {
                            if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#E5E7EB'
                          }}
                        >
                          {isLoading && (
                            <div
                              style={{
                                position: 'absolute',
                                top: '8px',
                                right: '8px',
                                display: 'flex',
                              }}
                            >
                              <CircularProgress size={14} thickness={5} />
                            </div>
                          )}
                          <div style={{ fontSize: '13px', fontWeight: 700, color: isActive ? '#1E40AF' : '#1E293B', marginBottom: '4px' }}>
                            {tmpl.name}
                          </div>
                          <div style={{ fontSize: '11px', color: isActive ? '#3B82F6' : '#64748B' }}>
                            {tmpl.description}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="card" style={{ ...cardStyle, display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ ...sectionLabel, marginBottom: '14px' }}>Email Body</div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexShrink: 0 }}>
                <button type="button" onClick={() => setBodyMode('text')} style={bodyTabStyle(bodyMode === 'text')}>
                  Plain Text
                </button>
                <button type="button" onClick={() => setBodyMode('html')} style={bodyTabStyle(bodyMode === 'html')}>
                  HTML
                </button>
                <button type="button" onClick={() => setBodyMode('preview')} style={bodyTabStyle(bodyMode === 'preview')}>
                  Preview
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '10px 12px', border: '1px solid #E2E8F0', borderBottom: 'none', borderRadius: '6px 6px 0 0', background: '#FFFFFF' }}>
                {MERGE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => insertMergeTag(tag)}
                    style={{
                      background: '#EFF6FF',
                      border: '1px solid #BFDBFE',
                      color: '#1D4ED8',
                      padding: '4px 10px',
                      borderRadius: '999px',
                      fontSize: '11.5px',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.15s ease',
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#DBEAFE' }}
                    onMouseOut={(e) => { e.currentTarget.style.background = '#EFF6FF' }}
                  >
                    {tag}
                  </button>
                ))}
              </div>

              {bodyMode === 'preview' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px 12px',
                      border: '1px solid #E2E8F0',
                      borderBottom: 'none',
                      background: '#F8FAFC',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontSize: '12px', color: '#475569' }}>
                      Visual preview — placeholders like <span style={{ fontFamily: 'monospace', color: '#1D4ED8' }}>{'{{first_name}}'}</span> stay visible and are replaced automatically when sending.
                    </span>
                  </div>
                  {htmlContent.trim() ? (
                    <iframe
                      title="Follow-up email preview"
                      srcDoc={htmlContent}
                      sandbox=""
                      style={{
                        width: '100%',
                        minHeight: '520px',
                        border: 'none',
                        background: '#FFFFFF',
                        borderRadius: '0 0 6px 6px',
                        display: 'block',
                        boxSizing: 'border-box',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        flex: 1,
                        minHeight: '520px',
                        width: '100%',
                        border: '1px solid #E2E8F0',
                        borderRadius: '0 0 6px 6px',
                        background: '#F8FAFC',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textAlign: 'center',
                        padding: '24px',
                      }}
                    >
                      <div style={{ fontSize: '13.5px', color: '#94A3B8', lineHeight: 1.6 }}>
                        Select a template above to preview its rendered email design.
                        <br />
                        Switch to <strong>HTML</strong> to draft the body from scratch.
                      </div>
                    </div>
                  )}
                </>
              ) : bodyMode === 'text' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px 12px',
                      border: '1px solid #E2E8F0',
                      borderBottom: 'none',
                      background: '#F8FAFC',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontSize: '12px', color: '#475569' }}>
                      Plain text — placeholders like <span style={{ fontFamily: 'monospace', color: '#1D4ED8' }}>{'{{first_name}}'}</span> are replaced automatically when sending.
                    </span>
                  </div>
                  <textarea
                    readOnly
                    value={stripHtmlTags(htmlContent)}
                    placeholder={'Hi {{first_name}},\n\nDid you get a chance to look at the previous email?\n\nBest,\nRupali'}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      minHeight: '520px',
                      width: '100%',
                      border: '1px solid #E2E8F0',
                      padding: '16px',
                      outline: 'none',
                      background: '#F8FAFC',
                      borderRadius: '0 0 6px 6px',
                      fontSize: '13.5px',
                      lineHeight: '1.6',
                      color: '#64748B',
                      overflowY: 'auto',
                      resize: 'vertical',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit',
                    }}
                  />
                </>
              ) : (
                <>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px 12px',
                      border: '1px solid #E2E8F0',
                      borderBottom: 'none',
                      background: '#F8FAFC',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontSize: '12px', color: '#475569' }}>
                      HTML source — edit the raw template markup. Placeholders stay as-is.
                    </span>
                  </div>
                  <textarea
                    ref={bodyRef}
                    value={htmlContent}
                    onChange={(e) => setHtmlContent(e.target.value)}
                    placeholder={'Hi {{first_name}},\n\nDid you get a chance to look at the previous email?\n\nBest,\nRupali'}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      minHeight: '520px',
                      width: '100%',
                      border: '1px solid #E2E8F0',
                      padding: '16px',
                      outline: 'none',
                      background: '#FFFFFF',
                      borderRadius: '0 0 6px 6px',
                      fontSize: '12.5px',
                      lineHeight: '1.6',
                      color: '#334155',
                      overflowY: 'auto',
                      resize: 'vertical',
                      boxSizing: 'border-box',
                      fontFamily: 'monospace',
                    }}
                  />
                </>
              )}
            </div>

          </div>
        </div>
      )}

      {tab === 'pending' && (
        <div>
          <div className="toolbar" style={{ marginBottom: '14px' }}>
            <div className="toolbar-left">
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text3)' }}>
                Follow-ups queued when a recipient opens a campaign with Manual mode. Review and send them here.
              </span>
            </div>
            <div className="toolbar-right">
              <button className="btn btn-secondary btn-sm" onClick={() => void loadPending()}>
                ⟳ Refresh
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Email</th>
                  <th>Original Campaign</th>
                  <th>Follow-up Campaign</th>
                  <th>Opened At</th>
                  <th>Status</th>
                  <th style={{ width: '140px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⟳</div>
                        <div className="empty-title">Loading queue…</div>
                      </div>
                    </td>
                  </tr>
                ) : pendingError ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⚠</div>
                        <div className="empty-title">Could not load the queue</div>
                        <div className="empty-sub">{pendingError}</div>
                      </div>
                    </td>
                  </tr>
                ) : pending.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⏳</div>
                        <div className="empty-title">No pending follow-ups</div>
                        <div className="empty-sub">
                          Manual-mode follow-ups appear here when a recipient opens the original campaign.
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  pending.map((p) => {
                    const canSend = p.status === 'pending' || p.status === 'failed'
                    const isScheduled = configs.some(
                      (c) =>
                        c.is_scheduled &&
                        String(c.followup_campaign_id) === String(p.followup_campaign_id)
                    )
                    return (
                      <tr key={String(p.id)}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{p.recipient_name || '—'}</div>
                        </td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.email}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.campaign_name || '—'}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.followup_campaign_name || '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', fontFamily: 'var(--mono)' }}>
                          {formatDateTime(p.opened_at)}
                        </td>
                        <td>
                          <span className={`tag ${
                            p.status === 'sent' ? 'tag-client' :
                            p.status === 'failed' ? 'tag-oem' : 'tag-draft'
                          }`}>
                            {p.status}
                          </span>
                        </td>
                        <td>
                          {isScheduled ? (
                            <span className="tag tag-client" title="Delivered automatically at its schedule">
                              Scheduled
                            </span>
                          ) : canSend ? (
                            <button
                              className="btn btn-secondary btn-xs"
                              disabled={sendingPendingId === String(p.id)}
                              onClick={() => void handleSendPending(String(p.id))}
                            >
                              {sendingPendingId === String(p.id) ? 'Sending…' : 'Send Follow-up'}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
