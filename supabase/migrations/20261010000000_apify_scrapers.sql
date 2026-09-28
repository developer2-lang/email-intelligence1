-- ============================================================================
-- Apify Scraper Links (new, additive)
-- ============================================================================
-- Stores the user's saved Apify scraper links so the new "Apify" sidebar page
-- can list / add / edit / delete them. This table is completely separate from
-- the existing lead-scraping flow (supabase/functions/scrape-leads) and does
-- NOT modify any existing table, column, or function.
--
-- name:        the label the user gives the scraper (e.g. "Profile Scraper")
-- url:         the Apify console / actor URL, e.g. https://apify.com/user/actor
-- description: optional free text
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL -> New query) or via the
-- CLI. Idempotent.

create table if not exists public.apify_scrapers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  url         text not null,
  description text null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- one row per Apify link: prevents duplicate scraper records
  unique (url)
);

-- ─── Row Level Security ─────────────────────────────────────────────────────
-- The React app talks to Supabase with the anon/publishable key, so the anon
-- role needs explicit access (mirrors the contact_lists policies). RLS is
-- enabled and opened to anon for every operation.

alter table public.apify_scrapers enable row level security;

drop policy if exists "apify_scrapers select" on public.apify_scrapers;
drop policy if exists "apify_scrapers insert" on public.apify_scrapers;
drop policy if exists "apify_scrapers update" on public.apify_scrapers;
drop policy if exists "apify_scrapers delete" on public.apify_scrapers;
create policy "apify_scrapers select" on public.apify_scrapers for select to anon using (true);
create policy "apify_scrapers insert" on public.apify_scrapers for insert to anon with check (true);
create policy "apify_scrapers update" on public.apify_scrapers for update to anon using (true) with check (true);
create policy "apify_scrapers delete" on public.apify_scrapers for delete to anon using (true);

-- ─── Keep updated_at fresh on every UPDATE ───────────────────────────────────
create or replace function public.set_apify_scrapers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists apify_scrapers_set_updated_at on public.apify_scrapers;
create trigger apify_scrapers_set_updated_at
  before update on public.apify_scrapers
  for each row
  execute function public.set_apify_scrapers_updated_at();

-- Make PostgREST pick up the new table immediately.
notify pgrst, 'reload schema';
