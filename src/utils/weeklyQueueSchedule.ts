/**
 * weeklyQueueSchedule.ts
 *
 * Pure (side-effect free) schedule + batch maths for manually rescheduling
 * PENDING rows in the Weekly Queue.
 *
 * Nothing in here talks to the network, the database or the DOM — it takes the
 * user's form input plus the selected queue rows and returns, for every batch,
 * the exact UTC instant its members should become sendable. The caller
 * (WeeklyQueue.tsx) is solely responsible for persisting those timestamps.
 *
 * ─── The one-scheduler rule ─────────────────────────────────────────────────
 * `public.weekly_email_queue` is a ONE-TIME send queue: UNIQUE(contact_id) and
 * exactly one welcome email per contact. Recurrence therefore cannot live in
 * the runner — there is nothing to repeat. So Weekly/Monthly are resolved HERE,
 * at write time, down to a single concrete `scheduled_for` per row, and the
 * existing process-weekly-queue Edge Function stays the only component that
 * ever sends. That is deliberately the opposite of building a second scheduler.
 *
 * The automatic Thursday 7:30 AM IST schedule is likewise not recomputed here:
 * a row with `scheduled_for IS NULL` is left completely alone by this module
 * and stays owned by the Thursday cron.
 */

import {
  AUTOMATIC_QUEUE_WEEKDAY,
  WEEKLY_WINDOW_END_MIN,
  WEEKLY_WINDOW_START_MIN,
} from './cronUtils';

// ─── Constants (mirrors the app's existing conventions) ────────────────────

export const SCHEDULE_TIMEZONE = 'Asia/Kolkata';
export const SCHEDULE_TIMEZONE_LABEL = 'IST';

/** UTC+05:30. India observes no daylight saving, so this offset is constant. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Same options as the Campaigns / Follow-ups "Send next batch after" select. */
export const BATCH_DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 5 / 60, label: '5 Minutes' },
  { value: 10 / 60, label: '10 Minutes' },
  { value: 0.25, label: '15 Minutes' },
  { value: 0.5, label: '30 Minutes' },
  { value: 1, label: '1 Hour' },
  { value: 2, label: '2 Hours' },
  { value: 4, label: '4 Hours' },
  { value: 8, label: '8 Hours' },
  { value: 24, label: '24 Hours' },
];

/**
 * 5 minutes is the finest interval the manual-schedule runner polls at (see
 * supabase/weekly-queue-manual-schedule-setup.sql, a 5-minute cron), so it is
 * also the finest interval we offer — otherwise the preview would promise a
 * precision the runner cannot deliver.
 */
export const MIN_BATCH_DELAY_HOURS = BATCH_DELAY_OPTIONS[0].value;

