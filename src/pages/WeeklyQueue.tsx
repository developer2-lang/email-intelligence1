import { useState, useMemo, useCallback, useEffect } from 'react';
import { AV_COLORS } from '../constants/constants';
import { supabase } from '../supabase';
import { getNextCronRun, formatScheduledTime } from '../utils/cronUtils';

// ─── ICONS (match the Contacts page icon system) ─────────────────────────────
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const RefreshIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

const EyeIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const TrashIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ─── TYPES ───────────────────────────────────────────────────────────────────
type QueueStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

interface QueueRow {
  id: string;
  contact_id: string;
  email: string | null;
  full_name: string | null;
  company: string | null;
  designation: string | null;
  industry: string | null;
  status: QueueStatus;
  attempts: number;
  queued_at: string | null;
  attempted_at: string | null;
  sent_at: string | null;
  next_retry_at: string | null;
  error_message: string | null;
  created_at: string | null;
}

interface WeeklyQueueProps {
  onToast: (msg: string, type?: string) => void;
}

const STATUS_META: Record<QueueStatus, { label: string; bg: string; color: string }> = {
  pending: { label: 'Pending', bg: '#FEF3C7', color: '#92400E' },
  sending: { label: 'Sending', bg: '#DBEAFE', color: '#1D4ED8' },
  sent: { label: 'Sent', bg: '#D1FAE5', color: '#065F46' },
  failed: { label: 'Failed', bg: '#FEE2E2', color: '#991B1B' },
  skipped: { label: 'Skipped', bg: '#F1F5F9', color: '#475569' },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
function initialsOf(name: string): string {
  return (
    (name || '')
      .split(' ')
      .map((x) => x[0])
      .join('')
      .substring(0, 2)
      .toUpperCase() || '??'
  );
}

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function WeeklyQueue({ onToast }: WeeklyQueueProps) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [searchVal, setSearchVal] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [viewRow, setViewRow] = useState<QueueRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<QueueRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ─── DATA FETCHING ───
  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('weekly_email_queue')
        .select('*')
        .order('queued_at', { ascending: false });
      if (error) throw error;
      setRows((data ?? []) as QueueRow[]);
      setFetchError(null);
    } catch (e: any) {
      const message = e?.message || 'Failed to load the weekly queue';
      setFetchError(
        message.toLowerCase().includes('42p01') || message.toLowerCase().includes('does not exist')
          ? 'Weekly queue table not found — apply the migration (20260927000000_weekly_new_contact_automation) first.'
          : message,
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchQueue();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchQueue]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchQueue();
      onToast('Weekly queue refreshed', 'success');
    } catch {
      onToast('Failed to refresh the weekly queue', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  // ─── DEDUPE BY EMAIL (safety net) ───
  // The migration (20260928000000) guarantees one queue row per unique address,
  // but this page also merges by lowercase email defensively so pre-migration
  // duplicates never show twice. Per group keep precedence: 'sent' > 'failed' >
  // 'pending', resolved by newest queued_at on ties.
  const dedupedRows = useMemo(() => {
    const byEmail = new Map<string, QueueRow>();
    const priority: Record<QueueStatus, number> = {
      sent: 3,
      sending: 1,
      failed: 2,
      pending: 1,
      skipped: 0,
    };
    for (const row of rows) {
      const key = (row.email ?? '').toLowerCase().trim();
      if (!key) {
        byEmail.set(row.id, row);
        continue;
      }
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, row);
        continue;
      }
      const cur = priority[row.status];
      const prev = priority[existing.status];
      const curTime = row.queued_at ? new Date(row.queued_at).getTime() : 0;
      const prevTime = existing.queued_at ? new Date(existing.queued_at).getTime() : 0;
      if (cur > prev || (cur === prev && curTime > prevTime)) {
        byEmail.set(key, row);
      }
    }
    return Array.from(byEmail.values());
  }, [rows]);

  // ─── FILTERED + SORTED ROWS ───
  const filteredRows = useMemo(() => {
    let result = dedupedRows;

    const q = searchVal.trim().toLowerCase();
    if (q) {
      result = result.filter((r) => {
        const haystack = [r.full_name, r.email, r.company]
          .map((v) => (v || '').toLowerCase())
          .join(' ');
        return haystack.includes(q);
      });
    }

    if (statusFilter) {
      result = result.filter((r) => r.status === statusFilter);
    }

    return result;
  }, [dedupedRows, searchVal, statusFilter]);

  // Summary counts (over unique contacts, not just the filtered page)
  const summary = useMemo(() => {
    const counts = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of dedupedRows) {
      if (counts[r.status] !== undefined) counts[r.status] += 1;
    }
    return counts;
  }, [dedupedRows]);

  const totalPages = Math.ceil(filteredRows.length / pageSize) || 1;
  const safePage = Math.min(page, totalPages);

  const paginatedRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safePage, pageSize]);

  // ─── REMOVE FROM QUEUE ───
  const handleConfirmRemove = async () => {
    if (submitting || !removeTarget) return;
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('weekly_email_queue')
        .delete()
        .eq('id', removeTarget.id);
      if (error) {
        onToast('Failed to remove from queue: ' + error.message, 'error');
        return;
      }
      setRemoveTarget(null);
      onToast('Contact removed from the weekly queue', 'success');
      setRows((prev) => prev.filter((r) => r.id !== removeTarget.id));
    } catch (e: any) {
      onToast('Failed to remove from queue: ' + (e?.message || e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── VIEW MODAL DETAIL ROWS ───
  const detailRows = useMemo(() => {
    if (!viewRow) return [];
    const r = viewRow;
    return [
      { label: 'Full Name', value: r.full_name || '—' },
      { label: 'Email', value: r.email || '—' },
      { label: 'Company', value: r.company || '—' },
      { label: 'Designation', value: r.designation || '—' },
      { label: 'Industry', value: r.industry || '—' },
      { label: 'Status', value: STATUS_META[r.status].label },
      { label: 'Queued', value: fmtDateTime(r.queued_at) },
      { label: 'Attempted', value: fmtDateTime(r.attempted_at) },
      { label: 'Sent', value: fmtDateTime(r.sent_at) },
      { label: 'Next Retry', value: fmtDateTime(r.next_retry_at) },
      { label: 'Attempts', value: String(r.attempts) },
      { label: 'Error', value: r.error_message || '—' },
      { label: 'Contact ID', value: r.contact_id },
      { label: 'Record ID', value: r.id },
    ];
  }, [viewRow]);

  return (
    <div className="page active">
      {/* ─── TITLE + ACTIONS ─── */}
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Weekly Queue</div>
          <div className="contacts-sub">
            New contacts are queued automatically and receive one welcome email every Thursday at
            8:00 AM IST.
          </div>
        </div>
        <div className="ct-toolbar-right" style={{ marginTop: 0 }}>
          <button className="btn btn-ghost" disabled={refreshing} onClick={() => void handleRefresh()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <RefreshIcon size={14} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </span>
          </button>
        </div>
      </div>

      {/* ─── SUMMARY STRIP ─── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 16px' }}>
        {(['pending', 'sending', 'sent', 'failed', 'skipped'] as QueueStatus[]).map((s) => (
          <div
            key={s}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 12px',
              borderRadius: 999,
              background: STATUS_META[s].bg,
              color: STATUS_META[s].color,
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {summary[s]} {STATUS_META[s].label}
          </div>
        ))}
      </div>

      {/* ─── TABLE PANEL ─── */}
      {rows.length > dedupedRows.length && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            margin: '0 0 16px',
            borderRadius: 8,
            background: '#FFFBEB',
            border: '1px solid #FDE68A',
            color: '#92400E',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          Some duplicate email addresses were detected and merged. Showing{' '}
          {dedupedRows.length} unique contact
          {dedupedRows.length === 1 ? '' : 's'} ({rows.length - dedupedRows.length} duplicate
          row{rows.length - dedupedRows.length === 1 ? '' : 's'} hidden).
        </div>
      )}

      <div className="ct-panel">
        {/* Toolbar: search + status filter */}
        <div className="ct-toolbar">
          <div>
            <div className="ct-panel-title">Weekly Email Queue</div>
            <div className="ct-record-count">{filteredRows.length} records</div>
          </div>
          <div className="ct-toolbar-right">
            <div className="ct-search">
              <span className="ct-search-ic">
                <SearchIcon size={15} />
              </span>
              <input
                type="search"
                value={searchVal}
                onChange={(e) => {
                  setSearchVal(e.target.value);
                  setPage(1);
                }}
                placeholder="Search name, email, company..."
              />
            </div>
            <select
              className="ct-select"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All Statuses</option>
              {(['pending', 'sending', 'sent', 'failed', 'skipped'] as QueueStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ─── QUEUE TABLE ─── */}
        <div className="ct-table-wrap">
          <table className="ct-table" style={{ minWidth: 1120 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Designation</th>
                <th>Status</th>
                <th>Queued</th>
                <th>Sent</th>
                <th>Scheduled For</th>
                <th style={{ textAlign: 'center', width: 80 }}>Attempts</th>
                <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span className="spinner"></span>
                        <span className="empty-title">Loading weekly queue...</span>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">📬</div>
                      <div className="empty-title">No queued contacts</div>
                      <div className="empty-sub">
                        {fetchError
                          ? fetchError
                          : 'New contacts added after the migration will appear here automatically.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r) => {
                  const avatarBg = AV_COLORS[(r.full_name || 'A').charCodeAt(0) % AV_COLORS.length];
                  const meta = STATUS_META[r.status];
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="ct-name-cell">
                          <div className="ct-avatar" style={{ background: avatarBg }}>
                            {initialsOf(r.full_name || '')}
                          </div>
                          <div className="ct-name-col">
                            <div className="ct-name">{r.full_name || '—'}</div>
                            <div className="ct-sub">{r.industry || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="ct-email">{r.email || '—'}</span>
                      </td>
                      <td>
                        <div className="ct-cell-main">{r.company || '—'}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{r.designation || '—'}</div>
                      </td>
                      <td>
                        <span
                          title={r.error_message || undefined}
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 999,
                            background: meta.bg,
                            color: meta.color,
                            fontSize: 12,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td>
                        <div className="ct-desig">{fmtDate(r.queued_at)}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{fmtDate(r.sent_at)}</div>
                      </td>
                      <td>
                        {r.status === 'sent' && r.sent_at ? (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: 999,
                              background: STATUS_META.sent.bg,
                              color: STATUS_META.sent.color,
                              fontSize: 11.5,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatScheduledTime(new Date(r.sent_at))}
                          </span>
                        ) : r.status === 'pending' ? (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: 999,
                              background: STATUS_META.pending.bg,
                              color: STATUS_META.pending.color,
                              fontSize: 11.5,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {formatScheduledTime(getNextCronRun())}
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: 999,
                              background: STATUS_META.failed.bg,
                              color: STATUS_META.failed.color,
                              fontSize: 11.5,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Retry next Wed
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <div className="ct-desig">{r.attempts}</div>
                      </td>
                      <td>
                        <div className="ct-row-actions">
                          <button
                            title="View Details"
                            onClick={() => setViewRow(r)}
                            className="ct-ibtn"
                          >
                            <EyeIcon size={15} />
                          </button>
                          <button
                            title="Remove from Queue"
                            onClick={() => setRemoveTarget(r)}
                            className="ct-ibtn ct-ibtn-danger"
                          >
                            <TrashIcon size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ─── PAGINATION FOOTER ─── */}
        {!loading && (
          <div className="ct-foot">
            <div className="ct-sub" style={{ marginTop: 0 }}>
              Showing{' '}
              <span style={{ fontWeight: 600, color: 'var(--text2)' }}>
                {paginatedRows.length > 0 ? (safePage - 1) * pageSize + 1 : 0}
                {' – '}
                {Math.min(safePage * pageSize, filteredRows.length)}
              </span>{' '}
              of {filteredRows.length}
              <span style={{ marginLeft: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="wq-page-size" style={{ color: 'var(--text4)', fontWeight: 600 }}>
                  Per page
                </label>
                <select
                  id="wq-page-size"
                  className="ct-select"
                  style={{ padding: '6px 26px 6px 10px' }}
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  disabled={safePage === 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  className="pg-btn"
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`pg-btn ${p === safePage ? 'active' : ''}`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  disabled={safePage === totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                  className="pg-btn"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── MODAL: VIEW QUEUE ITEM ─── */}
      {viewRow && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Queue Item Details</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  {viewRow.full_name || viewRow.email || 'Weekly queue record'}
                </div>
              </div>
              <button className="modal-close" onClick={() => setViewRow(null)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                {detailRows.map((row) => (
                  <div className="form-group" key={row.label}>
                    <label>{row.label}</label>
                    <div style={{ fontSize: 13, color: 'var(--text2)', wordBreak: 'break-all' }}>
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setViewRow(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: REMOVE FROM QUEUE ─── */}
      {removeTarget && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Remove from Queue</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  {removeTarget.full_name || removeTarget.email || 'This contact'}
                </div>
              </div>
              <button
                className="modal-close"
                onClick={() => setRemoveTarget(null)}
                title="Close"
              >
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.55 }}>
                {removeTarget.status === 'pending'
                  ? 'This contact will no longer receive the weekly welcome email.'
                  : 'This only removes the queue record — it does not unsend any email that has already been delivered.'}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setRemoveTarget(null)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                disabled={submitting}
                onClick={() => void handleConfirmRemove()}
              >
                {submitting ? 'Removing...' : 'Remove from Queue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}