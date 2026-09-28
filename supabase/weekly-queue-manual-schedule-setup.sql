-- ============================================================================
-- process-weekly-queue — ADDITIVE job for MANUALLY RESCHEDULED pending rows
-- ============================================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query), AFTER
-- applying migration 20261011000000_weekly_queue_manual_schedule.sql.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ THIS SCRIPT DOES NOT TOUCH THE THURSDAY AUTOMATION.                      │
-- │ It never calls cron.unschedule on `weekly-new-contact-email`, never      │
-- │ edits that job, and never changes its '*/30 2-18 * * 4' schedule.        │
-- │ It ADDS a second, separate job under a different name.                   │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- ─── Why a second job is needed ────────────────────────────────────────────
-- The pre-existing job fires ONLY on Thursday. A user who reschedules 30
-- pending contacts to "Wed 14 Oct, 10:00 AM IST" would otherwise never be
-- picked up, because the Thursday cron simply does not run that day.
--
-- So we add `weekly-queue-manual-schedule`, which fires every 5 minutes on
-- every day of the week and calls the SAME Edge Function with
-- {"mode":"scheduled_only"}. That mode makes the function claim ONLY rows whose
-- scheduled_for is set and has come due — i.e. only rows a human explicitly
-- rescheduled. It can never touch a row that is still owned by the automatic
-- Thursday schedule (those have scheduled_for IS NULL).
--
-- Net effect on the weekly queue:
--   * Rows with scheduled_for IS NULL  → handled by `weekly-new-contact-email`
--                                        (Thursday 07:30 AM–11:30 PM IST).
--                                        COMPLETELY UNCHANGED.
--   * Rows with scheduled_for IS NOT NULL AND due → handled by
--                                        `weekly-queue-manual-schedule`
--                                        (any day, within 5 min of due).
--   * Rows with scheduled_for IS NOT NULL and NOT yet due → left alone.
--
-- ─── Prerequisites ─────────────────────────────────────────────────────────
--   a. supabase db push   (applies 20261011000000_weekly_queue_manual_schedule)
--   b. supabase functions deploy process-weekly-queue --no-verify-jwt
--      (required: the 'mode' body field is only understood by the new build)
--   c. The Vault secret `weekly_cron_secret` must already exist and match the
--      function's R_CRON_SECRET (set up by supabase/weekly-queue-setup.sql).
--      This script reuses that exact secret — it does not create a new one.
--
-- ─── Rollback ──────────────────────────────────────────────────────────────
--   select cron.unschedule('weekly-queue-manual-schedule');
--   This stops the manual-schedule runner only. The Thursday automation is
--   unaffected. Rows that already carry a scheduled_for simply fall back to
--   being picked up on the next Thursday fire (or the next 'scheduled_only'
--   fire, once re-added).
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Refuse to run without the shared secret — creating the job with a NULL header
-- would produce a job that only ever 401s.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'weekly_cron_secret'
  ) then
    raise exception
      'Vault secret weekly_cron_secret not found. Run supabase/weekly-queue-setup.sql first.';
  end if;
end
$$;

-- Idempotent: replaces only THIS job, under THIS name. The Thursday job
-- `weekly-new-contact-email` is never unscheduled here.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-queue-manual-schedule') then
    perform cron.unschedule('weekly-queue-manual-schedule');
  end if;

  perform cron.schedule(
    'weekly-queue-manual-schedule',
    -- Every 5 minutes, every day. 5 minutes is the finest interval the Weekly
    -- Queue "Send next batch after" control offers, so every selectable option
    -- is honoured exactly. Widening this (e.g. '*/15 * * * *') makes short
    -- batch intervals resolve later than the preview claims; it never causes
    -- sends to happen EARLIER than scheduled.
    '*/5 * * * *',
    $cron$
    select
      net.http_post(
        url := 'https://oscdtdlwdrwjvteqcix.supabase.co/functions/v1/process-weekly-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_cron_secret')
        ),
        -- The only difference from the Thursday job: this body carries a mode.
        body := '{"mode":"scheduled_only"}'::jsonb
      ) as request_id;
    $cron$
  );
end
$$;

-- ─── VERIFY: both jobs must be present, and the Thursday one must be intact ──
select jobid, jobname, schedule, active
from cron.job
where jobname in ('weekly-new-contact-email', 'weekly-queue-manual-schedule')
order by jobname;

-- Expected (exactly two rows):
--   weekly-new-contact-email    | */30 2-18 * * 4 | t   <-- UNCHANGED, still here
--   weekly-queue-manual-schedule | */5 * * * *     | t   <-- new, additive

-- ─── Smoke test the manual runner by hand (safe: it claims only due rows) ──
-- select
--   net.http_post(
--     url := 'https://oscdtdlwdrwjvteqcix.supabase.co/functions/v1/process-weekly-queue',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cron-secret',
--       (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_cron_secret')
--     ),
--     body := '{"mode":"scheduled_only"}'::jsonb
--   ) as request_id;
--
-- Then check what it saw:
--   select * from net._http_response order by created desc limit 3;
--   -- the JSON body has "mode":"scheduled_only" and a "claimed" count.
--   -- claimed = 0 simply means nothing is due yet — that is the healthy result
--   -- right after scheduling a batch for a future date.
--
-- ─── What each job claims (read-only inspection) ───────────────────────────
--   -- Automatic Thursday pool (scheduled_for IS NULL):
--   select count(*) from public.weekly_email_queue
--   where status = 'pending' and scheduled_for is null;
--
--   -- Manual pool, by due instant:
--   select to_char(scheduled_for at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as due_ist,
--          schedule_type, schedule_batch, count(*)
--   from public.weekly_email_queue
--   where status = 'pending' and scheduled_for is not null
--   group by 1, 2, 3 order by 1;
