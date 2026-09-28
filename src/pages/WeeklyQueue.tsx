import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AV_COLORS } from '../constants/constants';
import { supabase } from '../supabase';
import { getNextCronRun, formatScheduledTime, formatManualScheduledTime } from '../utils/cronUtils';
import type { ScheduleBatch, ScheduleType } from '../utils/weeklyQueueSchedule';
import ChangeScheduleModal from '../components/ChangeScheduleModal';
import RecipientActivityModal, { RecipientRow, ActivityTab } from '../components/RecipientActivityModal';

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

const CalendarIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

// ─── TYPES ───────────────────────────────────────────────────────────────────
type QueueStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

interface ActivityFilter {
  status: QueueStatus | null;
  initialTab: ActivityTab;
}

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
  opened_at: string | null;
  clicked_at: string | null;
  next_retry_at: string | null;
  error_message: string | null;
  created_at: string | null;
  // ── Manual schedule (migration 20261011000000) ──
  /** Persisted due-date. NULL ⇒ still owned by the automatic Thursday run. */
  scheduled_for: string | null;
  schedule_type: string | null;
  schedule_batch: number | null;
  schedule_batch_size: number | null;
  schedule_interval_minutes: number | null;
  manually_scheduled: boolean | null;
  schedule_updated_at: string | null;
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

/**
 * The send slot shown in the "Scheduled For" column, in priority order:
 *
 *   1. Manually rescheduled row → the PERSISTED `scheduled_for` value. This is
 *      read straight from Supabase, so it survives a page refresh.
 *   2. Otherwise → the automatic Thursday 7:30 AM IST slot projected from
 *      `queued_at`, exactly as before this feature existed.
 *
 * Returns null for non-pending rows (the caller falls back to `sent_at`).
 */
function scheduledFor(row: QueueRow): Date | null {
  if (row.status !== 'pending') return null;

  if (row.scheduled_for) {
    const manual = new Date(row.scheduled_for);
    if (!Number.isNaN(manual.getTime())) return manual;
  }

  if (!row.queued_at) return null;
  const queued = new Date(row.queued_at);
  if (Number.isNaN(queued.getTime())) return null;
  return getNextCronRun(undefined, queued);
}

/** True when the row's schedule was set by a user rather than the Thursday run. */
function hasManualSchedule(row: QueueRow): boolean {
  return row.scheduled_for != null;
}

const TrackBadge = ({
  label,
  active,
  bg,
  color,
  detail,
}: {
  label: string;
  active: boolean;
  bg: string;
  color: string;
  detail?: string | null;
}) => (
  <span
    title={active && detail ? `${label} ${fmtDateTime(detail)}` : undefined}
    style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 999,
      background: active ? bg : '#F1F5F9',
      color: active ? color : '#94A3B8',
      fontSize: 11.5,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}
  >
    {active ? label : '—'}
  </span>
);

const PAGE_SIZE_OPTIONS = [25, 50, 100];

/** PostgREST/URL length ceiling — chunk `.in('id', …)` updates well below it. */
const UPDATE_CHUNK_SIZE = 100;

