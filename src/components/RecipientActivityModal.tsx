import { useState, useMemo, useEffect } from 'react'

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
  onDeleteRows?: (ids: string[]) => Promise<void>
  onToast?: (msg: string, type?: string) => void
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

const TrashIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    width={size}
    height={size}
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)

export default function RecipientActivityModal({
  isOpen,
  onClose,
  title,
  subtitle,
  initialTab = 'all',
  rows,
  onDeleteRows,
  onToast,
}: RecipientActivityModalProps) {
  const [activeTab, setActiveTab] = useState<ActivityTab>(initialTab)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [localRows, setLocalRows] = useState<RecipientRow[]>(rows)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>())
  const [deleteConfirm, setDeleteConfirm] = useState<{
    title: string
    description: string
    count: number
    ids: string[]
  } | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setLocalRows(rows)
  }, [rows])

  const tabCounts = useMemo<Record<ActivityTab, number>>(() => {
    let opened = 0
    let notOpened = 0
    let clicked = 0
    for (const r of localRows) {
      if (r.opened_at) opened += 1
      else if (r.sent_at) notOpened += 1
      if (r.clicked_at) clicked += 1
    }
    return {
      all: localRows.length,
      opened,
      not_opened: notOpened,
      clicked,
    }
  }, [localRows])

  const filteredRows = useMemo(() => {
    let list = localRows

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
  }, [localRows, activeTab, searchQuery])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const safePage = Math.min(currentPage, totalPages)
  const paginatedRows = filteredRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleTabChange = (tab: ActivityTab) => {
    setActiveTab(tab)
    setCurrentPage(1)
    setSelectedIds(new Set())
  }

  const handleSearchChange = (value: string) => {
    setSearchQuery(value)
    setCurrentPage(1)
  }

  const isRowSelected = (id: string) => selectedIds.has(id)

  const toggleRowSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allPageSelected =
    paginatedRows.length > 0 && paginatedRows.every((r) => selectedIds.has(r.id))
  const somePageSelected = paginatedRows.some((r) => selectedIds.has(r.id))

  const toggleSelectAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allPageSelected) {
        for (const r of paginatedRows) next.delete(r.id)
      } else {
        for (const r of paginatedRows) next.add(r.id)
      }
      return next
    })
  }

  const promptDeleteSingle = (row: RecipientRow) => {
    setDeleteConfirm({
      title: 'Remove Contact from Queue',
      description: `Are you sure you want to delete ${row.name || row.email || 'this contact'} from the weekly queue? This action cannot be undone.`,
      count: 1,
      ids: [row.id],
    })
  }

  const promptDeleteSelected = () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setDeleteConfirm({
      title: `Delete ${ids.length} Selected Contact${ids.length === 1 ? '' : 's'}`,
      description: `Are you sure you want to delete ${ids.length} selected contact(s) from the weekly queue? This action cannot be undone.`,
      count: ids.length,
      ids,
    })
  }

  const promptDeleteAllInTab = () => {
    if (filteredRows.length === 0) return
    const tabName = ACTIVITY_TABS.find((t) => t.key === activeTab)?.label || 'this tab'
    const ids = filteredRows.map((r) => r.id)
    setDeleteConfirm({
      title: `Delete All in "${tabName}" (${ids.length})`,
      description: `Are you sure you want to delete all ${ids.length} contacts currently visible in "${tabName}" from the weekly email queue? This action cannot be undone.`,
      count: ids.length,
      ids,
    })
  }

  const handleConfirmDelete = async () => {
    if (!deleteConfirm || !onDeleteRows || deleting) return
    setDeleting(true)
    try {
      await onDeleteRows(deleteConfirm.ids)
      const deletedSet = new Set(deleteConfirm.ids)
      setLocalRows((prev) => prev.filter((r) => !deletedSet.has(r.id)))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of deleteConfirm.ids) next.delete(id)
        return next
      })
      onToast?.(`Deleted ${deleteConfirm.count} contact(s) from queue`, 'success')
      setDeleteConfirm(null)
    } catch (e: any) {
      onToast?.(`Failed to delete: ${e?.message || e}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1050 }}>
      <div
        className="modal"
        style={{ width: '960px', maxWidth: '95vw', position: 'relative' }}
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

          {/* Search + Action Toolbar */}
          <div
            style={{
              padding: '14px 20px 0',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div className="input-icon-wrap" style={{ flex: 1, minWidth: 220 }}>
              <span className="inp-icon">🔍</span>
              <input
                type="text"
                placeholder="Search recipients by name or email..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>

            {onDeleteRows && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {selectedIds.size > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        background: '#DC2626',
                        color: '#fff',
                        borderColor: '#DC2626',
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      onClick={promptDeleteSelected}
                    >
                      <TrashIcon size={13} />
                      Delete Selected ({selectedIds.size})
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setSelectedIds(new Set())}
                    >
                      Clear
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    color: '#DC2626',
                    borderColor: '#FECACA',
                    background: '#FEF2F2',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  disabled={filteredRows.length === 0}
                  onClick={promptDeleteAllInTab}
                  title={`Delete all ${filteredRows.length} recipients in the current "${ACTIVITY_TABS.find((t) => t.key === activeTab)?.label}" tab`}
                >
                  <TrashIcon size={13} />
                  Delete All ({filteredRows.length})
                </button>
              </div>
            )}
          </div>

          {/* Scrollable table body */}
          <div style={{ padding: '14px 20px', overflowY: 'auto', minHeight: 120 }}>
            <div className="table-wrap">
              <table style={{ minWidth: 840 }}>
                <thead>
                  <tr>
                    {onDeleteRows && (
                      <th style={{ width: 44, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={allPageSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = !allPageSelected && somePageSelected
                          }}
                          disabled={paginatedRows.length === 0}
                          onChange={toggleSelectAllOnPage}
                          title={allPageSelected ? 'Deselect page' : 'Select page'}
                          aria-label="Select all on this page"
                          style={{
                            accentColor: '#2563EB',
                            width: 16,
                            height: 16,
                            cursor: paginatedRows.length === 0 ? 'not-allowed' : 'pointer',
                            margin: 0,
                          }}
                        />
                      </th>
                    )}
                    <th>Name</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Queued At</th>
                    <th>Sent At</th>
                    <th>Opened At</th>
                    <th>Clicked At</th>
                    {onDeleteRows && <th style={{ textAlign: 'right', width: 70 }}>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={onDeleteRows ? 9 : 7}>
                        <div className="empty-state">
                          <div className="empty-icon">📭</div>
                          <div className="empty-title">No recipients found</div>
                          <div className="empty-sub">
                            {localRows.length === 0
                              ? 'No queue records for this selection.'
                              : 'No recipients match your current filter.'}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginatedRows.map((r) => (
                      <tr
                        key={r.id}
                        style={{
                          background: isRowSelected(r.id) ? '#EFF6FF' : undefined,
                        }}
                      >
                        {onDeleteRows && (
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={isRowSelected(r.id)}
                              onChange={() => toggleRowSelection(r.id)}
                              aria-label={`Select ${r.name || r.email || r.id}`}
                              style={{
                                accentColor: '#2563EB',
                                width: 16,
                                height: 16,
                                margin: 0,
                                cursor: 'pointer',
                              }}
                            />
                          </td>
                        )}
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
                        {onDeleteRows && (
                          <td style={{ textAlign: 'right' }}>
                            <button
                              type="button"
                              className="ct-ibtn ct-ibtn-danger"
                              title="Delete from Queue"
                              onClick={() => promptDeleteSingle(r)}
                            >
                              <TrashIcon size={14} />
                            </button>
                          </td>
                        )}
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

        {/* ─── IN-MODAL DELETE CONFIRMATION ─── */}
        {deleteConfirm && (
          <div
            className="modal-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1100,
              background: 'rgba(0, 0, 0, 0.45)',
              borderRadius: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              className="modal"
              style={{
                maxWidth: 420,
                width: '90%',
                background: '#ffffff',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: '#FEE2E2',
                      color: '#DC2626',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <TrashIcon size={16} />
                  </div>
                  <div className="modal-title" style={{ fontSize: 15 }}>
                    {deleteConfirm.title}
                  </div>
                </div>
                <button
                  className="modal-close"
                  onClick={() => !deleting && setDeleteConfirm(null)}
                  disabled={deleting}
                  title="Close"
                >
                  ✕
                </button>
              </div>
              <div className="modal-body" style={{ padding: '16px 20px' }}>
                <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.55 }}>
                  {deleteConfirm.description}
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: '#FEF2F2',
                    border: '1px solid #FECACA',
                    color: '#991B1B',
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                >
                  ⚠️ <strong>Warning:</strong> This permanently deletes {deleteConfirm.count} queue
                  record{deleteConfirm.count === 1 ? '' : 's'}. This cannot be undone.
                </div>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDeleteConfirm(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-sm"
                  style={{
                    background: '#DC2626',
                    borderColor: '#DC2626',
                    color: '#fff',
                    fontWeight: 600,
                  }}
                  disabled={deleting}
                  onClick={handleConfirmDelete}
                >
                  {deleting
                    ? 'Deleting...'
                    : `Delete ${deleteConfirm.count} Record${deleteConfirm.count === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}