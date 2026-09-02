-- Make follow-up / campaign batch delay columns fractional-hour capable.
--
-- The UI lets the user pick delays of 15 minutes (0.25 h), 30 minutes (0.5 h),
-- 1 hour (1), etc. The previous columns were INTEGER, so a 30-minute / 15-minute
-- choice was silently truncated to 0 (never a delay). Changing them to
-- double precision keeps the values in "hours" (the column names and the
-- UI's DELAY_OPTIONS both use hours) while preserving 0.25 / 0.5 correctly.
--
-- Integer values already stored (2, 1, ...) are unchanged; fractions now round
-- correctly. DEFAULT and NOT NULL semantics are preserved where they existed.

ALTER TABLE "public"."campaigns"
    ALTER COLUMN "first_batch_delay_hours" TYPE double precision,
    ALTER COLUMN "subsequent_batch_delay_hours" TYPE double precision;

-- Bumped batch counter for the every-minute scheduler.
-- The scheduler increments campaigns.current_batch_number after each batch it
-- delivers. A fresh queue (Send button) resets it to 0 so the very NEXT batch
-- uses first_batch_delay_hours for its wait; every later batch uses
-- subsequent_batch_delay_hours. This survives restarts and is not polluted by
-- follow-ups already sent in an earlier session.
ALTER TABLE "public"."campaigns"
    ADD COLUMN IF NOT EXISTS "current_batch_number" integer NOT NULL DEFAULT 0;
