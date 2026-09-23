/**
 * cronUtils.ts
 * Utilities for computing the next weekly-queue cron execution time.
 *
 * The cron job runs every Thursday, every 30 minutes, from 02:00 to 18:00 UTC
 * (= 7:30 AM to 11:30 PM IST), draining up to 30 new-contact emails per fire.
 * Cron expression: * /30 2-18 * * 4
 */

/**
 * Returns the next Date on which the weekly-queue cron will fire.
 *
 * @param _cronExpression  Accepted for signature compatibility; the function
 *   always uses the hard-coded * /30 2-18 * * 4 schedule since we cannot
 *   parse arbitrary cron expressions without a library.
 */
export function getNextCronRun(_cronExpression: string = '*/30 2-18 * * 4'): Date {
  // Thursday = 4 (0 = Sunday … 6 = Saturday)
  const TARGET_DOW = 4;
  // Batching window: every 30 min from 02:00 to 18:00 UTC (7:30 AM–11:30 PM IST).
  const WINDOW_START_UTC = 2 * 60;   // 02:00 UTC = 7:30 AM IST
  const WINDOW_END_UTC = 18 * 60;    // 18:00 UTC = 11:30 PM IST (last slot)
  const SLOT_MINUTES = 30;

  const now = new Date();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const isTargetDay = now.getUTCDay() === TARGET_DOW;
  const windowOver = nowMinutes >= WINDOW_END_UTC;

  // Anchor: next Thursday at 00:00 UTC.
  const next = new Date(now);
  next.setUTCHours(0, 0, 0, 0);
  while (next.getUTCDay() !== TARGET_DOW) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  // It's Thursday but the window is already over -> jump to next Thursday.
  if (isTargetDay && windowOver) {
    next.setUTCDate(next.getUTCDate() + 7);
  }

  // Any future Thursday (or today before the window opens) -> first slot 02:00 UTC.
  // Today inside the window -> next 30-min boundary strictly after now.
  let slotMinutes = WINDOW_START_UTC;
  if (isTargetDay && !windowOver && nowMinutes >= WINDOW_START_UTC) {
    slotMinutes = Math.min(
      Math.ceil((nowMinutes + 1) / SLOT_MINUTES) * SLOT_MINUTES,
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
