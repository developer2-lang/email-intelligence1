/**
 * cronUtils.ts
 * Utilities for computing the next weekly-queue cron execution time.
 *
 * The cron job runs every Thursday, every 30 minutes, from 02:00 to 18:00 UTC
 * (= 7:30 AM to 11:30 PM IST), draining up to 30 new-contact emails per fire.
 * Cron expression: * /30 2-18 * * 4
 */

/**
 * Returns the next Date on which the weekly-queue cron will fire, computed
 * forwards from a reference time. Pass the row's `queued_at` to get that
 * contact's actual scheduled slot:
 *
 *  - queued before 02:00 UTC on Thursday      → Thursday 02:00 UTC (7:30 AM IST)
 *  - queued between 02:00–18:00 UTC Thursday  → next 30-min slot strictly after
 *  - queued after 18:00 UTC Thursday          → next Thursday 02:00 UTC
 *
 * With no reference (`base` omitted/null) it behaves as before: the next slot
 * strictly after "now".
 *
 * @param _cronExpression  Accepted for signature compatibility; the function
 *   always uses the hard-coded * /30 2-18 * * 4 schedule since we cannot
 *   parse arbitrary cron expressions without a library.
 * @param base             Reference time (Date or ISO string). Defaults to now.
 */
export function getNextCronRun(
  _cronExpression: string = '*/30 2-18 * * 4',
  base?: Date | string | null
): Date {
  // Thursday = 4 (0 = Sunday … 6 = Saturday)
  const TARGET_DOW = 4;
  // Batching window: every 30 min from 02:00 to 18:00 UTC (7:30 AM–11:30 PM IST).
  const WINDOW_START_UTC = 2 * 60;   // 02:00 UTC = 7:30 AM IST
  const WINDOW_END_UTC = 18 * 60;    // 18:00 UTC = 11:30 PM IST (last slot)
  const SLOT_MINUTES = 30;

  const ref = base ? new Date(base) : new Date();
  const refMinutes = ref.getUTCHours() * 60 + ref.getUTCMinutes();
  const isTargetDay = ref.getUTCDay() === TARGET_DOW;
  const windowOver = refMinutes >= WINDOW_END_UTC;

  // Anchor: next Thursday at 00:00 UTC.
  const next = new Date(ref);
  next.setUTCHours(0, 0, 0, 0);
  while (next.getUTCDay() !== TARGET_DOW) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  // It's Thursday but the window is already over -> jump to next Thursday.
  if (isTargetDay && windowOver) {
    next.setUTCDate(next.getUTCDate() + 7);
  }

  // Any future Thursday (or today before the window opens) -> first slot 02:00 UTC.
  // Today inside the window -> next 30-min boundary strictly after base.
  let slotMinutes = WINDOW_START_UTC;
  if (isTargetDay && !windowOver && refMinutes >= WINDOW_START_UTC) {
    slotMinutes = Math.min(
      Math.ceil((refMinutes + 1) / SLOT_MINUTES) * SLOT_MINUTES,
      WINDOW_END_UTC
    );
  }

  next.setUTCHours(Math.floor(slotMinutes / 60), slotMinutes % 60, 0, 0);
  return next;
}

/**
 * Formats a Date as "Thu, Sep 24 • 8:00 AM IST".
 */
export function formatScheduledTime(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata', // IST = UTC+5:30
  };

  // en-US gives "Thu, Sep 24, 8:00 AM" — we want "Thu, Sep 24 • 8:00 AM IST"
  const formatted = new Intl.DateTimeFormat('en-US', options).format(date);

  // Replace the comma+space before the time with " • ", then append " IST"
  // Input:  "Thu, Sep 24, 8:00 AM"
  // Output: "Thu, Sep 24 • 8:00 AM IST"
  return formatted.replace(/, (\d{1,2}:\d{2} [AP]M)$/, ' • $1') + ' IST';
}

// ─── Weekly scheduling window (single source of truth) ───────────────────────
// The automatic Thursday run only ever operates inside this window, so a manual
// schedule must respect it too. Exported as minutes-from-IST-midnight (not UTC)
// because the "Time (IST)" control is entered and displayed in IST.

/** 07:30 IST — first slot of the automatic Thursday window. */
export const WEEKLY_WINDOW_START_MIN = 7 * 60 + 30; // 450

/** 23:30 IST — last slot of the automatic Thursday window. */
export const WEEKLY_WINDOW_END_MIN = 23 * 60 + 30; // 1410

/** The existing weekly cadence: one batch every 30 minutes. */
export const WEEKLY_SLOT_MINUTES = 30;

/** The weekday the existing automatic queue runs on (0 = Sunday). */
export const AUTOMATIC_QUEUE_WEEKDAY = 4; // Thursday

/**
 * Formats a manually-chosen schedule as "Oct 1, 2026 • 10:00 AM IST".
 *
 * Deliberately a different shape from formatScheduledTime(): that one renders
 * the weekday because every automatic slot is a Thursday. A manual schedule can
 * land on any day, so the weekday is noise and the year is worth showing.
 */
export function formatManualScheduledTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata', // IST = UTC+5:30
  }).format(date); // "Oct 1, 2026, 10:00 AM"

  return formatted.replace(/, (\d{1,2}:\d{2} [AP]M)$/, ' • $1') + ' IST';
}
