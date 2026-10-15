import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TabKey } from '../types'
import type {
  Sequence,
  SequenceBranchStep,
  SequenceBranchStepAttachment,
  StepParentBranch,
} from '../types/sequence'
import type { EmailTemplate } from '../types/campaign'
import { supabase } from '../supabase'
import { fetchTemplates } from '../services/campaignService'
import LoadTemplateControl from '../components/LoadTemplateControl'
import TemplatePreview from '../components/TemplatePreview'
import BranchStepAttachmentsControl from '../components/BranchStepAttachmentsControl'
import {
  fetchBranchStepAttachments,
  removeBranchStepAttachment,
  uploadBranchStepAttachment,
} from '../services/sequenceBranchStepAttachmentService'
import {
  deleteSequence,
  fetchBranchSteps,
  fetchSequences,
  updateBranchStep,
  updateSequence,
} from '../services/sequenceService'

interface SequenceBuilderTabProps {
  onNavigate: (tab: TabKey) => void
  onToast: (msg: string, type?: string) => void
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const text = String(value).trim()
  return text.length > 0 ? text : '—'
}

/* ─── Small inline SVG icon set (same stroke style as the app sidebar) ─── */
function SvgIcon({
  children,
  size = 16,
  strokeWidth = 1.7,
}: {
  children: ReactNode
  size?: number
  strokeWidth?: number
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const IconMail = (
  <>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 5L2 7" />
  </>
)

const IconDoc = (
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>
)

const IconSearch = (
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>
)

const IconFilter = (
  <>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </>
)

const IconPencil = (
  <>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </>
)

const IconTrash = (
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </>
)

const IconLayers = (
  <>
    <path d="m12 2 10 6-10 6L2 8Z" />
    <path d="m2 16 10 6 10-6" />
  </>
)

const IconRefresh = (
  <>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </>
)

/* ─── Sequence Builder display helpers ─── */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  if (parts.length === 0) return 'S'
  return parts.map((part) => part.charAt(0).toUpperCase()).join('')
}

const SEQ_AVATAR_COLORS: Array<{ bg: string; color: string }> = [
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#dcfce7', color: '#047857' },
  { bg: '#fef3c7', color: '#b45309' },
  { bg: '#f5f3ff', color: '#7c3aed' },
  { bg: '#cffafe', color: '#0e7490' },
  { bg: '#fce7f3', color: '#be185d' },
  { bg: '#ede9fe', color: '#6d28d9' },
]

function avatarColorFor(name: string): { bg: string; color: string } {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return SEQ_AVATAR_COLORS[h % SEQ_AVATAR_COLORS.length]
}

function statusTone(status: unknown): string {
  switch (String(status || '').toLowerCase()) {
    case 'active':
      return '#10b981'
    case 'paused':
      return '#f59e0b'
    case 'completed':
      return '#2563eb'
    default:
      return '#94a3b8'
  }
}

function statusText(status: unknown): string {
  const value = display(status)
  if (value === '—') return 'No status'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function recipientText(type: unknown): string {
  const value = display(type)
  if (value === '—') return 'All'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Plain-text preview of an HTML email body (visual only; full body untouched). */
function bodyPreview(value: unknown): string {
  const raw = display(value)
  if (raw === '—') return raw
  const plain = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 0 ? plain : '—'
}

/** Plain-text preview that preserves paragraph breaks (for the view modal). */
function bodyFullText(value: unknown): string {
  const raw = display(value)
  if (raw === '—') return ''
  return String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Truncated subject/body preview with a small "See more" affordance. */
function ClampedText({
  text,
  lines,
  onSeeMore,
}: {
  text: string
  lines: 1 | 2
  onSeeMore: () => void
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const overflows = el.scrollHeight > el.clientHeight + 1
    setTruncated(overflows)
  }, [text, lines])

  return (
    <span className="seqb-clamp">
      <span
        ref={ref}
        className={`seqb-clamp-text ${lines === 2 ? 'seqb-clamp-2' : ''}`}
        title={text}
      >
        {text}
      </span>
      {truncated && (
        <button type="button" className="seqb-cell-more" onClick={onSeeMore}>
          See more
        </button>
      )}
    </span>
  )
}

/** Small column label for a step pair, e.g. "Step 2" or "Branch 2A". */
function stepChipLabel(pair: CardPair): string {
  return pair.isAlt ? `Branch ${pair.level}A` : `Step ${pair.level}`
}

interface StepTitleInfo {
  title: string
  altTitle: string | null
}

function deriveStepTitles(steps: SequenceBranchStep[]): Map<number, StepTitleInfo> {
  const byStep = new Map<number, SequenceBranchStep[]>()
  for (const s of steps) {
    const arr = byStep.get(s.step) ?? []
    arr.push(s)
    byStep.set(s.step, arr)
  }
  const cardSteps = [...byStep.keys()].sort((a, b) => a - b)
  if (cardSteps.length === 0) return new Map()

  const rowById = new Map<number, SequenceBranchStep>()
  for (const s of steps) rowById.set(s.id, s)

  // A node's own name: 'STEP 2' for OPENED / STARTING, 'STEP 2A' for the
  // NOT_OPENED node (both share the same step number but are different rows).
  const nodeName = (row: SequenceBranchStep | undefined): string =>
    row ? `STEP ${row.step}${row.parent_branch === 'NOT_OPENED' ? 'A' : ''}` : 'STEP ?'

  // The real parent node name, resolved by the row id (parent_step_id). Falls
  // back to the numeric parent_step only when the row id is missing (legacy).
  const parentNameOf = (row: SequenceBranchStep): string => {
    if (row.parent_step_id != null) {
      const parent = rowById.get(row.parent_step_id)
      if (parent) return nodeName(parent)
    }
    return row.parent_step != null ? `STEP ${row.parent_step}` : 'STEP 1'
  }

  const result = new Map<number, StepTitleInfo>()
  for (const s of cardSteps) {
    const nodes = byStep.get(s)!
    const primary = nodes.find((n) => n.parent_branch !== 'NOT_OPENED') ?? nodes[0]
    const isNotOpened = primary.parent_branch === 'NOT_OPENED'

    let title: string
    if (primary.parent_branch === 'STARTING' || primary.parent_step === null) {
      title = `STEP ${s} — STARTING`
    } else {
      const branchText = isNotOpened ? 'NOT OPENED' : 'OPENED'
      title = `${nodeName(primary)} — CHILD OF ${parentNameOf(primary)} — ${branchText}`
    }

    let altTitle: string | null = null
    const notOpened = nodes.find((n) => n.parent_branch === 'NOT_OPENED')
    if (notOpened && !isNotOpened) {
      altTitle =
        notOpened.parent_step === null
          ? `${nodeName(notOpened)} — NOT OPENED`
          : `${nodeName(notOpened)} — CHILD OF ${parentNameOf(notOpened)} — NOT OPENED`
    }

    result.set(s, { title, altTitle })
  }
  return result
}

interface CardPair {
  label: string
  level: number
  isAlt: boolean
}

function branchRowFor(
  steps: SequenceBranchStep[] | undefined,
  level: number,
  isAlt: boolean
): SequenceBranchStep | undefined {
  const list = steps || []
  return isAlt
    ? list.find((s) => s.step === level && s.parent_branch === 'NOT_OPENED')
    : list.find((s) => s.step === level && s.parent_branch !== 'NOT_OPENED')
}

interface BranchDraft {
  id: number
  step: number
  parent_step: number | null
  parent_branch: StepParentBranch
  subject: string
  body: string
  wait_hours: string
  /** Selected template id for THIS branch (client-side only, not persisted). */
  template_id: string
  /** Resolved template HTML for this branch — internal, used for sending only. */
  template_html: string
  /** The plain-text body typed before a template was applied (restored on deselect). */
  manual_body: string
  /** True while this branch's Storage HTML is being fetched. */
  loading: boolean
  /** Load error for this branch (kept visible after a failed fetch). */
  error: string | null
  /** Files attached to THIS branch step (sequence_branch_step_attachments). */
  attachments: SequenceBranchStepAttachment[]
  /** True while one of this branch's files is being uploaded. */
  attachments_uploading: boolean
  /** Upload/remove error for this branch's attachments (kept visible). */
  attachments_error: string | null
}

interface BranchFieldsProps {
  draft: BranchDraft
  disabled: boolean
  subjectLabel: string
  bodyLabel: string
  templates: EmailTemplate[]
  templatesLoading: boolean
  onLoadTemplate: (templateId: string) => void
  onClearTemplate: (draftId: number) => void
  onChange: (id: number, key: 'subject' | 'body' | 'wait_hours', value: string) => void
  onAttachFiles: (id: number, files: FileList | null) => void
  onRemoveAttachment: (id: number, attachment: SequenceBranchStepAttachment) => void
}

function BranchFields({
  draft,
  disabled,
  subjectLabel,
  bodyLabel,
  templates,
  templatesLoading,
  onLoadTemplate,
  onClearTemplate,
  onChange,
  onAttachFiles,
  onRemoveAttachment,
}: BranchFieldsProps) {
  const templateName =
    templates.find((t) => t.id === draft.template_id)?.name || undefined
  return (
    <div>
      <div className="form-group" style={{ marginBottom: '0', marginTop: '10px' }}>
        <label>{subjectLabel}</label>
        <input
          type="text"
          value={draft.subject}
          disabled={disabled}
          onChange={(e) => onChange(draft.id, 'subject', e.target.value)}
          placeholder={subjectLabel}
        />
      </div>
      <LoadTemplateControl
        templates={templates}
        templatesLoading={templatesLoading}
        value={draft.template_id}
        loading={draft.loading}
        error={draft.error}
        onSelect={(templateId) =>
          templateId ? onLoadTemplate(templateId) : onClearTemplate(draft.id)
        }
      />
      {draft.template_id && draft.template_html ? (
        <TemplatePreview html={draft.template_html} name={templateName} />
      ) : (
        <div className="form-group" style={{ marginBottom: '0', marginTop: '10px' }}>
          <label>{bodyLabel}</label>
          <textarea
            rows={3}
            value={draft.body}
            disabled={disabled}
            onChange={(e) => onChange(draft.id, 'body', e.target.value)}
            placeholder={bodyLabel}
            style={{ resize: 'vertical' }}
          />
        </div>
      )}
      <BranchStepAttachmentsControl
        attachments={draft.attachments}
        uploading={draft.attachments_uploading}
        error={draft.attachments_error}
        onFiles={(files) => onAttachFiles(draft.id, files)}
        onRemove={(attachment) => onRemoveAttachment(draft.id, attachment)}
      />
      <div className="form-group" style={{ marginBottom: '0', marginTop: '10px' }}>
        <label>Wait Hours</label>
        <input
          type="number"
          min={0}
          step={1}
          value={draft.wait_hours}
          disabled={disabled}
          onChange={(e) => onChange(draft.id, 'wait_hours', e.target.value)}
        />
        <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '2px' }}>
          Delay before this branch's email is sent (0 = immediate).
        </div>
      </div>
    </div>
  )
}

interface BranchChange {
  id: number
  subject: string
  body: string
  wait_hours: number
  /** Templates table reference for this branch step (original HTML fetched at send time). */
  template_id: string | null
}

interface EditSequenceModalProps {
  row: Sequence
  branchSteps: SequenceBranchStep[]
  saving: boolean
  onSave: (payload: { name: string; changed: BranchChange[] }) => void
  onClose: () => void
}

function EditSequenceModal({ row, branchSteps, saving, onSave, onClose }: EditSequenceModalProps) {
  const [name, setName] = useState(row.name ?? '')
  const [drafts, setDrafts] = useState<BranchDraft[]>(() =>
    (branchSteps || []).map((b) => ({
      id: b.id,
      step: b.step,
      parent_step: b.parent_step,
      parent_branch: b.parent_branch,
      subject: b.subject ?? '',
      body: b.body ?? '',
      wait_hours: String(b.wait_hours ?? 0),
      template_id: b.template_id || '',
      template_html: '',
      manual_body: '',
      loading: false,
      error: null,
      attachments: [],
      attachments_uploading: false,
      attachments_error: null,
    }))
  )
  const [error, setError] = useState<string | null>(null)

  // All templates from `public.templates`, fetched when the Edit Sequence modal
  // opens so any new template added to the table appears in every step's
  // Load Template selector automatically.
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setTemplatesLoading(true)
      try {
        const { data } = await fetchTemplates()
        const loaded = data || []
        if (!cancelled) setTemplates(loaded)
        // Re-associate existing branch steps whose saved Body is a template's
        // HTML: set the template id (dropdown shows the name) and mark the HTML
        // as internal so the editor renders the template instead of showing
        // raw HTML in the Body textarea. Best-effort exact match.
        if (!cancelled && loaded.length > 0) {
          const normalized = (value: string) => String(value || '').trim()
          setDrafts((ds) =>
            ds.map((d) => {
              if (d.template_id || !d.body) return d
              const match = loaded.find((t) => normalized(t.body) === normalized(d.body))
              if (!match) return d
              return { ...d, template_id: match.id, template_html: d.body, manual_body: '' }
            })
          )
        }
      } finally {
        if (!cancelled) setTemplatesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load the saved attachments for every existing sequence_branch_steps row.
  // Each branch (OPENED / NOT_OPENED) has its OWN attachment list, keyed by the
  // branch step's database id — files are never shared between branches.
  useEffect(() => {
    let cancelled = false
    const ids = (branchSteps || []).map((b) => b.id)
    void Promise.all(
      ids.map(async (id) => {
        const { data, error: attErr } = await fetchBranchStepAttachments(id)
        if (cancelled) return
        setDrafts((ds) =>
          ds.map((d) =>
            d.id === id
              ? { ...d, attachments: data || [], attachments_error: attErr }
              : d,
          ),
        )
      }),
    )
    return () => {
      cancelled = true
    }
  }, [branchSteps])

  /** Upload one or more files to THIS branch step and append them to its list. */
  const handleAttachFiles = async (draftId: number, files: FileList | null) => {
    if (!files || files.length === 0) return
    setDrafts((ds) =>
      ds.map((d) => (d.id === draftId ? { ...d, attachments_uploading: true, attachments_error: null } : d)),
    )
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadBranchStepAttachment(file, draftId)
        setDrafts((ds) =>
          ds.map((d) => (d.id === draftId ? { ...d, attachments: [...d.attachments, uploaded] } : d)),
        )
      }
      setDrafts((ds) =>
        ds.map((d) => (d.id === draftId ? { ...d, attachments_uploading: false } : d)),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload attachment'
      setDrafts((ds) =>
        ds.map((d) =>
          d.id === draftId ? { ...d, attachments_uploading: false, attachments_error: message } : d,
        ),
      )
    }
  }

  /** Remove ONE file from THIS branch step: deletes Storage + its metadata row. */
  const handleRemoveAttachment = async (
    draftId: number,
    attachment: SequenceBranchStepAttachment,
  ) => {
    const { error } = await removeBranchStepAttachment(attachment)
    if (error) {
      setDrafts((ds) =>
        ds.map((d) => (d.id === draftId ? { ...d, attachments_error: error } : d)),
      )
      return
    }
    setDrafts((ds) =>
      ds.map((d) =>
        d.id === draftId
          ? { ...d, attachments: d.attachments.filter((a) => a.storage_path !== attachment.storage_path) }
          : d,
      ),
    )
  }

  const titles = useMemo(() => deriveStepTitles(branchSteps || []), [branchSteps])

  const levels = useMemo(() => {
    const map = new Map<number, BranchDraft[]>()
    for (const d of drafts) {
      const arr = map.get(d.step) ?? []
      arr.push(d)
      map.set(d.step, arr)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [drafts])

  const titleFor = (level: number): string =>
    titles.get(level)?.title ?? (level === 1 ? 'STEP 1 — STARTING' : `STEP ${level}`)

  const stepLabel = (level: number, isAlt: boolean): string => `${level}${isAlt ? 'A' : ''}`

  const setField = (id: number, key: 'subject' | 'body' | 'wait_hours', value: string) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, [key]: value } : d)))
  }

  /**
   * Load a selected template into ONLY the given branch step (draftId). The
   * Subject Line is never touched by template selection — it is always typed
   * manually by the user.
   *
   *  - template_source === 'database' → use the template's `body`.
   *  - template_source === 'storage'  → build the public URL from the row's
   *    storage_bucket / storage_path, fetch the HTML from Supabase Storage and
   *    use it as the body (HTML preserved, placeholders like {{first_name}} /
   *    {{company}} kept, never stripped to plain text, never replaced with
   *    `undefined` / `null` / an empty string).
   *
   * On failure the previous subject/body stay untouched and this branch shows a
   * clear error.
   */
  const loadTemplateIntoStep = useCallback(
    async (template: EmailTemplate, draftId: number) => {
      const patch = (p: Partial<BranchDraft>) =>
        setDrafts((ds) => ds.map((d) => (d.id === draftId ? { ...d, ...p } : d)))

      // The raw HTML stays INTERNAL (saved for sending) and is rendered as a
      // preview — it is never shown inside the editable Body textarea. The
      // plain-text body typed before the template was applied is kept aside so
      // deselecting the template restores it.
      const current = drafts.find((d) => d.id === draftId)
      patch({
        template_id: template.id,
        manual_body: current && !current.template_id ? current.body : current?.manual_body ?? '',
        loading: true,
        error: null,
      })

      try {
        let body: string
        if (template.template_source === 'storage') {
          if (!template.storage_bucket || !template.storage_path) {
            throw new Error(`Template '${template.name}' is missing a storage bucket or file path.`)
          }
          const { data } = supabase.storage
            .from(template.storage_bucket)
            .getPublicUrl(template.storage_path)
          if (!data?.publicUrl) {
            throw new Error('Could not resolve the template file URL.')
          }
          const response = await fetch(data.publicUrl)
          if (!response.ok) {
            throw new Error(`Failed to fetch template file (HTTP ${response.status}).`)
          }
          body = await response.text()
        } else {
          body = template.body || ''
        }
        if (!String(body).trim()) {
          throw new Error(`Template '${template.name}' has an empty body.`)
        }
        patch({ body, template_html: body, loading: false, error: null })
      } catch (err) {
        patch({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load template.',
        })
      }
    },
    [drafts]
  )

  /** Deselect the template for ONE branch step: restore the manual Body. */
  const clearTemplate = useCallback((draftId: number) => {
    setDrafts((ds) =>
      ds.map((d) =>
        d.id === draftId
          ? { ...d, template_id: '', template_html: '', body: d.manual_body, manual_body: '' }
          : d
      )
    )
  }, [])

  const handleSubmit = () => {
    if (!name.trim()) {
      setError('Sequence name is required.')
      return
    }
    for (const d of drafts) {
      const label = stepLabel(d.step, d.parent_branch === 'NOT_OPENED')
      if (!d.subject.trim() || !d.body.trim()) {
        setError(`Subject and Body are required for Step ${label}.`)
        return
      }
      const wait = Number(d.wait_hours)
      if (!Number.isFinite(wait) || wait < 0 || !Number.isInteger(wait)) {
        setError(`Wait Hours for Step ${label} must be a whole number >= 0.`)
        return
      }
    }
    setError(null)
    const changed: BranchChange[] = drafts
      .filter((d) => {
        const orig = (branchSteps || []).find((b) => b.id === d.id)
        return (
          !orig ||
          (orig.subject ?? '') !== d.subject.trim() ||
          (orig.body ?? '') !== d.body.trim() ||
          Number(orig.wait_hours ?? 0) !== Number(d.wait_hours)
        )
      })
      .map((d) => ({
        id: d.id,
        subject: d.subject.trim(),
        body: d.body.trim(),
        wait_hours: Number(d.wait_hours),
        template_id: d.template_id || null,
      }))
    onSave({ name: name.trim(), changed })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: '900px', maxWidth: '96vw' }}>
        <div className="modal-header">
          <div className="modal-title">Edit Sequence — {display(row.name)}</div>
          <button className="btn-icon" onClick={onClose} disabled={saving}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label>Sequence Name</label>
            <input
              type="text"
              value={name}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sequence name"
            />
          </div>

          {levels.map(([level, list]) => {
            const primary = list.find((d) => d.parent_branch !== 'NOT_OPENED')
            const alt = list.find((d) => d.parent_branch === 'NOT_OPENED')
            return (
              <div
                key={level}
                style={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  padding: '12px',
                  marginBottom: '12px',
                }}
              >
                <div
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text4)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.6px',
                    marginBottom: '8px',
                  }}
                >
                  {titleFor(level)}
                </div>

                {primary && (
                  <div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text3)',
                        marginBottom: '2px',
                      }}
                    >
                      {level === 1 ? 'Step Content' : '→ Opened'}
                    </div>
                    <BranchFields
                      draft={primary}
                      disabled={saving}
                      subjectLabel={`Subject ${primary.step}`}
                      bodyLabel={`Body ${primary.step}`}
                      templates={templates}
                      templatesLoading={templatesLoading}
                      onLoadTemplate={(templateId) => {
                        const t = templates.find((x) => x.id === templateId)
                        if (t) void loadTemplateIntoStep(t, primary.id)
                      }}
                      onClearTemplate={clearTemplate}
                      onChange={setField}
                      onAttachFiles={handleAttachFiles}
                      onRemoveAttachment={handleRemoveAttachment}
                    />
                  </div>
                )}

                {alt && (
                  <div>
                    <div
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text3)',
                        marginTop: '4px',
                      }}
                    >
                      → Not Opened
                    </div>
                    {titles.get(level)?.altTitle && (
                      <div
                        style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: 'var(--text4)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.4px',
                          marginBottom: '2px',
                        }}
                      >
                        {titles.get(level)?.altTitle}
                      </div>
                    )}
                    <BranchFields
                      draft={alt}
                      disabled={saving}
                      subjectLabel={`Subject ${alt.step}A`}
                      bodyLabel={`Body ${alt.step}A`}
                      templates={templates}
                      templatesLoading={templatesLoading}
                      onLoadTemplate={(templateId) => {
                        const t = templates.find((x) => x.id === templateId)
                        if (t) void loadTemplateIntoStep(t, alt.id)
                      }}
                      onClearTemplate={clearTemplate}
                      onChange={setField}
                      onAttachFiles={handleAttachFiles}
                      onRemoveAttachment={handleRemoveAttachment}
                    />
                  </div>
                )}
              </div>
            )
          })}

          <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '2px' }}>
            Each card is this sequence's real branch-step tree (sequence_branch_steps), the single
            source of truth shared by the Sequence page and the email worker. Step 2 / 2A are Step
            1's branches, Step 3 / 3A are Step 2's branches, Step 4 / 4A are Step 2A's branches,
            and so on. Saving writes the subject, body and wait straight back to those records (and
            their sequence_steps nodes), so the emails the worker sends update immediately.
          </div>

          {error && (
            <div style={{ marginTop: '12px' }}>
              <span className="tag tag-draft" style={{ background: 'var(--red)', color: '#fff' }}>
                {error}
              </span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface PreviewModalProps {
  row: Sequence
  pair: CardPair
  kind: 'subject' | 'body'
  cell: SequenceBranchStep | undefined
  onClose: () => void
}

/** Read-only modal that shows the complete stored subject / body for one step. */
function PreviewModal({ row, pair, kind, cell, onClose }: PreviewModalProps) {
  const avatar = avatarColorFor(display(row.name))
  const subject = display(cell?.subject)
  const body = bodyFullText(cell?.body)
  const label = `${kind === 'subject' ? 'Subject' : 'Body'} ${pair.level}${pair.isAlt ? 'A' : ''}`

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal seqb-preview-modal"
        style={{ width: '640px', maxWidth: '96vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            <span className={`seqb-chip ${pair.isAlt ? 'seqb-chip-alt' : ''}`}>
              {stepChipLabel(pair)}
            </span>
            <span style={{ marginLeft: '10px' }}>{label}</span>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="seqb-preview-row">
            <span
              className="seqb-avatar"
              style={{ background: avatar.bg, color: avatar.color }}
            >
              {initialsOf(display(row.name))}
            </span>
            <div className="seqb-seq-info">
              <div className="seqb-seq-name" title={display(row.name)}>
                {display(row.name)}
              </div>
              <div className="seqb-seq-meta">
                <span
                  className="seqb-seq-dot"
                  style={{ background: statusTone(row.status) }}
                />
                <span>{statusText(row.status)}</span>
                <span className="seqb-seq-sep">·</span>
                <span>{recipientText(row.recipient_type)}</span>
              </div>
            </div>
          </div>

          <div className="seqb-preview-block">
            <div className="seqb-preview-block-title">Subject</div>
            <div className="seqb-preview-subject">{subject}</div>
          </div>

          <div className="seqb-preview-block">
            <div className="seqb-preview-block-title">Body</div>
            {body.length > 0 ? (
              <div className="seqb-preview-body">{body}</div>
            ) : (
              <div className="seqb-preview-empty">No body content</div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SequenceBuilderTab({ onNavigate, onToast }: SequenceBuilderTabProps) {
  const [rows, setRows] = useState<Sequence[]>([])
  const [branchMap, setBranchMap] = useState<Record<string, SequenceBranchStep[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const [editingRow, setEditingRow] = useState<Sequence | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Preview modal state (visual only — full content is shown from stored data).
  const [preview, setPreview] = useState<{
    row: Sequence
    pair: CardPair
    kind: 'subject' | 'body'
  } | null>(null)

  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')

  const reload = () => {
    setLoading(true)
    setReloadToken((t) => t + 1)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const seqs = await fetchSequences()
        if (cancelled) return
        const entries: Array<[string, SequenceBranchStep[]]> = await Promise.all(
          (seqs || []).map(async (s) => {
            try {
              return [s.id, (await fetchBranchSteps(s.id)) || []] as [string, SequenceBranchStep[]]
            } catch {
              return [s.id, []] as [string, SequenceBranchStep[]]
            }
          })
        )
        if (cancelled) return
        const map: Record<string, SequenceBranchStep[]> = {}
        for (const [id, steps] of entries) map[id] = steps
        setRows(seqs || [])
        setBranchMap(map)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load sequences')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const columnPairs = useMemo<CardPair[]>(() => {
    const levels = new Set<number>()
    for (const seq of rows) {
      for (const s of branchMap[seq.id] || []) levels.add(s.step)
    }
    const pairs: CardPair[] = []
    const seen = new Set<string>()
    for (const level of [...levels].sort((a, b) => a - b)) {
      let hasPrimary = false
      let hasAlt = false
      for (const seq of rows) {
        const list = branchMap[seq.id] || []
        if (list.some((s) => s.step === level && s.parent_branch !== 'NOT_OPENED')) hasPrimary = true
        if (list.some((s) => s.step === level && s.parent_branch === 'NOT_OPENED')) hasAlt = true
      }
      if (hasPrimary && !seen.has(`${level}`)) {
        seen.add(`${level}`)
        pairs.push({ label: `${level}`, level, isAlt: false })
      }
      if (hasAlt && !seen.has(`${level}A`)) {
        seen.add(`${level}A`)
        pairs.push({ label: `${level}A`, level, isAlt: true })
      }
    }
    return pairs
  }, [rows, branchMap])

  // Fixed column widths so every step column is the same size and a long body
  // never expands the table. The table scrolls horizontally past this width.
  const columnMinWidth = useMemo(() => {
    const nameCol = 250
    const actionsCol = 128
    const stepCol = 220 // one Subject or Body column
    return nameCol + actionsCol + columnPairs.length * 2 * stepCol
  }, [columnPairs])

  const filteredRows = useMemo<Sequence[]>(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (filterStatus !== 'all' && row.status !== filterStatus) return false
      if (!q) return true
      const haystack = [
        row.name,
        ...(branchMap[row.id] || []).flatMap((s) => [s.subject, bodyPreview(s.body)]),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [rows, branchMap, search, filterStatus])

  const handleSave = async (payload: { name: string; changed: BranchChange[] }) => {
    if (!editingRow || saving) return
    setSaving(true)
    try {
      if (payload.name !== (editingRow.name ?? '')) {
        await updateSequence(editingRow.id, { name: payload.name })
      }
      for (const c of payload.changed) {
        await updateBranchStep(editingRow.id, c.id, {
          subject: c.subject,
          body: c.body,
          wait_hours: c.wait_hours,
          template_id: c.template_id,
        })
      }
      onToast('Sequence updated', 'success')
      setEditingRow(null)
      reload()
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update sequence', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row: Sequence) => {
    if (deletingId !== null) return
    if (!window.confirm(`Delete sequence "${row.name}"? Its steps and branch content will also be deleted.`)) return
    setDeletingId(row.id)
    try {
      await deleteSequence(row.id)
      onToast('Sequence deleted', 'info')
      reload()
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to delete sequence', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="seqb">
      <div className="seq-header">
        <button className="btn btn-primary btn-new-seq" onClick={() => onNavigate('sequences')}>
          + New Sequence
        </button>
      </div>

      <div className="seqb-card">
        <div className="seqb-card-head">
          <div style={{ minWidth: '0' }}>
            <div className="seqb-card-title">Sequence Content</div>
            <div className="seqb-card-sub">
              Each sequence's branch steps as columns — scroll horizontally for all steps.
            </div>
          </div>
          <div className="seqb-controls">
            <div className="seqb-search">
              <span className="seqb-search-ic">
                <SvgIcon size={15}>{IconSearch}</SvgIcon>
              </span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sequences..."
              />
            </div>
            <div className="seqb-filter-wrap">
              <span className="seqb-filter-ic">
                <SvgIcon size={14}>{IconFilter}</SvgIcon>
              </span>
              <select
                className="seqb-filter"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="seqb-state">
            <span className="seqb-state-ic seqb-spin">
              <SvgIcon size={22}>{IconRefresh}</SvgIcon>
            </span>
            <div className="seqb-state-title">Loading sequences…</div>
          </div>
        ) : error ? (
          <div className="seqb-state">
            <span className="seqb-state-ic seqb-state-ic-red">
              <SvgIcon size={22}>{IconDoc}</SvgIcon>
            </span>
            <div className="seqb-state-title">Could not load sequences</div>
            <div className="seqb-state-sub">{error}</div>
            <button className="btn btn-secondary btn-sm" style={{ marginTop: '12px' }} onClick={reload}>
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="seqb-state">
            <span className="seqb-state-ic seqb-state-ic-blue">
              <SvgIcon size={22}>{IconLayers}</SvgIcon>
            </span>
            <div className="seqb-state-title">No sequences found.</div>
            <div className="seqb-state-sub">Create a sequence from the Sequences page to get started.</div>
            <div>
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: '14px' }}
                onClick={() => onNavigate('sequences')}
              >
                + New Sequence
              </button>
            </div>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="seqb-state">
            <span className="seqb-state-ic">
              <SvgIcon size={22}>{IconSearch}</SvgIcon>
            </span>
            <div className="seqb-state-title">No sequences match your filters</div>
            <div className="seqb-state-sub">Try adjusting the search or the status filter.</div>
          </div>
        ) : (
          <>
            <div className="seqb-table-wrap">
              <table className="seqb-table" style={{ minWidth: `${columnMinWidth}px` }}>
                <colgroup>
                  <col className="seqb-col-name" />
                  {columnPairs.map((pair) => [
                    <col key={`s${pair.label}`} className="seqb-col-sub" />,
                    <col key={`b${pair.label}`} className="seqb-col-body" />,
                  ])}
                  <col className="seqb-col-actions" />
                </colgroup>
                <thead>
                  <tr className="seqb-head-groups">
                    <th rowSpan={2} scope="col" className="seqb-col-pin seqb-name-th">
                      Sequence Name
                    </th>
                    {columnPairs.map((pair) => (
                      <th key={`g${pair.label}`} colSpan={2} scope="colgroup" className="seqb-step-th">
                        <span className={`seqb-chip ${pair.isAlt ? 'seqb-chip-alt' : ''}`}>
                          {stepChipLabel(pair)}
                        </span>
                      </th>
                    ))}
                    <th rowSpan={2} scope="col" className="seqb-actions-th">
                      Actions
                    </th>
                  </tr>
                  <tr className="seqb-head-cols">
                    {columnPairs.map((pair) => [
                      <th key={`s${pair.label}`} scope="col" className="seqb-sub-th">
                        Subject {pair.level}
                        {pair.isAlt ? 'A' : ''}
                      </th>,
                      <th key={`b${pair.label}`} scope="col" className="seqb-sub-th">
                        Body {pair.level}
                        {pair.isAlt ? 'A' : ''}
                      </th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => {
                    const avatar = avatarColorFor(display(row.name))
                    return (
                      <tr key={row.id}>
                        <td className="seqb-col-pin">
                          <div className="seqb-seq">
                            <span
                              className="seqb-avatar"
                              style={{ background: avatar.bg, color: avatar.color }}
                            >
                              {initialsOf(display(row.name))}
                            </span>
                            <div className="seqb-seq-info">
                              <div className="seqb-seq-name" title={display(row.name)}>
                                {display(row.name)}
                              </div>
                              <div className="seqb-seq-meta">
                                <span
                                  className="seqb-seq-dot"
                                  style={{ background: statusTone(row.status) }}
                                />
                                <span>{statusText(row.status)}</span>
                                <span className="seqb-seq-sep">·</span>
                                <span>{recipientText(row.recipient_type)}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        {columnPairs.map((pair) => {
                          const cell = branchRowFor(branchMap[row.id], pair.level, pair.isAlt)
                          return [
                            <td key={`s${pair.label}`} className="seqb-cell-td">
                              <div className="seqb-cell">
                                <span className="seqb-cell-ic seqb-cell-mail">
                                  <SvgIcon size={13}>{IconMail}</SvgIcon>
                                </span>
                                <ClampedText
                                  text={display(cell?.subject)}
                                  lines={1}
                                  onSeeMore={() =>
                                    setPreview({ row, pair, kind: 'subject' })
                                  }
                                />
                              </div>
                            </td>,
                            <td key={`b${pair.label}`} className="seqb-cell-td">
                              <div className="seqb-cell">
                                <span className="seqb-cell-ic seqb-cell-doc">
                                  <SvgIcon size={13}>{IconDoc}</SvgIcon>
                                </span>
                                <ClampedText
                                  text={bodyPreview(cell?.body)}
                                  lines={2}
                                  onSeeMore={() => setPreview({ row, pair, kind: 'body' })}
                                />
                              </div>
                            </td>,
                          ]
                        })}
                        <td className="seqb-actions">
                          <div className="seqb-action-row">
                            <button
                              type="button"
                              className="seqb-ibtn seqb-ibtn-edit"
                              title="Edit sequence"
                              onClick={() => setEditingRow(row)}
                            >
                              <SvgIcon size={15}>{IconPencil}</SvgIcon>
                            </button>
                            <button
                              type="button"
                              className="seqb-ibtn seqb-ibtn-danger"
                              title="Delete sequence"
                              onClick={() => void handleDelete(row)}
                              disabled={deletingId !== null}
                            >
                              <SvgIcon size={15}>{IconTrash}</SvgIcon>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="seqb-foot">
              <span>
                {filteredRows.length > 0
                  ? `Showing 1 to ${filteredRows.length} of ${rows.length} sequences`
                  : `Showing 0 of ${rows.length} sequences`}
              </span>
            </div>
          </>
        )}
      </div>

      {editingRow && (
        <EditSequenceModal
          row={editingRow}
          branchSteps={branchMap[editingRow.id] || []}
          saving={saving}
          onSave={(payload) => void handleSave(payload)}
          onClose={() => {
            if (saving) return
            setEditingRow(null)
          }}
        />
      )}

      {preview && (
        <PreviewModal
          row={preview.row}
          pair={preview.pair}
          kind={preview.kind}
          cell={branchRowFor(branchMap[preview.row.id], preview.pair.level, preview.pair.isAlt)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}