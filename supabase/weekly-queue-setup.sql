-- ============================================================================
-- process-weekly-queue — WEEKLY auto-email setup (Supabase pg_cron)
-- ============================================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- What it does:
--   1) Enables pg_net (HTTP requests from Postgres) and supabase_vault
--      (encrypted secrets) if they are not already enabled.
--   2) Creates / replaces the pg_cron job `weekly-new-contact-email` that
--      fires every WEDNESDAY at 08:30 UTC (= 02:00 PM IST) and POSTs to the
--      `process-weekly-queue` Edge Function. That function emails every NEW
--      contact queued by the contacts INSERT trigger (see migration
--      20260927000000_weekly_new_contact_automation.sql).
--   3) The POST carries the shared R_CRON_SECRET in the `x-cron-secret` header.
--      The secret is read from the Supabase Vault at run time, so it never
--      appears in this file or in git.
--
-- Prerequisites:
--   a. Apply the migration (creates weekly_email_queue + the trigger):
--        supabase db push
--   b. Deploy the Edge Function WITHOUT JWT verification (the cron POST has no
--      Authorization header — the function authenticates via x-cron-secret):
--        supabase functions deploy process-weekly-queue --no-verify-jwt
--   c. Set the function's secrets (same R_CRON_SECRET value as in step e),
--      plus the optional template overrides and the existing SMTP secrets:
--        supabase secrets set \
--          R_CRON_SECRET=<your-random-value> \
--          R_EMAIL_HOST=smtp.gmail.com R_EMAIL_PORT=465 \
--          R_EMAIL_USER=you@gmail.com R_EMAIL_PASSWORD=<app-password> \
--          R_EMAIL_FROM_NAME="Rupali Sirsath" R_EMAIL_FROM=you@gmail.com \
--          R_EMAIL_REPLY_TO=you@gmail.com
--        Optional (template resolution — falls back to a template named
--        like "Welcome", then to a built-in message if unset):
--          WELCOME_TEMPLATE_ID=<templates.id> \
--          WELCOME_SUBJECT="Welcome, {{first_name}}!"
--   d. Run this file in the SQL editor.
--   e. Store the cron secret in the Vault ONCE (replace the value):
--        select vault.create_secret('<your-random-value>', 'weekly_cron_secret');
--      NOTE: `weekly_cron_secret` must equal the `R_CRON_SECRET` env secret set
--      on the Edge Function in step c, or the function rejects the call.
-- ============================================================================

-- 1) Enable extensions (no-ops when already enabled; pg_cron is on by default
--    for hosted Supabase projects).
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- 2) Create / replace the cron job. The job is idempotent: re-running this
--    script unschedules the previous job first, then schedules a fresh one
--    under the SAME name the live project already uses (job 41,
--    `weekly-new-contact-email`). Never create a second weekly job.
--    Schedule: '30 8 * * 3' = Wednesday 08:30 UTC = Wednesday 02:00 PM IST.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-new-contact-email') then
    perform cron.unschedule('weekly-new-contact-email');
  end if;

  perform cron.schedule(
    'weekly-new-contact-email',
    '30 8 * * 3', -- Wednesday 08:30 UTC (= 02:00 PM IST)
    $cron$
    select
      net.http_post(
        url := 'https://oscdtdlwdrwjvteqcix.supabase.co/functions/v1/process-weekly-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
    $cron$
  );
end
$$;

-- 3) Confirm the job is registered.
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'weekly-new-contact-email';

-- 4) (Optional) Manual smoke test — run the same POST the cron job would run.
--    Re-run it any time to drain the backlog faster than the weekly cadence:
--    select
--      net.http_post(
--        url := 'https://oscdtdlwdrwjvteqcix.supabase.co/functions/v1/process-weekly-queue',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'x-cron-secret',
--          (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_cron_secret')
--        ),
--        body := '{}'::jsonb
--      ) as request_id;
--
--    Responses land in net._http_response; check the last run with:
--      select * from net._http_response order by created desc limit 3;
--
-- 5) Inspect the queue from SQL:
--      select status, count(*) from public.weekly_email_queue group by status;
--      select * from public.weekly_email_queue order by queued_at desc limit 50;
--
--    To stop scheduling entirely (keep the function deployed):
--      select cron.unschedule('weekly-new-contact-email');