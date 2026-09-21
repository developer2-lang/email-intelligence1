-- Stage 1 (scrape-leads) persistence columns.
-- Idempotent: safe to run against the existing leads table.
-- (company_name, designation, role already added by 20260920000000_leads_search_persist.sql;
--  full_name, headline, location, linkedin_url exist in 20250918_create_leads_table.sql.)

alter table public.leads add column if not exists company_name text;
alter table public.leads add column if not exists designation text;
alter table public.leads add column if not exists role text;
alter table public.leads add column if not exists job_title text;
alter table public.leads add column if not exists geography text;
alter table public.leads add column if not exists industry text;