/** Only these statuses may ever be manually rescheduled. */
const RESCHEDULABLE_STATUS: QueueStatus = 'pending';

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function WeeklyQueue({ onToast }: WeeklyQueueProps) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [searchVal, setSearchVal] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [viewRow, setViewRow] = useState<QueueRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<QueueRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activity, setActivity] = useState<ActivityFilter | null>(null);

  // ─── MANUAL RESCHEDULING (selected PENDING rows only) ───
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // ─── DUAL HORIZONTAL SCROLLBARS (top + bottom, synced) ───
  // A thin strip above the table mirrors the native horizontal scrollbar of
  // `.ct-table-wrap`. Both stay in lock-step via scrollLeft sync, and the strip
  // only renders when the table actually overflows horizontally.
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomWrapRef = useRef<HTMLDivElement | null>(null);
  const [tableWidth, setTableWidth] = useState(1310);
  const [hasHorizOverflow, setHasHorizOverflow] = useState(false);

  useLayoutEffect(() => {
    const wrap = bottomWrapRef.current;
    if (!wrap) return;
    const measure = () => {
      setTableWidth(wrap.scrollWidth);
      setHasHorizOverflow(wrap.scrollWidth > wrap.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const handleTopScroll = () => {
    if (topScrollRef.current && bottomWrapRef.current) {
      bottomWrapRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
  };
  const handleBottomScroll = () => {
    if (bottomWrapRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = bottomWrapRef.current.scrollLeft;
    }
  };

  // ─── DATA FETCHING ───
  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('weekly_email_queue')
        .select('*')
        .order('queued_at', { ascending: false });
      if (error) throw error;
      const nextRows = (data ?? []) as QueueRow[];
      setRows(nextRows);
      setFetchError(null);

      // Drop anything from the current selection that is no longer a pending
      // record in the table we just loaded.
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const live = new Set<string>();
        for (const r of nextRows) {
          if (r.status === RESCHEDULABLE_STATUS && prev.has(r.id)) live.add(r.id);
        }
        return live.size === prev.size ? prev : live;
      });
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

  // ─── RECIPIENT ACTIVITY MODAL ───
  // Rows shown in the modal: filtered to the clicked status when a status badge
  // is clicked; otherwise all rows (engagement badges). The modal itself further
  // splits them into tabs.
  const activityRows = useMemo<RecipientRow[]>(() => {
    const source = activity?.status
      ? dedupedRows.filter((r) => r.status === activity.status)
      : dedupedRows;
    return source.map(
      (r): RecipientRow => ({
        id: r.id,
        name: (r.full_name || '').trim(),
        email: (r.email || '').trim(),
        status: r.status,
        queued_at: r.queued_at,
        sent_at: r.sent_at,
        opened_at: r.opened_at,
        clicked_at: r.clicked_at,
      }),
    );
  }, [dedupedRows, activity]);

  // ─── ENGAGEMENT COUNTS (summary strip badges) ───
  const engagement = useMemo(() => {
    let opened = 0;
    let notOpened = 0;
    for (const r of dedupedRows) {
      if (r.opened_at != null) opened += 1;
      else if (r.sent_at != null) notOpened += 1;
    }
    return { opened, notOpened };
  }, [dedupedRows]);

  // ─── SUMMARY STRIP BADGES ───
  // Status badges from STATUS_META, plus engagement badges (Opened / Not Opened)
  // inserted right after "Sent".
  const statusBadges: {
    key: string;
    count: number;
    label: string;
    bg: string;
    color: string;
    title: string;
    onClick: () => void;
  }[] = (['pending', 'sending', 'sent', 'failed', 'skipped'] as QueueStatus[]).map((s) => ({
    key: s,
    count: summary[s],
    label: STATUS_META[s].label,
    bg: STATUS_META[s].bg,
    color: STATUS_META[s].color,
    title: `View recipient activity — ${STATUS_META[s].label}`,
    onClick: () => setActivity({ status: s, initialTab: 'all' }),
  }));
  const engagementBadges = [
    {
      key: 'opened',
      count: engagement.opened,
      label: 'Opened',
      bg: '#D1FAE5',
      color: '#065F46',
      title: 'View recipient activity — recipients who opened the email',
      onClick: () => setActivity({ status: null, initialTab: 'opened' }),
    },
    {
      key: 'not_opened',
      count: engagement.notOpened,
      label: 'Not Opened',
      bg: '#F1F5F9',
      color: '#475569',
      title: 'View recipient activity — sent but not opened yet',
      onClick: () => setActivity({ status: null, initialTab: 'not_opened' }),
    },
  ];
  const sentIndex = statusBadges.findIndex((b) => b.key === 'sent');
  const summaryBadges = [
    ...statusBadges.slice(0, sentIndex + 1),
    ...engagementBadges,
    ...statusBadges.slice(sentIndex + 1),
  ];

  const totalPages = Math.ceil(filteredRows.length / pageSize) || 1;
  const safePage = Math.min(page, totalPages);

  const paginatedRows = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, safePage, pageSize]);

  // ─── SELECTION (pending rows only) ───
  // Selection is a Set of queue row ids. Every read path re-validates it against
  // the current data (see selectedRows), and fetchQueue() additionally prunes
  // the stored Set, so a record that has since been sent or deleted can never
  // take part in a reschedule.
  const totalPendingRows = useMemo(
    () => dedupedRows.filter((r) => r.status === RESCHEDULABLE_STATUS),
    [dedupedRows]
  );

  const selectedRows = useMemo(
    () => dedupedRows.filter((r) => r.status === RESCHEDULABLE_STATUS && selectedIds.has(r.id)),
    [dedupedRows, selectedIds]
  );

  const selectedCount = selectedRows.length;

  const isRowSelected = (id: string) => selectedIds.has(id);

  const toggleRowSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Pending rows on the CURRENT page only — i.e. what "select all" can see. */
  const pageReschedulableRows = useMemo(
    () => paginatedRows.filter((r) => r.status === RESCHEDULABLE_STATUS),
    [paginatedRows]
  );

  const allPageSelected =
    pageReschedulableRows.length > 0 &&
    pageReschedulableRows.every((r) => selectedIds.has(r.id));

  const somePageSelected = pageReschedulableRows.some((r) => selectedIds.has(r.id));

  const toggleSelectAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const r of pageReschedulableRows) next.delete(r.id);
      } else {
        for (const r of pageReschedulableRows) next.add(r.id);
      }
      return next;
    });
  };

  const clearSelection = useCallback(() => setSelectedIds(new Set<string>()), []);

  // ─── CHANGE SCHEDULE ───
  // Persists the schedule ONLY. No insert, no delete, no `status` write, and
  // certainly no email: the existing process-weekly-queue Edge Function remains
  // the only component that ever sends. The `.eq('status','pending')` guard on
  // every update means a record that got sent between selection and save is
  // silently skipped rather than rescheduled.
  const handleChangeSchedule = async (plan: {
    batches: ScheduleBatch[];
    scheduleType: ScheduleType;
  }) => {
    if (savingSchedule) return;

    const batches = plan.batches;
    if (batches.length === 0) {
      onToast('Nothing to reschedule — no pending records are selected.', 'error');
      return;
    }

    setSavingSchedule(true);
    const nowIso = new Date().toISOString();
    let updated = 0;
    const failures: string[] = [];

    try {
      for (const batch of batches) {
        const payload = {
          scheduled_for: batch.scheduledFor.toISOString(),
          schedule_type: plan.scheduleType,
          schedule_timezone: 'Asia/Kolkata',
          schedule_batch: batch.batchNumber,
          schedule_batch_size: batch.toSno - batch.fromSno + 1,
          schedule_interval_minutes:
            batches.length > 1
              ? Math.round(
                  (batches[1].scheduledFor.getTime() - batches[0].scheduledFor.getTime()) / 60000
                )
              : 0,
          manually_scheduled: true,
          schedule_updated_at: nowIso,
        };

        for (let i = 0; i < batch.rowIds.length; i += UPDATE_CHUNK_SIZE) {
          const chunk = batch.rowIds.slice(i, i + UPDATE_CHUNK_SIZE);
          const { data, error } = await supabase
            .from('weekly_email_queue')
            .update(payload)
            .in('id', chunk)
            .eq('status', RESCHEDULABLE_STATUS)
            .select('id');

          if (error) {
            failures.push(`Batch ${batch.batchNumber}: ${error.message}`);
            continue;
          }
          updated += (data ?? []).length;
        }
      }

      const requested = batches.reduce((sum, b) => sum + b.rowIds.length, 0);
      const failedCount = failures.length;

      if (failedCount > 0) {
        // Report the real error. Never claim success on a partial write.
        onToast(
          `Rescheduled ${updated} of ${requested} pending contacts. Errors — ${failures.join('; ')}`,
          'error'
        );
        if (updated === 0) return;
      } else if (updated !== requested) {
        onToast(
          `Rescheduled ${updated} of ${requested} pending contacts. ${requested - updated} record(s) were no longer pending and were left unchanged.`,
          'error'
        );
      } else {
        onToast(`${updated} pending contacts rescheduled successfully.`, 'success');
      }

      setScheduleOpen(false);
      clearSelection();
      await fetchQueue();
    } catch (e: any) {
      onToast('Failed to change schedule: ' + (e?.message || e), 'error');
    } finally {
      setSavingSchedule(false);
    }
  };

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
      {
        label: 'Scheduled For',
        value: (() => {
          if (r.status === 'sent' && r.sent_at) return formatScheduledTime(new Date(r.sent_at));
          const slot = scheduledFor(r);
          return slot ? formatManualScheduledTime(slot) : '—';
        })(),
      },
      {
        label: 'Schedule Source',
        value: hasManualSchedule(r) ? 'Manual (changed from this page)' : 'Automatic — Thursday 7:30 AM IST',
      },
      { label: 'Schedule Type', value: r.schedule_type || '—' },
      { label: 'Schedule Batch', value: r.schedule_batch != null ? `Batch ${r.schedule_batch}` : '—' },
      {
        label: 'Batch Size',
        value: r.schedule_batch_size != null ? `${r.schedule_batch_size} contacts` : '—',
      },
      {
        label: 'Batch Interval',
        value:
          r.schedule_interval_minutes != null && r.schedule_interval_minutes > 0
            ? `${r.schedule_interval_minutes} minutes`
            : '—',
      },
      { label: 'Schedule Updated', value: fmtDateTime(r.schedule_updated_at) },
      { label: 'Attempted', value: fmtDateTime(r.attempted_at) },
      { label: 'Sent', value: fmtDateTime(r.sent_at) },
      { label: 'Opened', value: fmtDateTime(r.opened_at) },
      { label: 'Clicked', value: fmtDateTime(r.clicked_at) },
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
            New contacts are queued automatically and receive one welcome email every Thursday from
            7:30 AM IST (in batches of 30). Select pending records to move them to a different
            schedule — all other pending records keep the automatic Thursday slot.
          </div>
        </div>
        <div className="ct-toolbar-right">
          <button
            className="btn btn-ghost"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <RefreshIcon size={14} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </span>
          </button>
        </div>
      </div>

      {/* ─── SUMMARY STRIP ─── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 16px' }}>
        {summaryBadges.map((b) => (
          <button
            key={b.key}
            type="button"
            title={b.title}
            onClick={b.onClick}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 12px',
              borderRadius: 999,
              background: b.bg,
              color: b.color,
              fontSize: 12.5,
              fontWeight: 600,
              border: '1px solid transparent',
              cursor: 'pointer',
              transition: 'filter 0.15s ease, transform 0.05s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.96)')}
            onMouseLeave={(e) => (e.currentTarget.style.filter = '')}
            onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
            onMouseUp={(e) => (e.currentTarget.style.transform = '')}
          >
            {b.count} {b.label}
          </button>
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
            <div className="ct-record-count">
              {filteredRows.length} records
              {selectedCount > 0 ? ` · ${selectedCount} pending selected` : ''}
            </div>
          </div>
          <div className="ct-toolbar-right">
            <button
              className="btn btn-primary"
              disabled={selectedCount === 0 || savingSchedule}
              title={
                selectedCount === 0
                  ? 'Select one or more pending records to change their schedule'
                  : `Change the schedule for ${selectedCount} pending record${selectedCount === 1 ? '' : 's'}`
              }
              onClick={() => setScheduleOpen(true)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <CalendarIcon size={14} />
                Change Schedule
                {selectedCount > 0 ? ` (${selectedCount})` : ''}
              </span>
            </button>
            {selectedCount > 0 && (
              <button className="btn btn-ghost" onClick={clearSelection} disabled={savingSchedule}>
                Clear
              </button>
            )}
            {totalPendingRows.length > 0 && selectedCount < totalPendingRows.length && (
              <button
                className="btn btn-ghost"
                onClick={() => setSelectedIds(new Set(totalPendingRows.map((r) => r.id)))}
                disabled={savingSchedule}
                title={`Select all ${totalPendingRows.length} pending records`}
                style={{ fontSize: 12.5 }}
              >
                Select All Pending ({totalPendingRows.length})
              </button>
            )}
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
        {hasHorizOverflow && (
          <div
            className="ct-table-scrollbar"
            ref={topScrollRef}
            onScroll={handleTopScroll}
            aria-hidden="true"
          >
            <div style={{ width: tableWidth, minWidth: tableWidth, height: 1 }} />
          </div>
        )}
        <div className="ct-table-wrap" ref={bottomWrapRef} onScroll={handleBottomScroll}>
          <table className="ct-table" style={{ minWidth: 1360 }}>
            <thead>
              <tr>
                <th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allPageSelected && somePageSelected;
                    }}
                    disabled={pageReschedulableRows.length === 0}
                    onChange={toggleSelectAllOnPage}
                    title={
                      pageReschedulableRows.length === 0
                        ? 'No pending records on this page'
                        : allPageSelected
                          ? 'Deselect all pending records on this page'
                          : 'Select all pending records on this page'
                    }
                    aria-label="Select all pending records on this page"
                    style={{
                      accentColor: '#2563EB',
                      width: 16,
                      height: 16,
                      cursor: pageReschedulableRows.length === 0 ? 'not-allowed' : 'pointer',
                      margin: 0,
                    }}
                  />
                </th>
                <th>Name</th>
                <th>Email</th>
                <th>Company</th>
                <th>Designation</th>
                <th>Status</th>
                <th>Queued</th>
                <th>Sent</th>
                <th>Opened</th>
                <th>Clicked</th>
                <th>Scheduled For</th>
                <th style={{ textAlign: 'center', width: 80 }}>Attempts</th>
                <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={13}>
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
                  <td colSpan={13}>
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
                  // Selection is restricted to PENDING rows. Everything else
                  // (sending / sent / opened / not opened / failed / skipped)
                  // renders a disabled checkbox so it can never be picked.
                  const canSelect = r.status === RESCHEDULABLE_STATUS;
                  return (
                    <tr
                      key={r.id}
                      style={{
                        background: isRowSelected(r.id) ? '#EFF6FF' : undefined,
                        cursor: canSelect ? 'pointer' : undefined,
                      }}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('button, a, input, select, textarea')) return;
                        if (canSelect) {
                          toggleRowSelection(r.id);
                        }
                      }}
                    >
                      <td style={{ textAlign: 'center' }}>
                        {canSelect ? (
                          <input
                            type="checkbox"
                            checked={isRowSelected(r.id)}
                            onChange={() => toggleRowSelection(r.id)}
                            title={`Select ${r.full_name || r.email || 'this contact'}`}
                            aria-label={`Select ${r.full_name || r.email || r.id}`}
                            style={{
                              accentColor: '#2563EB',
                              width: 16,
                              height: 16,
                              margin: 0,
                              cursor: 'pointer',
                            }}
                          />
                        ) : null}
                      </td>
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
                        <button
                          type="button"
                          title={`${r.error_message || `View recipient activity — ${meta.label}`}`}
                          onClick={() => setActivity({ status: r.status, initialTab: 'all' })}
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 999,
                            background: meta.bg,
                            color: meta.color,
                            fontSize: 12,
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            border: 'none',
                            cursor: 'pointer',
                            transition: 'filter 0.15s ease',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(0.96)')}
                          onMouseLeave={(e) => (e.currentTarget.style.filter = '')}
                        >
                          {meta.label}
                        </button>
                      </td>
                      <td>
                        <div className="ct-desig">{fmtDate(r.queued_at)}</div>
                      </td>
                      <td>
                        <div className="ct-desig">{fmtDate(r.sent_at)}</div>
                      </td>
                      <td>
                        <TrackBadge
                          label="Opened"
                          active={!!r.opened_at}
                          bg="#D1FAE5"
                          color="#065F46"
                          detail={r.opened_at}
                        />
                      </td>
                      <td>
                        <TrackBadge
                          label="Clicked"
                          active={!!r.clicked_at}
                          bg="#DBEAFE"
                          color="#1D4ED8"
                          detail={r.clicked_at}
                        />
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
                        ) : (() => {
                          const slot = scheduledFor(r);
                          if (!slot) {
                            return (
                              <span className="ct-desig" style={{ whiteSpace: 'nowrap' }}>
                                —
                              </span>
                            );
                          }
                          // A manually rescheduled row shows the PERSISTED
                          // value from Supabase (survives refresh) in a
                          // distinct colour; an untouched row keeps the
                          // automatic Thursday 7:30 AM IST projection.
                          const manual = hasManualSchedule(r);
                          return (
                            <span
                              title={
                                manual
                                  ? `Manually scheduled${r.schedule_batch ? ` — batch ${r.schedule_batch}` : ''}${
                                      r.schedule_updated_at
                                        ? `, changed ${fmtDateTime(r.schedule_updated_at)}`
                                        : ''
                                    }`
                                  : 'Automatic weekly queue — every Thursday from 7:30 AM IST'
                              }
                              style={{
                                display: 'inline-block',
                                padding: '3px 10px',
                                borderRadius: 999,
                                background: manual ? '#DBEAFE' : STATUS_META.pending.bg,
                                color: manual ? '#1D4ED8' : STATUS_META.pending.color,
                                fontSize: 11.5,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {manual
                                ? formatManualScheduledTime(slot)
                                : formatScheduledTime(slot)}
                            </span>
                          );
                        })()}
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

      {/* ─── MODAL: CHANGE SCHEDULE (pending records only) ─── */}
      {scheduleOpen && (
        <ChangeScheduleModal
          rows={selectedRows}
          submitting={savingSchedule}
          onClose={() => setScheduleOpen(false)}
          onSubmit={(plan) => void handleChangeSchedule(plan)}
        />
      )}

      {/* ─── MODAL: RECIPIENT ACTIVITY ─── */}
      {activity && (
        <RecipientActivityModal
          key={`${activity.status ?? 'all'}-${activity.initialTab}`}
          isOpen={true}
          onClose={() => setActivity(null)}
          title="Recipient Activity"
          subtitle={`Weekly Welcome Email${
            activity.status ? ` — ${STATUS_META[activity.status].label}` : ''
          }`}
          initialTab={activity.initialTab}
          rows={activityRows}
        />
      )}
    </div>
  );
}