-- Persist search results into public.leads with UPSERT on linkedin_url.
-- Idempotent: safe to run against the existing leads table.

-- 1. Ensure columns used by scrape-leads exist (no-op if already added).
alter table public.leads add column if not exists company_name text;
alter table public.leads add column if not exists designation text;
alter table public.leads add column if not exists role text;

-- 2. De-duplicate existing rows (keep the first row per linkedin_url) so the
--    unique index can be created even on a table that already has duplicates.
delete from public.leads
where id in (
  select id from (
    select
      id,
      row_number() over (
        partition by linkedin_url
        order by created_at asc, id asc
      ) as rn
    from public.leads
  ) ranked
  where rn > 1
);

-- 3. Unique index on linkedin_url so ON CONFLICT ("linkedin_url") UPSERT works.
create unique index if not exists leads_linkedin_url_key
  on public.leads (linkedin_url);