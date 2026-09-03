import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../supabase'

type ActivityTab = 'all' | 'opened' | 'not_opened' | 'clicked'

const ACTIVITY_TABS: { key: ActivityTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'opened', label: 'Opened' },
  { key: 'not_opened', label: 'Not Opened' },
  { key: 'clicked', label: 'Clicked' },
]

const PAGE_SIZE = 10

interface RecipientRow {
  contact_id: string
  name: string
  email: string
  status: string
  opened_at: string | null
  clicked_at: string | null
}

interface ActivityModalProps {
  isOpen: boolean
  campaignId: string
  campaignName: string
  onClose: () => void
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function deriveStatus(row: Record<string, any>): string {
  if (row.clicked) return 'Clicked'
  if (row.opened) return 'Opened'
  if (row.status === 'failed') return 'Failed'
  if (row.status === 'sent') return 'Delivered'
  return row.status || 'Pending'
}

export default function ActivityModal({
  isOpen,
  campaignId,
  campaignName,
  onClose,
}: ActivityModalProps) {
  const [activeTab, setActiveTab] = useState<ActivityTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [recipients, setRecipients] = useState<RecipientRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRecipients = useCallback(async (cid: string) => {
    setLoading(true)
    setError(null)
    try {
      const { data: logs, error: logError } = await supabase
        .from('email_logs')
        .select('id, campaign_id, contact_id, email, status, opened, opened_at, clicked, clicked_at, sent_at')
        .eq('campaign_id', cid)
        .order('sent_at', { ascending: false })

      if (logError) throw new Error(logError.message)

      const rows = (logs as Record<string, any>[]) || []

      // Resolve contact names
      const contactIds = [...new Set(rows.map((r) => String(r.contact_id)).filter(Boolean))]
      const contactMap = new Map<string, Record<string, any>>()
      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from('contacts')
          .select('id, full_name, email')
          .in('id', contactIds)
        for (const c of (contacts as Record<string, any>[]) || []) {
          contactMap.set(String(c.id), c)
        }
      }

      const mapped: RecipientRow[] = rows.map((row) => {
        const contact = contactMap.get(String(row.contact_id)) || {}
        return {
          contact_id: String(row.contact_id),
          name: contact.full_name || '',
          email: row.email || contact.email || '',
          status: deriveStatus(row),
          opened_at: row.opened_at || null,
          clicked_at: row.clicked_at || null,
        }
      })

      setRecipients(mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recipients')
      setRecipients([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Load data when modal opens or campaignId changes
  useEffect(() => {
    if (isOpen && campaignId) {
      setActiveTab('all')
      setSearchQuery('')
      setCurrentPage(1)
      void loadRecipients(campaignId)
    }
  }, [isOpen, campaignId, loadRecipients])

  const filteredRecipients = useMemo(() => {
    let list = recipients

    // Tab filter
    if (activeTab === 'opened') {
      list = list.filter((r) => r.status === 'Opened' || r.status === 'Clicked')
    } else if (activeTab === 'not_opened') {
      list = list.filter((r) => r.status !== 'Opened' && r.status !== 'Clicked')
    } else if (activeTab === 'clicked') {
      list = list.filter((r) => r.status === 'Clicked')
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (r) =>
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.email && r.email.toLowerCase().includes(q)),
      )
    }

    return list
  }, [recipients, activeTab, searchQuery])

  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedRecipients = filteredRecipients.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  )

  const handleTabChange = (tab: ActivityTab) => {
    setActiveTab(tab)
    setCurrentPage(1)
  }

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    setCurrentPage(1)
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: '860px', maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">Recipient Activity</div>
            <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
              Campaign: <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{campaignName}</span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="modal-body" style={{ padding: 0 }}>
          {/* Tabs */}
          <div className="tabs" style={{ margin: 0, padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
            {ACTIVITY_TABS.map((t) => (
              <div
                key={t.key}
                className={`tab ${activeTab === t.key ? 'active' : ''}`}
                onClick={() => handleTabChange(t.key)}
              >
                {t.label}
              </div>
            ))}
          </div>

          {/* Search */}
          <div style={{ padding: '14px 20px 0' }}>
            <div className="input-icon-wrap">
              <span className="inp-icon">🔍</span>
              <input
                type="text"
                placeholder="Search recipients..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
          </div>

          {/* Table */}
          <div style={{ padding: '14px 20px 0' }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Opened At</th>
                    <th>Clicked At</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">
                          <div className="empty-icon">⟳</div>
                          <div className="empty-title">Loading recipients…</div>
                        </div>
                      </td>
                    </tr>
                  ) : error ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">
                          <div className="empty-icon">⚠</div>
                          <div className="empty-title">Could not load recipients</div>
                          <div className="empty-sub">{error}</div>
                        </div>
                      </td>
                    </tr>
                  ) : paginatedRecipients.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">
                          <div className="empty-icon">📭</div>
                          <div className="empty-title">No recipients found</div>
                          <div className="empty-sub">
                            {recipients.length === 0
                              ? 'This campaign has no email log records yet.'
                              : 'No recipients match your current filter.'}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginatedRecipients.map((r) => (
                      <tr key={r.contact_id}>
                        <td style={{ fontWeight: 600, fontSize: '13px' }}>{r.name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--text3)' }}>{r.email || '—'}</td>
                        <td>
                          <span
                            className={`tag ${
                              r.status === 'Opened' || r.status === 'Clicked'
                                ? 'tag-client'
                                : r.status === 'Failed'
                                  ? 'tag-draft'
                                  : 'tag-oem'
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)' }}>{formatTimestamp(r.opened_at)}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)' }}>{formatTimestamp(r.clicked_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {!loading && !error && filteredRecipients.length > 0 && (
            <div style={{ padding: '12px 20px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '12px', color: 'var(--text4)' }}>
                {filteredRecipients.length === 0
                  ? 'No results'
                  : `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filteredRecipients.length)} of ${filteredRecipients.length}`}
              </div>
              <div className="pagination" style={{ margin: 0 }}>
                <button
                  className="pg-btn"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                >
                  ‹
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
                  .reduce<(number | string)[]>((acc, p, i, arr) => {
                    if (i > 0 && typeof arr[i - 1] === 'number' && p - (arr[i - 1] as number) > 1) {
                      acc.push('...')
                    }
                    acc.push(p)
                    return acc
                  }, [])
                  .map((p, i) =>
                    typeof p === 'string' ? (
                      <span key={`ellipsis-${i}`} className="pg-btn" style={{ cursor: 'default', border: 'none' }}>
                        …
                      </span>
                    ) : (
                      <button
                        key={p}
                        className={`pg-btn ${p === safePage ? 'active' : ''}`}
                        onClick={() => setCurrentPage(p)}
                      >
                        {p}
                      </button>
                    ),
                  )}
                <button
                  className="pg-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                >
                  ›
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
