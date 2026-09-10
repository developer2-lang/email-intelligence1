import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EmailTemplate } from '../types/campaign'
import type { TabKey } from '../types'
import {
  deleteEmailTemplate,
  fetchTemplates,
} from '../services/campaignService'
import { resolveTemplateHtml } from '../services/templateResolve'
import { toEmailSafeHtml } from '../utils/emailRender'
import { TemplateThumb } from '../components/TemplateThumb'
import { MOBILE_RESPONSIVE_CSS } from '../components/TemplateVisualEditor'
import { openNewTemplateInEditor, openTemplateInEditor } from '../services/templateBridge'

interface TemplatesPageProps {
  onNavigate: (tab: TabKey) => void
  onToast: (msg: string, type?: string) => void
}

function formatUpdatedDate(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const toolButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 14px',
  borderRadius: '9px',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const primaryButton: React.CSSProperties = {
  ...toolButton,
  color: '#FFFFFF',
  background: '#2563EB',
  borderColor: '#2563EB',
}

export default function TemplatesPage({ onNavigate, onToast }: TemplatesPageProps) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')

  const [thumbnailHtml, setThumbnailHtml] = useState<Record<string, string>>({})
  const thumbnailResolvedRef = useRef<Set<string>>(new Set())

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop')

  const displayPreviewHtml = useMemo(() => {
    if (previewDevice !== 'mobile' || !previewHtml) return previewHtml
    const mobileStyle = `<style>${MOBILE_RESPONSIVE_CSS}</style>`
    if (/<head[\s>]/i.test(previewHtml)) {
      return previewHtml.replace(/<\/head>/i, `${mobileStyle}</head>`)
    }
    if (/<body[\s>]/i.test(previewHtml)) {
      return previewHtml.replace(/<body([\s>])/i, `${mobileStyle}<body$1`)
    }
    return `${mobileStyle}${previewHtml}`
  }, [previewHtml, previewDevice])

  const [deleteTarget, setDeleteTarget] = useState<EmailTemplate | null>(null)
  const [deleting, setDeleting] = useState(false)

  // ─── Load all templates from Supabase (no limit — every saved row) ───
  const loadTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: fetchError } = await fetchTemplates()
    if (fetchError) {
      setError(fetchError)
      setTemplates([])
    } else {
      setTemplates(data)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTemplates()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadTemplates])

  // Resolve each saved template's REAL HTML for its preview thumbnail.
  useEffect(() => {
    if (loading) return
    let cancelled = false
    for (const t of templates) {
      if (thumbnailResolvedRef.current.has(t.id)) continue
      thumbnailResolvedRef.current.add(t.id)
      resolveTemplateHtml(t)
        .then((html) => {
          if (cancelled) return
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: toEmailSafeHtml(html) }))
        })
        .catch(() => {
          if (cancelled) return
          setThumbnailHtml((prev) => ({ ...prev, [t.id]: '' }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [templates, loading])

  // Newest-updated first (real ordering, not a hardcoded count).
  const sorted = [...templates].sort((a, b) => {
    const da = new Date(a.updated_at || a.created_at || 0).getTime()
    const db = new Date(b.updated_at || b.created_at || 0).getTime()
    return db - da
  })

  const filtered = search.trim()
    ? sorted.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()))
    : sorted

  // ─── Actions ───
  const handleEdit = (t: EmailTemplate) => {
    openTemplateInEditor(t)
    onNavigate('template-editor')
  }

  const handlePreview = async (t: EmailTemplate) => {
    try {
      const html = await resolveTemplateHtml(t)
      setPreviewHtml(toEmailSafeHtml(html))
      setPreviewDevice('desktop')
      setPreviewOpen(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to preview template.'
      onToast(msg, 'error')
    }
  }

  const handleNew = () => {
    openNewTemplateInEditor()
    onNavigate('template-editor')
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const result = await deleteEmailTemplate(deleteTarget)
      if (!result.ok) {
        if (result.inUse) {
          onToast(
            `Template '${deleteTarget.name}' is used by a campaign and cannot be deleted.`,
            'error'
          )
        } else {
          onToast(result.error || 'Failed to delete template.', 'error')
        }
        setDeleteTarget(null)
        return
      }
      thumbnailResolvedRef.current.delete(deleteTarget.id)
      setThumbnailHtml((prev) => {
        const next = { ...prev }
        delete next[deleteTarget.id]
        return next
      })
      await loadTemplates()
      onToast(`Template '${deleteTarget.name}' deleted successfully.`, 'success')
      setDeleteTarget(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete template.'
      onToast(msg, 'error')
    } finally {
      setDeleting(false)
    }
  }

  const gridCard: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #E5E7EB',
    borderRadius: '14px',
    background: '#FFFFFF',
    overflow: 'hidden',
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
  }

  return (
    <div className="page active" style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* ─── Header ─── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          flexWrap: 'wrap',
          marginBottom: '18px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              style={{ ...toolButton, padding: '6px 12px' }}
              onClick={() => onNavigate('template-editor')}
            >
              ← Back to Template Editor
            </button>
          </div>
          <div style={{ fontSize: '22px', fontWeight: 700, marginTop: '12px' }}>Templates</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text4)', marginTop: '2px' }}>
            Manage all your saved email templates
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: '12px',
                color: '#94A3B8',
                pointerEvents: 'none',
              }}
            >
              🔍
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              style={{
                padding: '8px 12px 8px 30px',
                borderRadius: '9px',
                border: '1px solid #E2E8F0',
                background: '#FFFFFF',
                fontSize: '12.5px',
                color: '#334155',
                width: '230px',
                outline: 'none',
              }}
            />
          </div>
          <button
            type="button"
            style={{ ...toolButton }}
            onClick={() => void loadTemplates()}
            disabled={loading}
            title="Refresh the templates list"
          >
            ↻ Refresh
          </button>
          <button type="button" style={primaryButton} onClick={handleNew}>
            + New Template
          </button>
        </div>
      </div>

      {/* ─── Error state ─── */}
      {error ? (
        <div
          style={{
            padding: '40px 16px',
            borderRadius: '12px',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            color: '#B91C1C',
            fontSize: '13px',
            textAlign: 'center',
          }}
        >
          Unable to load templates.
          <div style={{ marginTop: '12px' }}>
            <button type="button" className="btn btn-primary" onClick={() => void loadTemplates()}>
              Retry
            </button>
          </div>
        </div>
      ) : loading ? (
        /* ─── Loading skeleton ─── */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '16px',
          }}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={gridCard}>
              <div className="seqb-skeleton" style={{ height: 170, borderRadius: 0 }} />
              <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div className="seqb-skeleton" style={{ width: '60%', height: '14px', borderRadius: '6px' }} />
                <div className="seqb-skeleton" style={{ width: '40%', height: '12px', borderRadius: '6px' }} />
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <div className="seqb-skeleton" style={{ width: '56px', height: '28px', borderRadius: '8px' }} />
                  <div className="seqb-skeleton" style={{ width: '64px', height: '28px', borderRadius: '8px' }} />
                  <div className="seqb-skeleton" style={{ width: '56px', height: '28px', borderRadius: '8px' }} />
                </div>
              </div>
            </div>
          ))}
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', fontSize: '12.5px', color: '#64748B' }}>
            Loading templates…
          </div>
        </div>
      ) : filtered.length === 0 ? (
        /* ─── Empty state ─── */
        <div
          style={{
            padding: '60px 16px',
            borderRadius: '12px',
            background: '#F8FAFC',
            border: '1px dashed #CBD5E1',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '17px', fontWeight: 700, color: '#334155' }}>
            {search.trim() ? 'No templates match your search' : 'No templates yet'}
          </div>
          <div style={{ fontSize: '12.5px', color: '#64748B', marginTop: '6px' }}>
            {search.trim()
              ? 'Try a different name.'
              : 'Create your first email template.'}
          </div>
          {!search.trim() && (
            <div style={{ marginTop: '16px' }}>
              <button type="button" className="btn btn-primary" onClick={handleNew}>
                Create Template
              </button>
            </div>
          )}
        </div>
      ) : (
        /* ─── Grid of template cards ─── */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '16px',
          }}
        >
          {filtered.map((t) => {
            const thumb = thumbnailHtml[t.id]
            return (
              <div key={t.id} style={gridCard}>
                {/* Preview — real template HTML */}
                <div style={{ padding: '12px', background: '#F8FAFC', borderBottom: '1px solid #EEF2F7' }}>
                  {thumb === undefined ? (
                    <div
                      style={{
                        height: 170,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid #E2E8F0',
                        borderRadius: '8px',
                        background: '#FFFFFF',
                        color: '#94A3B8',
                        fontSize: '11px',
                      }}
                    >
                      Loading preview…
                    </div>
                  ) : thumb ? (
                    <TemplateThumb html={thumb} height={170} />
                  ) : (
                    <div
                      style={{
                        height: 170,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid #E2E8F0',
                        borderRadius: '8px',
                        background: '#FFFFFF',
                        color: '#94A3B8',
                        fontSize: '11px',
                        textAlign: 'center',
                        padding: '8px',
                      }}
                    >
                      No preview available
                    </div>
                  )}
                </div>

                {/* Name + date */}
                <div style={{ padding: '14px', flex: 1 }}>
                  <div
                    style={{
                      fontSize: '14.5px',
                      fontWeight: 700,
                      color: '#0F172A',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={t.name}
                  >
                    {t.name || 'Untitled Template'}
                  </div>
                  <div style={{ fontSize: '11.5px', color: '#64748B', marginTop: '4px' }}>
                    {t.updated_at || t.created_at
                      ? `Updated ${formatUpdatedDate(t.updated_at || t.created_at)}`
                      : 'Not yet saved'}
                  </div>
                  {t.category ? (
                    <div style={{ marginTop: '8px' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: '999px',
                          background: '#F1F5F9',
                          border: '1px solid #E2E8F0',
                          fontSize: '10.5px',
                          fontWeight: 600,
                          color: '#475569',
                          textTransform: 'capitalize',
                        }}
                      >
                        {t.category}
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* Actions */}
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    padding: '0 14px 14px',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    style={{
                      ...toolButton,
                      padding: '6px 12px',
                      color: '#1D4ED8',
                      borderColor: '#BFDBFE',
                      background: '#EFF6FF',
                    }}
                    onClick={() => handleEdit(t)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    style={{ ...toolButton, padding: '6px 12px' }}
                    onClick={() => void handlePreview(t)}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    style={{
                      ...toolButton,
                      padding: '6px 12px',
                      color: '#B91C1C',
                      borderColor: '#FECACA',
                      background: '#FEF2F2',
                    }}
                    onClick={() => setDeleteTarget(t)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── Preview modal (reuses the email render pipeline) ─── */}
      {previewOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: previewDevice === 'mobile' ? '520px' : '780px' }}>
            <div className="modal-header">
              <div className="modal-title">Email Preview</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button
                  type="button"
                  style={toolButton}
                  onClick={() => setPreviewDevice('desktop')}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  style={toolButton}
                  onClick={() => setPreviewDevice('mobile')}
                >
                  Mobile
                </button>
                <span style={{ width: 1, height: 20, background: '#E2E8F0', margin: '0 6px' }} />
                <button className="btn-icon" onClick={() => setPreviewOpen(false)}>
                  ✕
                </button>
              </div>
            </div>
            <div
              className="modal-body"
              style={{
                background: '#E2E8F0',
                display: 'flex',
                justifyContent: 'center',
                padding: previewDevice === 'mobile' ? '18px' : '26px',
              }}
            >
              <iframe
                title="email preview"
                sandbox=""
                srcDoc={displayPreviewHtml}
                style={{
                  width: previewDevice === 'mobile' ? '375px' : '640px',
                  height: '660px',
                  border: 'none',
                  background: '#FFFFFF',
                  borderRadius: previewDevice === 'mobile' ? '20px' : '6px',
                  boxShadow: '0 8px 24px rgba(15,23,42,0.2)',
                }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPreviewOpen(false)}>
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete confirmation modal ─── */}
      {deleteTarget && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '420px' }}>
            <div className="modal-header">
              <div className="modal-title">Delete Template?</div>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: '13px', color: '#475569', lineHeight: 1.6 }}>
                Are you sure you want to permanently delete{' '}
                <strong>{deleteTarget.name}</strong>? This action cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