export const SCHEDULE_TYPES = [
  { key: 'one_time', label: 'One Time' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
] as const;

export type ScheduleType = (typeof SCHEDULE_TYPES)[number]['key'];

/** Same ordering/labels as the existing campaign & follow-up schedule UIs. */
export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

const WEEKDAY_INDEX: Record<WeekdayName, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// ─── Minimal shapes this module needs from a queue row ─────────────────────

/** The only queue-row fields the scheduling maths reads. */
export interface SchedulableQueueRow {
  id: string;
  status: string;
  queued_at: string | null;
}

export interface ScheduleFormState {
  scheduleType: ScheduleType;
  /** 'YYYY-MM-DD'. Used as the One Time date, and as the weekly/monthly anchor. */
  date: string;
  /** Free text, e.g. "10:00 AM". Same permissive parser as campaignService. */
  time: string;
  weekday: WeekdayName;
  dayOfMonth: number;
  sendInBatches: boolean;
  batchSize: number;
  /** Batch interval in HOURS, matching the existing DELAY_OPTIONS convention. */
  batchDelayHours: number;
}

export interface ScheduleBatch {
  /** 1-based, matches `schedule_batch` and the "Batch n:" preview lines. */
  batchNumber: number;
  /** `queued_at` asc, then `id` asc. Deterministic — see sortForBatching(). */
  rowIds: string[];
  /** 1-based position of the first member within the whole selection. */
  fromSno: number;
  /** 1-based position of the last member within the whole selection. */
  toSno: number;
  /** The instant this whole batch becomes sendable. */
  scheduledFor: Date;
}

export interface SchedulePreview {
  batches: ScheduleBatch[];
  totalContacts: number;
  batchSize: number;
  estimatedBatches: number;
  intervalMinutes: number;
  intervalLabel: string;
  /** "{batchSize} contacts will be sent every {intervalLabel}." */
  cadenceLine: string;
  /** Set when the form cannot produce a valid schedule. */
  error: string | null;
}

// ─── IST ↔ UTC primitives ─────────────────────────────────────────────────

/** Parse "10:00", "10:00 AM", "9:05 pm" → minutes from IST midnight. */
export function parseIstTimeToMinutes(timeStr: string): number | null {
  const match = String(timeStr || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  const meridian = (match[4] || '').toUpperCase();
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  if (meridian === 'PM' && hours !== 12) hours += 12;
  if (meridian === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

/** Same validity check the campaigns scheduler performs on its date input. */
export function isValidIstDate(dateStr: string): boolean {
  const match = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Build the UTC instant for `minutesFromIstMidnight` on the calendar day
 * `year/mo/day` interpreted as an IST date.
 */
function istCalendarToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number
): Date {
  const asUtc = Date.UTC(year, month, day, 0, minutesFromMidnight, 0, 0);
  return new Date(asUtc - IST_OFFSET_MS);
}

/** "YYYY-MM-DD" of the given instant, as seen in IST. */
function toIstDateStr(instant: Date): string {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Parse 'YYYY-MM-DD' into { year, month (0-based), day }. */
function parseIstDateStr(dateStr: string): { year: number; month: number; day: number } {
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10) - 1,
    day: parseInt(match[3], 10),
  };
}

/** Today in IST as 'YYYY-MM-DD'. Used as the default date in the modal. */
export function todayIstDateStr(now: Date = new Date()): string {
  return toIstDateStr(now);
}

// ─── Base instant per schedule type ────────────────────────────────────────

/**
 * Clamp a time-of-day into the existing automatic weekly window
 * (07:30-23:30 IST). Weekly/Monthly schedules deliberately reuse that window
 * rather than inventing a second one — it comes from the existing 30-minute
 * 02:00-18:00 UTC cron in supabase/weekly-queue-setup.sql.
 */
function clampToWeeklyWindow(minutesFromMidnight: number): number {
  if (minutesFromMidnight < WEEKLY_WINDOW_START_MIN) return WEEKLY_WINDOW_START_MIN;
  if (minutesFromMidnight > WEEKLY_WINDOW_END_MIN) return WEEKLY_WINDOW_END_MIN;
  return minutesFromMidnight;
}

/** Next-or-today occurrence of `weekday` at `minutesFromMidnight` IST. */
function nextWeekdayInstant(
  from: Date,
  weekday: WeekdayName,
  minutesFromMidnight: number
): Date {
  const clamped = clampToWeeklyWindow(minutesFromMidnight);
  const targetDow = WEEKDAY_INDEX[weekday];

  // `from` shifted into IST, i.e. the calendar day the user is looking at.
  const istNow = new Date(from.getTime() + IST_OFFSET_MS);
  // 0 = today, 1 = tomorrow, … 6 = the same weekday one week out.
  const dayDelta = (targetDow - istNow.getUTCDay() + 7) % 7;

  // Two candidates only: this week's occurrence, and the same weekday next week
  // (needed when today's slot has already passed).
  for (let week = 0; week < 2; week += 1) {
    const day = new Date(istNow.getTime() + (dayDelta + week * 7) * 86400000);
    const candidate = istCalendarToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      clamped
    );
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable in practice (week 1 is always strictly future), but return a
  // valid instant rather than throwing if the calendar ever surprises us.
  return istCalendarToUtc(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    clamped
  );
}

/** Next-or-this-month occurrence of day `dayOfMonth` (clamped to month length). */
function nextMonthlyInstant(
  anchorDateStr: string,
  dayOfMonth: number,
  minutesFromMidnight: number,
  now: Date
): Date {
  const clamped = clampToWeeklyWindow(minutesFromMidnight);
  const { year, month, day } = parseIstDateStr(anchorDateStr);
  const wanted = Math.min(31, Math.max(1, Math.trunc(dayOfMonth) || 1));

  // 14 months of headroom guarantees we clear February plus a 31-day anchor.
  for (let i = 0; i < 14; i += 1) {
    const probe = new Date(Date.UTC(year, month + i, 1));
    const candidateYear = probe.getUTCFullYear();
    const candidateMonth = probe.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(candidateYear, candidateMonth + 1, 0)).getUTCDate();
    // Day 31 in a 30-day month means "last day of the month" — the same
    // clamping convention the campaign scheduler uses.
    const candidateDay = Math.min(wanted, daysInMonth);
    // In the anchor month, an anchor day later than the target means "this month
    // has passed" — start looking from the following month.
    if (i === 0 && day > candidateDay) continue;
    const candidate = istCalendarToUtc(candidateYear, candidateMonth, candidateDay, clamped);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return istCalendarToUtc(year, month, wanted, clamped);
}

/**
 * The first batch's send instant for the given form state, or null when the
 * date/time inputs are unusable.
 */
export function resolveFirstBatchInstant(
  form: Pick<ScheduleFormState, 'scheduleType' | 'date' | 'time' | 'weekday' | 'dayOfMonth'>,
  now: Date = new Date()
): Date | null {
  const minutesFromMidnight = parseIstTimeToMinutes(form.time);
  if (minutesFromMidnight === null) return null;

  if (form.scheduleType === 'one_time') {
    if (!isValidIstDate(form.date)) return null;
    const { year, month, day } = parseIstDateStr(form.date);
    // One Time is honoured exactly as entered — no window clamping, because the
    // user named this precise moment and the manual runner polls every 5 min.
    return istCalendarToUtc(year, month, day, minutesFromMidnight);
  }

  if (form.scheduleType === 'weekly') {
    // The explicit "Send On" weekday wins; the date field is only the anchor.
    return nextWeekdayInstant(now, form.weekday, minutesFromMidnight);
  }

  if (!isValidIstDate(form.date)) return null;
  return nextMonthlyInstant(form.date, form.dayOfMonth, minutesFromMidnight, now);
}

// ─── Deterministic ordering ───────────────────────────────────────────────

/**
 * Stable, deterministic order for batching. Oldest queued first (matching the
 * runner's own `order('queued_at', ascending)`), with `id` as tie-breaker so
 * the same selection always produces the same batches — and so S.No numbering
 * in the preview matches S.No numbering in the write.
 */
export function sortForBatching<T extends SchedulableQueueRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aTime = a.queued_at ? new Date(a.queued_at).getTime() : 0;
    const bTime = b.queued_at ? new Date(b.queued_at).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ─── Preview ──────────────────────────────────────────────────────────────

/** Human label for an interval expressed in hours, e.g. 1 → "1 Hour". */
export function intervalLabelFor(batchDelayHours: number): string {
  const minutes = Math.round(batchDelayHours * 60);
  if (minutes < 60) return `${minutes} Minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  return `${hours} Hour${hours === 1 ? '' : 's'}`;
}

/**
 * Build the full batch plan. Pure: the same inputs always yield the same plan,
 * which is what the preview shows AND what the save loop writes.
 */
export function buildSchedulePreview(
  rows: SchedulableQueueRow[],
  form: ScheduleFormState,
  now: Date = new Date()
): SchedulePreview {
  const selected = sortForBatching(rows);
  const totalContacts = selected.length;
  const intervalLabel = intervalLabelFor(form.batchDelayHours);
  const intervalMinutes = Math.max(0, Math.round(form.batchDelayHours * 60));
  const batchSize = Math.max(1, Math.trunc(form.batchSize) || 1);

  const empty = (error: string | null): SchedulePreview => ({
    batches: [],
    totalContacts,
    batchSize,
    estimatedBatches: 0,
    intervalMinutes,
    intervalLabel,
    cadenceLine: form.sendInBatches
      ? `${batchSize} contacts will be sent every ${intervalLabel}.`
      : `All ${totalContacts} contacts will be sent together.`,
    error,
  });

  if (totalContacts === 0) return empty(null);

  const first = resolveFirstBatchInstant(form, now);
  if (!first) {
    const timeOk = parseIstTimeToMinutes(form.time) !== null;
    if (!timeOk) {
      return empty('Enter a valid time, e.g. 10:00 AM');
    }
    return empty('Enter a valid schedule date');
  }

  // Batching off → one single batch at the base instant.
  if (!form.sendInBatches) {
    return {
      batches: [
        {
          batchNumber: 1,
          rowIds: selected.map((r) => r.id),
          fromSno: 1,
          toSno: totalContacts,
          scheduledFor: first,
        },
      ],
      totalContacts,
      batchSize: totalContacts,
      estimatedBatches: 1,
      intervalMinutes: 0,
      intervalLabel,
      cadenceLine: `All ${totalContacts} contacts will be sent together.`,
      error: null,
    };
  }

  // Batch n → base + (n-1) × interval. The last batch is simply short.
  const batches: ScheduleBatch[] = [];
  for (let i = 0; i < totalContacts; i += batchSize) {
    const fromSno = i + 1;
    const toSno = Math.min(i + batchSize, totalContacts);
    batches.push({
      batchNumber: batches.length + 1,
      rowIds: selected.slice(i, toSno).map((r) => r.id),
      fromSno,
      toSno,
      scheduledFor: new Date(first.getTime() + batches.length * intervalMinutes * 60_000),
    });
  }

  return {
    batches,
    totalContacts,
    batchSize,
    estimatedBatches: batches.length,
    intervalMinutes,
    intervalLabel,
    cadenceLine: `${batchSize} contacts will be sent every ${intervalLabel}.`,
    error: null,
  };
}

// ─── Initial form state ───────────────────────────────────────────────────

export function defaultScheduleForm(now: Date = new Date()): ScheduleFormState {
  const today = todayIstDateStr(now);
  return {
    scheduleType: 'one_time',
    date: today,
    time: '10:00 AM',
    // Default to the weekday the automatic queue already uses, so switching
    // from One Time to Weekly starts from the familiar Thursday cadence.
    weekday: WEEKDAY_NAMES[AUTOMATIC_QUEUE_WEEKDAY] as WeekdayName,
    dayOfMonth: parseInt(today.slice(8, 10), 10),
    sendInBatches: true,
    batchSize: 30,
    batchDelayHours: 1,
  };
}
