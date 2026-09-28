-- ============================================================================
-- Weekly Queue — manual per-record rescheduling of PENDING rows
-- ============================================================================
-- PURELY ADDITIVE. Nothing here changes the behaviour of the automatic
-- Thursday flow created by 20260927000000_weekly_new_contact_automation.sql.
--
-- ─── Why these columns are needed ──────────────────────────────────────────
-- Until now `weekly_email_queue` had NO persisted schedule. The "Scheduled For"
-- column in the Weekly Queue page was a client-side projection of `queued_at`
-- via getNextCronRun(), and process-weekly-queue claimed *every* pending row on
-- its next Thursday fire. To let a user move specific pending rows to a
-- different date/time we need a real, persisted due-date on the row itself.
--
-- ─── The critical rule: NULL means "leave it to Thursday" ──────────────────
--   * scheduled_for IS NULL  → the row is governed by the EXISTING automatic
--     Thursday 7:30 AM IST cron, exactly as today. All 137 pre-existing rows
--     and every row inserted by the contacts/leads triggers keep this default.
--   * scheduled_for IS NOT NULL → the row was manually rescheduled from the UI.
--     process-weekly-queue only claims it once scheduled_for <= now().
--
-- So applying this migration alone changes NOTHING observable. The Thursday
-- cron job (weekly-new-contact-email) is not touched, the daily send capacity
-- is not touched, and the per-run batch claim (MAX_EMAILS_PER_RUN = 30) is not
-- touched.
--
-- ─── No new tables, no new scheduling system ───────────────────────────────
-- Reuses public.weekly_email_queue, its existing `status` CHECK constraint
-- (pending/sending/sent/failed/skipped) and its existing id. The runner still
-- owns all status transitions; this migration never writes `status`.
-- The schedule_* columns below are audit/display metadata that the UI writes
-- alongside scheduled_for; the runner only ever reads `scheduled_for`.
-- ============================================================================

-- ─── The persisted due-date ─────────────────────────────────────────────────
-- Concrete UTC instant at which this row becomes sendable. NULL = "use the
-- existing Thursday 7:30 AM IST automatic schedule".
alter table public.weekly_email_queue
  add column if not exists scheduled_for timestamptz;

-- ─── Audit / display metadata (written by the UI, read by nothing critical) ─
-- schedule_type reuses the vocabulary already used by public.campaign_schedules
-- ('one_time' | 'weekly' | 'monthly'). Recurrence is NOT re-implemented in the
-- runner: the UI resolves weekly/monthly down to a concrete scheduled_for at
-- write time, because the weekly queue is a ONE-TIME send queue (UNIQUE
-- (contact_id), one welcome email per contact). Keeping it as a single
-- timestamp means there is exactly one scheduler — process-weekly-queue.
alter table public.weekly_email_queue
  add column if not exists schedule_type text;

alter table public.weekly_email_queue
  add column if not exists schedule_timezone text;

-- 1-based batch number this row was placed in, for display only.
alter table public.weekly_email_queue
  add column if not exists schedule_batch integer;

alter table public.weekly_email_queue
  add column if not exists schedule_batch_size integer;

alter table public.weekly_email_queue
  add column if not exists schedule_interval_minutes integer;

-- Explicit flag so nothing ever has to *infer* a manual schedule.
alter table public.weekly_email_queue
  add column if not exists manually_scheduled boolean not null default false;

alter table public.weekly_email_queue
  add column if not exists schedule_updated_at timestamptz;

-- Guard rails: batch numbers/sizes are positive, intervals are non-negative,
-- and only the three schedule types the app understands are accepted.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'weekly_email_queue_schedule_type_check'
  ) then
    alter table public.weekly_email_queue
      add constraint weekly_email_queue_schedule_type_check
      check (schedule_type is null or schedule_type in ('one_time', 'weekly', 'monthly'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'weekly_email_queue_schedule_batch_check'
  ) then
    alter table public.weekly_email_queue
      add constraint weekly_email_queue_schedule_batch_check
      check (schedule_batch is null or schedule_batch > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'weekly_email_queue_schedule_batch_size_check'
  ) then
    alter table public.weekly_email_queue
      add constraint weekly_email_queue_schedule_batch_size_check
      check (schedule_batch_size is null or schedule_batch_size > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'weekly_email_queue_schedule_interval_check'
  ) then
    alter table public.weekly_email_queue
      add constraint weekly_email_queue_schedule_interval_check
      check (schedule_interval_minutes is null or schedule_interval_minutes >= 0);
  end if;
end
$$;

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- The runner's hot path: "pending rows that carry a manual schedule, soonest
-- due first". Partial, so it stays tiny (only manually rescheduled rows).
create index if not exists weekly_email_queue_scheduled_pending_idx
  on public.weekly_email_queue (scheduled_for, queued_at)
  where status = 'pending' and scheduled_for is not null;

-- Keep the existing partial index covering the legacy Thursday path
-- (weekly_email_queue_pending_idx on queued_at where status = 'pending') as-is.
-- It still serves every scheduled_for IS NULL row exactly as before.

-- ─── Grants ─────────────────────────────────────────────────────────────────
-- The existing blanket grant from 20260927000000 already includes UPDATE, which
-- is all the reschedule operation needs. Re-assert it so this migration is
-- self-sufficient on installs where default privileges differ. NOTE: RLS is
-- intentionally left disabled, matching the rest of the app's trust model.
grant select, insert, update, delete on public.weekly_email_queue to anon, authenticated, service_role;

-- PostgREST must see the new columns or the UI/edge function will fail with
-- 42703 "column ... does not exist" until it reloads.
notify pgrst, 'reload schema';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- 0) Columns exist:
--    select column_name, data_type, column_default
--    from information_schema.columns
--    where table_schema = 'public' and table_name = 'weekly_email_queue'
--    order by ordinal_position;
--
-- 1) THE MOST IMPORTANT CHECK — every pre-existing row must still be NULL, i.e.
--    still owned by the automatic Thursday 7:30 AM IST schedule:
--    select manually_scheduled, count(*), count(scheduled_for)
--    from public.weekly_email_queue group by 1;
--    -- expect: manually_scheduled = false | <all rows> | 0
--
-- 2) Inspect the split between automatic and manually rescheduled pending rows:
--    select status,
--           case when scheduled_for is null then 'automatic (Thursday 7:30 AM IST)'
--                else 'manual: ' || to_char(scheduled_for at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')
--           end as schedule,
--           count(*)
--    from public.weekly_email_queue
--    group by 1, 2 order by 1, 2;
--
-- 3) Confirm the Thursday cron job is untouched (should still be jobname
--    'weekly-new-contact-email' on '*/30 2-18 * * 4'):
--    select jobid, jobname, schedule, active from cron.job order by jobid;
-- ============================================================================
