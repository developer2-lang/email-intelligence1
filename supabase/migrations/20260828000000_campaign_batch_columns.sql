-- Add batch-sending configuration columns to public.campaigns
-- Used by both Campaigns and Follow-up batching (the follow-up flow inserts
-- into public.campaigns with these columns). Matches the Campaigns batching
-- design in supabase/migrations/20260827000000_campaign_batches.sql.

ALTER TABLE "public"."campaigns"
    ADD COLUMN IF NOT EXISTS "send_in_batches" boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS "batch_size" integer DEFAULT 30,
    ADD COLUMN IF NOT EXISTS "first_batch_delay_hours" integer DEFAULT 2,
    ADD COLUMN IF NOT EXISTS "subsequent_batch_delay_hours" integer DEFAULT 1;
