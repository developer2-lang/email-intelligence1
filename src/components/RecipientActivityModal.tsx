import { useState, useMemo } from 'react'

export type ActivityTab = 'all' | 'opened' | 'not_opened' | 'clicked'

const ACTIVITY_TABS: { key: ActivityTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'opened', label: 'Opened' },
  { key: 'not_opened', label: 'Not Opened' },
  { key: 'clicked', label: 'Clicked' },
]

const PAGE_SIZE = 15

export interface RecipientRow {
  id: string
  name: string
  email: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'
  queued_at: string | null
  sent_at: string | null
  opened_at: string | null
  clicked_at: string | null
}

interface RecipientActivityModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle: string
  initialTab?: ActivityTab
  rows: RecipientRow[]
}

type PillStatus = 'Sent' | 'Opened' | 'Clicked' | 'Failed' | 'Pending' | 'Sending' | 'Skipped'

const PILL_META: Record<PillStatus, { bg: string; color: string }> = {
  Sent: { bg: '#D1FAE5', color: '#065F46' },
  Opened: { bg: '#A7F3D0', color: '#065F46' },
  Clicked: { bg: '#DBEAFE', color: '#1D4ED8' },
  Failed: { bg: '#FEE2E2', color: '#991B1B' },
  Pending: { bg: '#FEF3C7', color: '#92400E' },
  Sending: { bg: '#DBEAFE', color: '#1D4ED8' },
  Skipped: { bg: '#F1F5F9', color: '#475569' },
}

const Pill = ({ status }: { status: PillStatus }) => {
  const meta = PILL_META[status]
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 999,
        background: meta.bg,
        color: meta.color,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  )
}

function deriveStatus(row: RecipientRow): PillStatus {
  if (row.clicked_at) return 'Clicked'
  if (row.opened_at) return 'Opened'
  if (row.status === 'sent') return 'Sent'
  if (row.status === 'failed') return 'Failed'
  if (row.status === 'sending') return 'Sending'
  if (row.status === 'skipped') return 'Skipped'
  return 'Pending'
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

export default function RecipientActivityModal({
  isOpen,
  onClose,
  title,
  subtitle,
  initialTab = 'all',
  rows,
}: RecipientActivityModalProps) {
  const [activeTab, setActiveTab] = useState<ActivityTab>(initialTab)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  const tabCounts = useMemo<Record<ActivityTab, number>>(() => {
    let opened = 0
    let notOpened = 0
    let clicked = 0
    for (const r of rows) {
      if (r.opened_at) opened += 1
      else if (r.sent_at) notOpened += 1
      if (r.clicked_at) clicked += 1
    }
    return {
      all: rows.length,
      opened,
      not_opened: notOpened,
      clicked,
    }
  }, [rows])

  const filteredRows = useMemo(() => {
    let list = rows

    if (activeTab === 'opened') {
      list = list.filter((r) => !!r.opened_at)
    } else if (activeTab === 'not_opened') {
      list = list.filter((r) => !r.opened_at && !!r.sent_at)
    } else if (activeTab === 'clicked') {
      list = list.filter((r) => !!r.clicked_at)
    }

    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (r) =>
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.email && r.email.toLowerCase().includes(q)),
      )
    }

    return list
  }, [rows, activeTab, searchQuery])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedRows = filteredRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

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
        style={{ width: '900px', maxWidth: '95vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
              {subtitle}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="modal-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Tabs */}
          <div
            className="tabs"
            style={{
              margin: 0,
              padding: '0 20px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {ACTIVITY_TABS.map((t) => (
              <div
                key={t.key}
                className={`tab ${activeTab === t.key ? 'active' : ''}`}
                onClick={() => handleTabChange(t.key)}
              >
                {t.label}
                <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: 6 }}>
                  {tabCounts[t.key]}
                </span>
              </div>
            ))}
          </div>

          {/* Search */}
          <div style={{ padding: '14px 20px 0', flexShrink: 0 }}>
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

          {/* Scrollable table body */}
          <div style={{ padding: '14px 20px', overflowY: 'auto', minHeight: 120 }}>
            <div className="table-wrap">
              <table style={{ minWidth: 780 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Queued At</th>
                    <th>Sent At</th>
                    <th>Opened At</th>
                    <th>Clicked At</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        <div className="empty-state">
                          <div className="empty-icon">📭</div>
                          <div className="empty-title">No recipients found</div>
                          <div className="empty-sub">
                            {rows.length === 0
                              ? 'No queue records for this selection yet.'
                              : 'No recipients match your current filter.'}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginatedRows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600, fontSize: '13px' }}>{r.name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--text3)' }}>{r.email || '—'}</td>
                        <td>
                          <Pill status={deriveStatus(r)} />
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', whiteSpace: 'nowrap' }}>
                          {formatTimestamp(r.queued_at)}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', whiteSpace: 'nowrap' }}>
                          {formatTimestamp(r.sent_at)}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', whiteSpace: 'nowrap' }}>
                          {formatTimestamp(r.opened_at)}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', whiteSpace: 'nowrap' }}>
                          {formatTimestamp(r.clicked_at)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div
            style={{
              padding: '12px 20px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
              borderTop: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: '12px', color: 'var(--text4)' }}>
              {filteredRows.length === 0
                ? 'No results'
                : `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filteredRows.length)} of ${filteredRows.length}`}
            </div>
            {totalPages > 1 && (
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
                      <span
                        key={`ellipsis-${i}`}
                        className="pg-btn"
                        style={{ cursor: 'default', border: 'none' }}
                      >
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
            )}
          </div>
        </div>

        <div className="modal-footer" style={{ flexShrink: 0 }}>
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}