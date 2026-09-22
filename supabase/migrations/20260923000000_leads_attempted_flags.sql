-- Persisted "fetch attempted" flags for the Lead Search table.
-- The Lead Search UI uses these to keep showing "Not Found" (instead of
-- re-offering "Find Phone") after a page refresh, once an email enrichment
-- or phone lookup has been attempted for a lead.
--
-- Idempotent: re-running this migration is a no-op.
alter table public.leads
  add column if not exists phone_attempted boolean not null default false,
  add column if not exists email_attempted boolean not null default false;