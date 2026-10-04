-- ============================================================================
-- Company Master Table (public.lb_company_master)
-- ============================================================================
-- Source of truth for companies used by the Lead Generation company dropdown.
-- Safe and idempotent: creates table, unique constraint on normalized_name,
-- indexes, and RLS policies if not already present.

create table if not exists public.lb_company_master (
  id              bigint generated always as identity primary key,
  company_name    text not null,
  normalized_name text generated always as (lower(trim(company_name))) stored,
  created_at      timestamptz not null default now()
);

-- Unique constraint on normalized_name to prevent case-insensitive duplicates
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_master_normalized_name_unique'
  ) then
    alter table public.lb_company_master
      add constraint company_master_normalized_name_unique unique (normalized_name);
  end if;
end $$;

-- Indexes for fast lookup, filtering, and sorting
create index if not exists lb_company_master_normalized_name_idx
  on public.lb_company_master (normalized_name);

create index if not exists lb_company_master_company_name_idx
  on public.lb_company_master (company_name);

-- ─── Row Level Security ─────────────────────────────────────────────────────
alter table public.lb_company_master enable row level security;

-- Drop existing policies if any to recreate cleanly
drop policy if exists "lb_company_master_select_all" on public.lb_company_master;
drop policy if exists "lb_company_master_insert_all" on public.lb_company_master;

-- Allow read access to all users (anon and authenticated)
create policy "lb_company_master_select_all"
  on public.lb_company_master for select
  to public
  using (true);

-- Allow inserting non-empty company names
create policy "lb_company_master_insert_all"
  on public.lb_company_master for insert
  to public
  with check (length(trim(company_name)) > 0);

-- Notify PostgREST to reload schema
notify pgrst, 'reload schema';
