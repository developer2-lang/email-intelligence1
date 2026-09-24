-- ─── custom_filter_options ──────────────────────────────────────────────────
-- Stores user-added custom values for SearchableSelect dropdowns so they
-- persist across sessions (replaces the previous localStorage-only approach).
--
-- category: the logical group, e.g. 'designation' | 'industry' | 'geography' | 'role'
-- value:    the raw string the user typed in
-- user_id:  the authenticated user who added it (RLS enforced)

create table if not exists public.custom_filter_options (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  category    text not null,
  value       text not null,
  created_at  timestamptz not null default now(),

  -- one value per category per user (case-insensitive dedup is handled in app code)
  unique (user_id, category, value)
);

-- Row-Level Security: each user can only see and modify their own rows.
alter table public.custom_filter_options enable row level security;

create policy "custom_filter_options: select own"
  on public.custom_filter_options for select
  using (auth.uid() = user_id);

create policy "custom_filter_options: insert own"
  on public.custom_filter_options for insert
  with check (auth.uid() = user_id);

create policy "custom_filter_options: delete own"
  on public.custom_filter_options for delete
  using (auth.uid() = user_id);

-- Index for fast per-user per-category lookups
create index if not exists custom_filter_options_user_category_idx
  on public.custom_filter_options (user_id, category);
