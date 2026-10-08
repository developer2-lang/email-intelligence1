-- ============================================================================
-- scheduled-campaign-runner — FREE cloud scheduler setup (Supabase pg_cron)
-- ============================================================================
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query).
--
-- What it does:
--   1) Enables pg_net (HTTP requests from Postgres) and supabase_vault
--      (encrypted secrets) if they are not already enabled.
--   2) Creates a pg_cron job that fires EVERY MINUTE and POSTs to the
--      scheduled-campaign-runner Edge Function. That function finds campaigns
--      whose scheduled IST time has arrived and sends them directly to Gmail
--      SMTP — so a campaign goes out even when the laptop (local Node.js
--      backend) is completely OFF.
--   3) The POST carries the shared CRON_SECRET in the `x-cron-secret` header.
--      The secret is read from the Supabase Vault at run time, so it never
--      appears in this file or in git.
--
-- Order of operations:
--   a. Deploy the Edge Function:
--        supabase functions deploy scheduled-campaign-runner --no-verify-jwt
--   b. Set the function's secrets (same CRON_SECRET value as in step d):
--        supabase secrets set \
--          CRON_SECRET=<your-random-value> \
--          SMTP_HOST=smtp.gmail.com SMTP_PORT=465 \
--          SMTP_USER=you@gmail.com SMTP_PASSWORD=<app-password> \
--          SMTP_FROM_NAME="Rupali Sirsath" SMTP_FROM=you@gmail.com \
--          SMTP_REPLY_TO=you@gmail.com
--        (TRACKING_BASE_URL / EDGE_FUNCTION_URL are optional; leave unset.)
--   c. Run this file in the SQL editor.
--   d. Store the shared cron secret in the Vault ONCE (replace the value):
--        select vault.create_secret('<your-random-value>', 'scheduled_cron_secret');
--      NOTE: `scheduled_cron_secret` must equal the `CRON_SECRET` env secret
--      set on the Edge Function in step b, or the function rejects the call.
-- ============================================================================

-- 1) Enable extensions (no-ops when already enabled; pg_cron is on by default
--    for hosted Supabase projects).
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- 2) Create / replace the cron job. The job is idempotent: re-running this
--    script unschedules the previous job first, then schedules a fresh one.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'scheduled-campaign-runner-cron') then
    perform cron.unschedule('scheduled-campaign-runner-cron');
  end if;

  perform cron.schedule(
    'scheduled-campaign-runner-cron',
    '* * * * *', -- every minute
    $cron$
    select
      net.http_post(
        url := 'https://oscdtdlwdrwvjvteqcix.supabase.co/functions/v1/scheduled-campaign-runner',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_cron_secret')
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
where jobname = 'scheduled-campaign-runner-cron';

-- 4) (Optional) Manual smoke test — run the same POST the cron job would run:
--    select
--      net.http_post(
--        url := 'https://oscdtdlwdrwvjvteqcix.supabase.co/functions/v1/scheduled-campaign-runner',
--        headers := jsonb_build_object(
--          'Content-Type', 'application/json',
--          'x-cron-secret',
--          (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_cron_secret')
--        ),
--        body := '{}'::jsonb
--      ) as request_id;
--
--    Responses land in net._http_response; check the last run with:
--      select * from net._http_response order by created desc limit 3;
--
--    To stop scheduling entirely (keep the function deployed):
--      select cron.unschedule('scheduled-campaign-runner-cron');
