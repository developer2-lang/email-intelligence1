-- ============================================================================
-- Per-email open/click tracking columns for the weekly welcome queue.
-- ============================================================================
-- Additive only. Adds the two tracking timestamps the weekly-queue sender /
-- email-open-tracker / click-tracker Edge Functions write to when a weekly
-- welcome email is opened or clicked (per email, unlike campaign_analytics
-- which is per campaign group):
--
--   1. `weekly_email_queue.opened_at`  — set on the FIRST open only
--                                          (trackers use `WHERE opened_at IS NULL`).
--   2. `weekly_email_queue.clicked_at` — set on the FIRST click only.
--
-- If these columns already exist (e.g. added manually via ALTER TABLE on the
-- live project), this migration is a no-op — safe to re-run.
-- ============================================================================

alter table public.weekly_email_queue
  add column if not exists opened_at  timestamptz,
  add column if not exists clicked_at timestamptz;

-- Make PostgREST pick up the new columns immediately.
notify pgrst, 'reload schema';