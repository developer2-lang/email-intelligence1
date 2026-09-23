/**
 * cronUtils.ts
 * Utilities for computing the next weekly-queue cron execution time.
 *
 * The cron job runs every Thursday at 2:30 AM UTC (= 8:00 AM IST).
 * Cron expression: 30 2 * * 4
 */

/**
 * Returns the next Date on which the weekly-queue cron will fire.
 *
 * @param _cronExpression  Accepted for signature compatibility; the function
 *   always uses the hard-coded 30 2 * * 4 schedule since we cannot
 *   parse arbitrary cron expressions without a library.
 */
export function getNextCronRun(_cronExpression: string = '30 2 * * 4'): Date {
  // Thursday = 4 (0 = Sunday … 6 = Saturday)
  const TARGET_DOW = 4;
  const TARGET_HOUR_UTC = 2;
  const TARGET_MIN_UTC = 30;

  const now = new Date();

  // Start candidate at today's target time in UTC
  const next = new Date(now);
  next.setUTCHours(TARGET_HOUR_UTC, TARGET_MIN_UTC, 0, 0);

  // Advance by one day at a time until we land on the correct weekday
  // AND the resulting timestamp is strictly in the future
  while (next.getUTCDay() !== TARGET_DOW || next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(TARGET_HOUR_UTC, TARGET_MIN_UTC, 0, 0);
  }

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
