-- Create leads table
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,
  email        text,
  phone        text,
  linkedin_url text not null,
  full_name    text,
  headline     text,
  location     text,
  source_query text,
  created_at   timestamptz not null default now(),
  unique (user_id, linkedin_url)
);

-- Index for fast per-user, most-recent-first queries
create index if not exists leads_user_created_idx
  on public.leads (user_id, created_at desc);

-- Enable Row Level Security
alter table public.leads enable row level security;

-- Drop old policies if they exist (safe re-run)
drop policy if exists "Users read own leads"   on public.leads;
drop policy if exists "Users insert own leads" on public.leads;
drop policy if exists "Users delete own leads" on public.leads;

-- Users can only see their own leads
create policy "Users read own leads"
  on public.leads for select
  using (auth.uid() = user_id);

-- Users can only insert leads for themselves
create policy "Users insert own leads"
  on public.leads for insert
  with check (auth.uid() = user_id);

-- Users can only delete their own leads
create policy "Users delete own leads"
  on public.leads for delete
  using (auth.uid() = user_id);