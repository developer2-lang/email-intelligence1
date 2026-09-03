import { useState, useMemo } from 'react'

type ActivityTab = 'all' | 'opened' | 'not_opened' | 'clicked'

const ACTIVITY_TABS: { key: ActivityTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'opened', label: 'Opened' },
  { key: 'not_opened', label: 'Not Opened' },
  { key: 'clicked', label: 'Clicked' },
]

const PAGE_SIZE = 10

interface ActivityModalProps {
  isOpen: boolean
  campaignId: string
  campaignName: string
  onClose: () => void
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

  // Placeholder — will be populated with real data in a future task
  const recipients: never[] = useMemo(() => [], [])

  const filteredRecipients = useMemo(() => {
    let list = recipients
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (r: any) =>
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.email && r.email.toLowerCase().includes(q)),
      )
    }
    return list
  }, [recipients, searchQuery])

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
                  {paginatedRecipients.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">
                          <div className="empty-icon">📭</div>
                          <div className="empty-title">No recipient data yet</div>
                          <div className="empty-sub">
                            Recipient activity will appear here once emails are opened or clicked.
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginatedRecipients.map((r: any, idx: number) => (
                      <tr key={r.contact_id || idx}>
                        <td style={{ fontWeight: 600, fontSize: '13px' }}>{r.name || '—'}</td>
                        <td style={{ fontSize: '13px', color: 'var(--text3)' }}>{r.email || '—'}</td>
                        <td>
                          <span
                            className={`tag ${
                              r.status === 'opened'
                                ? 'tag-client'
                                : r.status === 'clicked'
                                  ? 'tag-oem'
                                  : 'tag-draft'
                            }`}
                          >
                            {r.status || 'sent'}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)' }}>{r.opened_at || '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)' }}>{r.clicked_at || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
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
