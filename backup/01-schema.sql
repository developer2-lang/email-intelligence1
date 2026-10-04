


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'moderator',
    'user'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid") RETURNS TABLE("completed_at" timestamp with time zone, "current_batch_number" integer, "next_batch_at" timestamp with time zone)
    LANGUAGE "plpgsql"
    AS $$
begin
  if not exists (
    select 1 from public.sequence_step_batch_state
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  ) then
    return;
  end if;
  update public.sequence_step_batch_state set
    completed_at = now(),
    next_batch_at = null,
    updated_at = now()
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  returning completed_at, current_batch_number, next_batch_at
  into completed_at, current_batch_number, next_batch_at;
  return next;
end;
$$;


ALTER FUNCTION "public"."complete_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_batch_enabled" boolean, "p_first_delay" double precision, "p_subsequent_delay" double precision) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
begin
  insert into public.sequence_step_batch_state (
    sequence_id,
    sequence_step_id,
    batch_size,
    batch_enabled,
    first_batch_delay_hours,
    subsequent_batch_delay_hours,
    current_batch_number,
    batch_sent,
    next_batch_at,
    completed_at,
    updated_at
  ) values (
    p_sequence_id,
    p_sequence_step_id,
    greatest(1, coalesce(p_batch_size, 30)),
    coalesce(p_batch_enabled, true),
    greatest(0, coalesce(p_first_delay, 1)),
    greatest(0, coalesce(p_subsequent_delay, 1)),
    0,
    0,
    -- First-batch delay: when configured, arm next_batch_at so the runner's
    -- gate defers every enrollment until the first batch window opens. A zero
    -- delay opens batch 1 immediately (legacy-ish behaviour).
    case
      when coalesce(p_batch_enabled, true) and coalesce(p_first_delay, 1) > 0
      then now() + make_interval(secs => coalesce(p_first_delay, 1) * 3600)
      else null
    end,
    null,
    now()
  )
  on conflict (sequence_id, sequence_step_id) do update set
    batch_size = greatest(1, coalesce(p_batch_size, 30)),
    batch_enabled = coalesce(p_batch_enabled, true),
    first_batch_delay_hours = greatest(0, coalesce(p_first_delay, 1)),
    subsequent_batch_delay_hours = greatest(0, coalesce(p_subsequent_delay, 1)),
    -- Preserve in-flight progress (counting / window markers) on a pure
    -- config refresh — never silently reset a partially-sent queue.
    updated_at = now();
  return 1;
end;
$$;


ALTER FUNCTION "public"."create_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_batch_enabled" boolean, "p_first_delay" double precision, "p_subsequent_delay" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_lead_contact_sync"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if old.linkedin_url is not null then
    delete from public.contacts
    where contact_type = 'lead search'
      and linkedin_url = old.linkedin_url;
  end if;
  return old;
end;
$$;


ALTER FUNCTION "public"."delete_lead_contact_sync"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_sequence_batch_count"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_next_delay_hours" double precision) RETURNS TABLE("sent" integer, "batch_number" integer, "next_batch_at" timestamp with time zone, "scheduled" boolean)
    LANGUAGE "plpgsql"
    AS $$
declare
  v_state public.sequence_step_batch_state%rowtype;
  v_delay double precision;
  v_now timestamptz := now();
begin
  -- Lazily create the queue if it does not exist (defensive; the runner calls
  -- create_sequence_batch_state explicitly on activation / step creation).
  if not exists (
    select 1 from public.sequence_step_batch_state
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  ) then
    insert into public.sequence_step_batch_state (
      sequence_id, sequence_step_id, batch_size, batch_enabled,
      first_batch_delay_hours, subsequent_batch_delay_hours,
      current_batch_number, batch_sent, updated_at
    ) values (
      p_sequence_id, p_sequence_step_id,
      greatest(1, coalesce(p_batch_size, 30)), true,
      coalesce(p_next_delay_hours, 1), coalesce(p_next_delay_hours, 1),
      0, 0, v_now
    );
  end if;

  select * into v_state
  from public.sequence_step_batch_state
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id
  for update;

  if v_state.completed_at is not null then
    next_batch_at := null;
    scheduled := false;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  if v_state.current_batch_number = 0 then
    -- First batch ever: opens immediately; the caller's already-processed
    -- enrollment is the first send (batch 1 count 1, no pending window).
    v_state.current_batch_number := 1;
    v_state.batch_sent := 1;
    v_state.next_batch_at := null;
    v_state.updated_at := v_now;
    update public.sequence_step_batch_state set
      current_batch_number = 1,
      batch_sent = 1,
      next_batch_at = null,
      completed_at = null,
      updated_at = v_now
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
    next_batch_at := null;
    scheduled := false;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  -- An existing batch: record one send. If a previous batch had rolled but its
  -- window is now open (next_batch_at in the past), the window marker is
  -- cleared so the UI shows in-progress instead of a stale "next batch" time.
  if v_state.next_batch_at is not null and v_state.next_batch_at <= v_now then
    v_state.next_batch_at := null;
  end if;
  v_state.batch_sent := v_state.batch_sent + 1;

  -- When the current window fills, roll into the NEXT batch: reset the count
  -- and physically schedule the next window (next_batch_at = now + delay). The
  -- caller sees scheduled=true and must defer further enrollments until that
  -- time — the cron keeps firing, but the destinations are not due again until
  -- next_batch_at, so a cloud schedule (never a browser/laptop timer) paces
  -- each step's batches.
  if v_state.batch_sent >= greatest(1, v_state.batch_size) then
    v_delay := coalesce(p_next_delay_hours, v_state.subsequent_batch_delay_hours);
    v_state.current_batch_number := v_state.current_batch_number + 1;
    v_state.batch_sent := 0;
    v_state.next_batch_at := v_now + make_interval(secs => greatest(0, v_delay) * 3600);
    v_state.updated_at := v_now;
    update public.sequence_step_batch_state set
      current_batch_number = v_state.current_batch_number,
      batch_sent = 0,
      next_batch_at = v_state.next_batch_at,
      updated_at = v_now
    where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
    next_batch_at := v_state.next_batch_at;
    scheduled := true;
    sent := v_state.batch_sent;
    batch_number := v_state.current_batch_number;
    return next;
  end if;

  v_state.updated_at := v_now;
  update public.sequence_step_batch_state set
    batch_sent = v_state.batch_sent,
    next_batch_at = v_state.next_batch_at,
    completed_at = null,
    updated_at = v_now
  where sequence_id = p_sequence_id and sequence_step_id = p_sequence_step_id;
  next_batch_at := v_state.next_batch_at;
  scheduled := false;
  sent := v_state.batch_sent;
  batch_number := v_state.current_batch_number;
  return next;
end;
$$;


ALTER FUNCTION "public"."increment_sequence_batch_count"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_next_delay_hours" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lb_touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


ALTER FUNCTION "public"."lb_touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_contact_for_weekly_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text;
begin
  v_email := nullif(trim(coalesce(new.email, '')), '');

  if v_email is null then
    return new;
  end if;

  if exists (
    select 1 from public.weekly_email_queue wq
    where wq.email is not null
      and lower(trim(wq.email)) = lower(v_email)
  ) then
    return new;
  end if;

  begin
    insert into public.weekly_email_queue
      (contact_id, email, full_name, company, designation, industry, status)
    values
      (new.id::text, new.email, coalesce(new.full_name, ''), new.company,
       new.designation, coalesce(new.industry, ''), 'pending')
    on conflict (contact_id) do nothing;
  exception
    when unique_violation then
      null;
  end;

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_contact_for_weekly_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_lead_for_weekly_email"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text;
begin
  -- Normalize email
  v_email := nullif(trim(coalesce(new.email, '')), '');

  -- Skip if no email
  if v_email is null then
    return new;
  end if;

  -- Skip if already queued (dedupe by email)
  if exists (
    select 1 from public.weekly_email_queue wq
    where wq.email is not null
      and lower(trim(wq.email)) = lower(v_email)
  ) then
    return new;
  end if;

  -- Insert into weekly queue
  begin
    insert into public.weekly_email_queue
      (contact_id, email, full_name, company, designation, industry, status, queued_at)
    values
      ('lead-' || new.id::text,
       v_email,
       coalesce(new.full_name, ''),
       new.company_name,
       new.designation,
       new.industry,
       'pending',
       now());
  exception
    when unique_violation then
      -- Ignore duplicates gracefully (email unique index or contact_id race)
      null;
  end;

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_lead_for_weekly_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  UPDATE email_logs
  SET clicked = true, clicked_at = NOW()
  WHERE id = v_log.id AND clicked = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate click: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 0, 1,
    0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    clicked          = campaign_analytics.clicked + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    click_rate       = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.clicked + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;


ALTER FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_log       RECORD;
  v_total     INTEGER;
  v_delivered INTEGER;
BEGIN
  SELECT * INTO v_log FROM email_logs WHERE tracking_id = p_tracking_id LIMIT 1;
  IF v_log.id IS NULL THEN
    RETURN; -- unknown tracking id: nothing to record
  END IF;

  -- NOTE: no sent_at grace filter here. Gmail's image proxy / Outlook prefetch
  -- request each pixel URL exactly ONCE seconds after delivery and then serve
  -- the cached image to the human later, so that first request is the only
  -- chance to record the open. Counting the prefetch as an open is the
  -- industry standard (every ESP does it). A grace filter would silently lose
  -- every Gmail/Outlook open.

  UPDATE email_logs
  SET opened = true, opened_at = NOW()
  WHERE id = v_log.id AND opened = false;

  IF NOT FOUND THEN
    RETURN; -- duplicate open: already counted
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'sent')
    INTO v_total, v_delivered
  FROM email_logs
  WHERE campaign_id = v_log.campaign_id;

  INSERT INTO campaign_analytics
    (campaign_id, total_recipients, delivered, opened, clicked, open_rate, click_rate)
  VALUES (
    v_log.campaign_id, v_total, v_delivered, 1, 0,
    CASE WHEN v_delivered > 0 THEN ROUND((1::numeric / v_delivered) * 100, 1) ELSE 0 END,
    0
  )
  ON CONFLICT (campaign_id) DO UPDATE SET
    opened           = campaign_analytics.opened + 1,
    total_recipients = EXCLUDED.total_recipients,
    delivered        = EXCLUDED.delivered,
    open_rate        = CASE WHEN EXCLUDED.delivered > 0
                            THEN ROUND(((campaign_analytics.opened + 1)::numeric / EXCLUDED.delivered) * 100, 1)
                            ELSE 0 END;
END;
$$;


ALTER FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_apify_scrapers_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_apify_scrapers_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_lead_email_update_to_contact"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_url   text := nullif(trim(coalesce(NEW.linkedin_url, '')), '');
  v_email text := nullif(trim(coalesce(NEW.email,        '')), '');
  v_name  text := coalesce(nullif(trim(coalesce(NEW.full_name,    '')), ''), '');
  v_co    text := coalesce(nullif(trim(coalesce(NEW.company_name, '')), ''), '');
BEGIN
  IF current_setting('app.skip_lead_to_contact', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Only trigger if the lead now has a valid email and it is new/changed
  IF v_email IS NOT NULL AND (OLD.email IS NULL OR trim(OLD.email) = '' OR OLD.email IS DISTINCT FROM NEW.email) THEN
    IF v_url IS NOT NULL THEN
      INSERT INTO public.contacts
        (full_name, email, company, designation, industry, geography,
         role, job_title, phone, contact_type, company_category, linkedin_url)
      VALUES
        (v_name, v_email, v_co,
         NEW.designation, NEW.industry, NEW.geography,
         NEW.role, NEW.job_title, NEW.phone,
         'lead search', 'lead search', v_url)
      ON CONFLICT (linkedin_url) DO UPDATE
        SET email = EXCLUDED.email,
            full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.contacts.full_name),
            company = COALESCE(NULLIF(EXCLUDED.company, ''), public.contacts.company);
    ELSE
      INSERT INTO public.contacts
        (full_name, email, company, designation, industry, geography,
         role, job_title, phone, contact_type, company_category, linkedin_url)
      SELECT
        v_name, v_email, v_co,
        NEW.designation, NEW.industry, NEW.geography,
        NEW.role, NEW.job_title, NEW.phone,
        'lead search', 'lead search', NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE lower(trim(c.email)) = lower(v_email)
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_lead_email_update_to_contact"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_lead_insert_to_contact"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_url   text := nullif(trim(coalesce(NEW.linkedin_url, '')), '');
  v_email text := nullif(trim(coalesce(NEW.email,        '')), '');
  v_name  text := coalesce(nullif(trim(coalesce(NEW.full_name,    '')), ''), '');
  v_co    text := coalesce(nullif(trim(coalesce(NEW.company_name, '')), ''), '');
BEGIN
  IF current_setting('app.skip_lead_to_contact', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- CRITICAL REQUIREMENT: If email is missing, do NOT mirror into contacts.
  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_url IS NOT NULL THEN
    INSERT INTO public.contacts
      (full_name, email, company, designation, industry, geography,
       role, job_title, phone, contact_type, company_category, linkedin_url)
    VALUES
      (v_name, v_email, v_co,
       NEW.designation, NEW.industry, NEW.geography,
       NEW.role, NEW.job_title, NEW.phone,
       'lead search', 'lead search', v_url)
    ON CONFLICT (linkedin_url) DO UPDATE
      SET email = EXCLUDED.email,
          full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public.contacts.full_name),
          company = COALESCE(NULLIF(EXCLUDED.company, ''), public.contacts.company);

  ELSE
    INSERT INTO public.contacts
      (full_name, email, company, designation, industry, geography,
       role, job_title, phone, contact_type, company_category, linkedin_url)
    SELECT
      v_name, v_email, v_co,
      NEW.designation, NEW.industry, NEW.geography,
      NEW.role, NEW.job_title, NEW.phone,
      'lead search', 'lead search', NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE lower(trim(c.email)) = lower(v_email)
    );
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_lead_insert_to_contact"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_email_logs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_email_logs_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."teammember" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "role" "text",
    "image" "text"
);


ALTER TABLE "public"."teammember" OWNER TO "postgres";


ALTER TABLE "public"."teammember" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."Teammember_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."acc_bills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ref_num" "text" NOT NULL,
    "vendor_bill_num" "text",
    "vendor_id" "uuid",
    "project_id" "uuid",
    "category" "text",
    "bill_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date",
    "subject" "text",
    "line_items" "jsonb" DEFAULT '[]'::"jsonb",
    "sub_total" numeric(14,2) DEFAULT 0,
    "gst_type" "text" DEFAULT 'none'::"text",
    "gst_custom_rate" numeric(5,2),
    "gst_amount" numeric(14,2) DEFAULT 0,
    "gross_total" numeric(14,2) DEFAULT 0,
    "tds_section" "text" DEFAULT 'none'::"text",
    "tds_rate" numeric(5,2),
    "tds_amount" numeric(14,2) DEFAULT 0,
    "net_payable" numeric(14,2) DEFAULT 0,
    "itc_claimable" numeric(14,2) DEFAULT 0,
    "status" "text" DEFAULT 'draft'::"text",
    "paid_amount" numeric(14,2) DEFAULT 0,
    "payments" "jsonb" DEFAULT '[]'::"jsonb",
    "notes" "text",
    "received_via" "text" DEFAULT 'email'::"text",
    "po_ref" "text",
    "approval_status" "text" DEFAULT 'pending'::"text",
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_bills_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending-approval'::"text", 'approved'::"text", 'partial'::"text", 'paid'::"text", 'overdue'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."acc_bills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_person" "text",
    "email" "text",
    "phone" "text",
    "client_type" "text" DEFAULT 'domestic'::"text",
    "currency" "text" DEFAULT 'INR'::"text",
    "state" "text" DEFAULT 'MH'::"text",
    "gstin" "text",
    "pan" "text",
    "address" "text",
    "place_of_supply" "text" DEFAULT 'Maharashtra (27)'::"text",
    "website" "text",
    "notes" "text",
    "tc_ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_clients_client_type_check" CHECK (("client_type" = ANY (ARRAY['domestic'::"text", 'international'::"text"])))
);


ALTER TABLE "public"."acc_clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "doc_type" "text" NOT NULL,
    "doc_num" "text" NOT NULL,
    "client_id" "uuid",
    "project_id" "uuid",
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expiry_date" "date",
    "due_date" "date",
    "subject" "text",
    "place_of_supply" "text" DEFAULT 'Maharashtra (27)'::"text",
    "gst_type" "text" DEFAULT 'cgst-sgst'::"text",
    "gst_custom_rate" numeric(5,2),
    "line_items" "jsonb" DEFAULT '[]'::"jsonb",
    "sub_total" numeric(14,2) DEFAULT 0,
    "gst_amount" numeric(14,2) DEFAULT 0,
    "total" numeric(14,2) DEFAULT 0,
    "status" "text" DEFAULT 'draft'::"text",
    "notes" "text",
    "terms_conditions" "text",
    "internal_notes" "text",
    "po_number" "text",
    "usd_equivalent" numeric(14,2),
    "payments" "jsonb" DEFAULT '[]'::"jsonb",
    "tc_ref" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['quotation'::"text", 'pi'::"text", 'invoice'::"text", 'credit'::"text"]))),
    CONSTRAINT "acc_documents_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'approved'::"text", 'expired'::"text", 'cancelled'::"text", 'partial'::"text", 'paid'::"text", 'overdue'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."acc_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "follow_type" "text" DEFAULT 'payment'::"text",
    "due_date" "date" NOT NULL,
    "project_id" "uuid",
    "invoice_id" "uuid",
    "note" "text" NOT NULL,
    "method" "text" DEFAULT 'email'::"text",
    "assignee" "text" DEFAULT 'Rupali'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_followups_follow_type_check" CHECK (("follow_type" = ANY (ARRAY['payment'::"text", 'po'::"text", 'approval'::"text", 'other'::"text"]))),
    CONSTRAINT "acc_followups_method_check" CHECK (("method" = ANY (ARRAY['email'::"text", 'phone'::"text", 'whatsapp'::"text", 'meeting'::"text"]))),
    CONSTRAINT "acc_followups_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'done'::"text"])))
);


ALTER TABLE "public"."acc_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_payments_out" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pay_ref" "text" NOT NULL,
    "vendor_id" "uuid",
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "bill_ids" "jsonb" DEFAULT '[]'::"jsonb",
    "gross_amount" numeric(14,2) DEFAULT 0,
    "tds_deducted" numeric(14,2) DEFAULT 0,
    "net_transferred" numeric(14,2) DEFAULT 0,
    "tds_section" "text" DEFAULT 'none'::"text",
    "payment_mode" "text" DEFAULT 'neft'::"text",
    "utr_reference" "text",
    "bank_account" "text" DEFAULT 'bharat-coop'::"text",
    "cheque_number" "text",
    "notes" "text",
    "status" "text" DEFAULT 'processed'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_payments_out_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'processed'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."acc_payments_out" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "client_id" "uuid",
    "stage" "text" DEFAULT 'draft'::"text",
    "value" numeric(14,2) DEFAULT 0,
    "invoiced" numeric(14,2) DEFAULT 0,
    "collected" numeric(14,2) DEFAULT 0,
    "tc_ref" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_projects_stage_check" CHECK (("stage" = ANY (ARRAY['draft'::"text", 'quotation-sent'::"text", 'po-received'::"text", 'active'::"text", 'invoicing'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."acc_projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_settings" (
    "id" "text" DEFAULT 'default'::"text" NOT NULL,
    "company_name" "text" DEFAULT 'IUOVA'::"text",
    "gstin" "text" DEFAULT '27AZRPG7489B2ZV'::"text",
    "address" "text" DEFAULT 'off 504, Filix Tower, L.B.S Rd, Bhandup West.'::"text",
    "city" "text" DEFAULT 'Mumbai'::"text",
    "pin" "text" DEFAULT '400078'::"text",
    "state" "text" DEFAULT 'Maharashtra'::"text",
    "country" "text" DEFAULT 'India'::"text",
    "phone" "text" DEFAULT '8369083208'::"text",
    "email" "text" DEFAULT 'info@iuovadesign.com'::"text",
    "website" "text" DEFAULT 'iuovadesign.com'::"text",
    "signatory_name" "text" DEFAULT 'Vatsal Gudhaka'::"text",
    "signatory_designation" "text" DEFAULT 'Founder & Director'::"text",
    "bank_name" "text" DEFAULT 'Bharat Co-Operative Bank'::"text",
    "bank_branch" "text" DEFAULT 'Mulund (West)'::"text",
    "bank_account_name" "text" DEFAULT 'IUOVA'::"text",
    "bank_account_no" "text" DEFAULT '005212100004508'::"text",
    "bank_ifsc" "text" DEFAULT 'BCBM0000053'::"text",
    "bank_swift" "text" DEFAULT 'BCMLINBB'::"text",
    "bank_cert_text" "text",
    "cgst_rate" numeric(5,2) DEFAULT 9,
    "sgst_rate" numeric(5,2) DEFAULT 9,
    "igst_rate" numeric(5,2) DEFAULT 18,
    "igst_export_rate" numeric(5,2) DEFAULT 0,
    "state_code" "text" DEFAULT '27'::"text",
    "quot_prefix" "text" DEFAULT 'IPDC2026-'::"text",
    "quot_next_num" integer DEFAULT 1,
    "pi_prefix" "text" DEFAULT 'PI'::"text",
    "pi_next_num" integer DEFAULT 146,
    "inv_format" "text" DEFAULT 'IUOVA-INV-{YEAR}-{NUM}'::"text",
    "inv_next_num" integer DEFAULT 1,
    "bill_prefix" "text" DEFAULT 'BILL-'::"text",
    "bill_next_num" integer DEFAULT 1,
    "pout_prefix" "text" DEFAULT 'PAY-'::"text",
    "pout_next_num" integer DEFAULT 1,
    "cn_prefix" "text" DEFAULT 'CN-'::"text",
    "cn_next_num" integer DEFAULT 1,
    "po_format" "text" DEFAULT 'PO-{YEAR}-{NUM}'::"text",
    "po_next_num" integer DEFAULT 1,
    "tc_domestic" "text" DEFAULT '1. Payment Terms: 50% advance, 30% at design freeze, 20% on delivery.
2. Delivery timelines are subject to client approvals.
3. IUOVA retains IP until full payment is received.'::"text",
    "tc_international" "text" DEFAULT '1. Payment Terms: 100% advance via wire transfer.
2. Delivery timelines are subject to client approvals.'::"text",
    "approval_threshold" numeric(14,2) DEFAULT 25000,
    "vendor_default_pay_terms" integer DEFAULT 30,
    "tds_194c_ind" numeric(5,2) DEFAULT 1,
    "tds_194c_co" numeric(5,2) DEFAULT 2,
    "tds_194j" numeric(5,2) DEFAULT 10,
    "tds_194i" numeric(5,2) DEFAULT 10,
    "tan_number" "text",
    "signature_data" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."acc_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."acc_vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "vendor_type" "text" DEFAULT 'company'::"text",
    "contact_person" "text",
    "email" "text",
    "phone" "text",
    "state" "text" DEFAULT 'MH'::"text",
    "website" "text",
    "address" "text",
    "status" "text" DEFAULT 'active'::"text",
    "rating" integer DEFAULT 0,
    "bank_name" "text",
    "bank_branch" "text",
    "account_name" "text",
    "account_no" "text",
    "ifsc" "text",
    "account_type" "text" DEFAULT 'current'::"text",
    "upi_id" "text",
    "gstin" "text",
    "pan" "text",
    "gst_reg_type" "text" DEFAULT 'regular'::"text",
    "itc_eligible" "text" DEFAULT 'yes'::"text",
    "tds_section" "text" DEFAULT 'none'::"text",
    "tds_rate" numeric(5,2),
    "payment_terms" integer DEFAULT 30,
    "preferred_pay_mode" "text" DEFAULT 'neft'::"text",
    "notes" "text",
    "tags" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "acc_vendors_category_check" CHECK (("category" = ANY (ARRAY['prototyping'::"text", 'freelancer'::"text", 'materials'::"text", 'software'::"text", 'travel'::"text", 'office'::"text", 'professional'::"text", 'marketing'::"text", 'logistics'::"text", 'misc'::"text"]))),
    CONSTRAINT "acc_vendors_itc_eligible_check" CHECK (("itc_eligible" = ANY (ARRAY['yes'::"text", 'no'::"text", 'maybe'::"text"]))),
    CONSTRAINT "acc_vendors_rating_check" CHECK ((("rating" >= 0) AND ("rating" <= 5))),
    CONSTRAINT "acc_vendors_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"]))),
    CONSTRAINT "acc_vendors_vendor_type_check" CHECK (("vendor_type" = ANY (ARRAY['company'::"text", 'individual'::"text", 'proprietor'::"text"])))
);


ALTER TABLE "public"."acc_vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_panel" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "text",
    "password" "text",
    "role" "text",
    "permission" "text"
);


ALTER TABLE "public"."admin_panel" OWNER TO "postgres";


ALTER TABLE "public"."admin_panel" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."admin_panel_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."apify_scrapers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "url" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."apify_scrapers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audience_segments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audience_segments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_analytics" (
    "campaign_id" "uuid" NOT NULL,
    "total_recipients" integer DEFAULT 0 NOT NULL,
    "delivered" integer DEFAULT 0 NOT NULL,
    "opened" integer DEFAULT 0 NOT NULL,
    "clicked" integer DEFAULT 0 NOT NULL,
    "open_rate" numeric(5,1) DEFAULT 0 NOT NULL,
    "click_rate" numeric(5,1) DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."campaign_analytics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "file_size" bigint DEFAULT 0 NOT NULL,
    "storage_bucket" "text" DEFAULT 'campaign-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."campaign_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid",
    "contact_id" "uuid",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."campaign_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_followup_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "opened_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."campaign_followup_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "trigger_type" character varying(30) DEFAULT 'opened'::character varying NOT NULL,
    "followup_mode" character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_followup_mode" CHECK ((("followup_mode")::"text" = ANY (ARRAY[('automatic'::character varying)::"text", ('manual'::character varying)::"text"]))),
    CONSTRAINT "chk_trigger_type" CHECK ((("trigger_type")::"text" = ANY (ARRAY[('opened'::character varying)::"text", ('clicked'::character varying)::"text", ('not_opened'::character varying)::"text"])))
);


ALTER TABLE "public"."campaign_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "schedule_type" character varying(20) NOT NULL,
    "start_date" "date",
    "send_time" time without time zone,
    "repeat_interval" integer DEFAULT 1,
    "weekly_days" "text",
    "monthly_type" character varying(20),
    "day_of_month" integer,
    "week_number" character varying(10),
    "weekday" character varying(10),
    "timezone" character varying(50) DEFAULT 'Asia/Kolkata'::character varying,
    "next_run" timestamp without time zone,
    "last_run" timestamp without time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_schedules_monthly_type_check" CHECK ((("monthly_type")::"text" = ANY (ARRAY[('day_of_month'::character varying)::"text", ('weekday'::character varying)::"text"]))),
    CONSTRAINT "campaign_schedules_schedule_type_check" CHECK ((("schedule_type")::"text" = ANY (ARRAY[('one_time'::character varying)::"text", ('weekly'::character varying)::"text", ('monthly'::character varying)::"text"]))),
    CONSTRAINT "campaign_schedules_week_number_check" CHECK ((("week_number")::"text" = ANY (ARRAY[('First'::character varying)::"text", ('Second'::character varying)::"text", ('Third'::character varying)::"text", ('Fourth'::character varying)::"text", ('Last'::character varying)::"text"]))),
    CONSTRAINT "campaign_schedules_weekday_check" CHECK ((("weekday")::"text" = ANY (ARRAY[('Monday'::character varying)::"text", ('Tuesday'::character varying)::"text", ('Wednesday'::character varying)::"text", ('Thursday'::character varying)::"text", ('Friday'::character varying)::"text", ('Saturday'::character varying)::"text", ('Sunday'::character varying)::"text"])))
);


ALTER TABLE "public"."campaign_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."campaign_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_name" "text" NOT NULL,
    "subject_line" "text" NOT NULL,
    "from_name" "text" NOT NULL,
    "audience_segment" "text",
    "campaign_type" "text",
    "schedule_date" timestamp with time zone,
    "schedule_time" time without time zone,
    "email_body" "text",
    "template_name" "text",
    "status" "text" DEFAULT 'Draft'::"text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "html_content" "text",
    "mailchimp_campaign_id" "text",
    "recipient_count" integer,
    "sent_at" timestamp with time zone,
    "scheduled_at" timestamp with time zone,
    "schedule_text" "text",
    "template_id" "uuid",
    "batch_enabled" boolean DEFAULT false NOT NULL,
    "batch_size" integer DEFAULT 30 NOT NULL,
    "batch_interval_minutes" integer DEFAULT 60 NOT NULL,
    "current_batch_number" integer DEFAULT 0 NOT NULL,
    "total_batches" integer,
    "next_batch_at" timestamp with time zone,
    "send_in_batches" boolean DEFAULT false,
    "first_batch_delay_hours" double precision DEFAULT 2,
    "subsequent_batch_delay_hours" double precision DEFAULT 1
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."case_studies" (
    "id" "text" NOT NULL,
    "title" "text",
    "slug" "text",
    "feature_image" "text",
    "client_name" "text",
    "gallery_images" "jsonb",
    "is_published" boolean,
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "product_name" "text",
    "product_no" smallint,
    "color" "text",
    "launch_date" integer,
    "usp" "text"
);


ALTER TABLE "public"."case_studies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_video" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "video_url" "text",
    "company" "text",
    "role" "text",
    "name" "text",
    "thumbnail_url" "text"
);


ALTER TABLE "public"."client_video" OWNER TO "postgres";


ALTER TABLE "public"."client_video" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."client_video_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."company_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."company_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."company_sizes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."company_sizes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact" (
    "id" character varying(255) NOT NULL,
    "name" character varying(255) DEFAULT '—'::character varying NOT NULL,
    "email" character varying(255) NOT NULL,
    "company" character varying(255) DEFAULT '—'::character varying,
    "designation" character varying(255) DEFAULT '—'::character varying,
    "industry" character varying(255) DEFAULT '—'::character varying,
    "type" character varying(100) DEFAULT 'New Lead'::character varying,
    "category" character varying(100) DEFAULT 'Domestic'::character varying,
    "city" character varying(255) DEFAULT '—'::character varying,
    "last_contacted" character varying(100) DEFAULT '—'::character varying,
    "notes" "text" DEFAULT '—'::"text",
    "engagement" integer DEFAULT 0,
    "enriched" boolean DEFAULT false,
    "phone" character varying(100) DEFAULT ''::character varying,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "email_opened" boolean DEFAULT false
);


ALTER TABLE "public"."contact" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_list_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_list_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_lists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contact_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text",
    "company" "text" NOT NULL,
    "designation" "text",
    "industry" "text",
    "city" "text",
    "contact_type" "text",
    "company_category" "text",
    "notes" "text",
    "score" integer DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"(),
    "email_opened" boolean DEFAULT false NOT NULL,
    "linkedin_url" "text",
    "phone" "text",
    "geography" "text",
    "role" "text",
    "job_title" "text"
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contacts_backup_20260923" (
    "id" "uuid",
    "full_name" "text",
    "email" "text",
    "company" "text",
    "designation" "text",
    "industry" "text",
    "city" "text",
    "contact_type" "text",
    "company_category" "text",
    "notes" "text",
    "score" integer,
    "created_at" timestamp without time zone,
    "updated_at" timestamp without time zone,
    "email_opened" boolean,
    "linkedin_url" "text",
    "phone" "text",
    "geography" "text",
    "role" "text",
    "job_title" "text"
);


ALTER TABLE "public"."contacts_backup_20260923" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contest_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "contest_id" "uuid",
    "participant_name" "text",
    "participant_email" "text",
    "participant_phone" "text",
    "participant_college" "text",
    "participant_city" "text",
    "portfolio_url" "text",
    "linkedin_url" "text",
    "submission_title" "text",
    "submission_description" "text",
    "submission_link" "text",
    "is_winner" boolean DEFAULT false,
    "score" numeric,
    "feedback" "text",
    "mail_sent" "text"
);


ALTER TABLE "public"."contest_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contests" (
    "id" "text" NOT NULL,
    "title" "text",
    "slug" "text",
    "subtitle" "text",
    "description" "text",
    "brief_details" "text",
    "category" "text",
    "difficulty" "text",
    "cover_image" "text",
    "prizes" "jsonb",
    "timeline" "jsonb",
    "submission_criteria" "text",
    "evaluation_criteria" "text",
    "rules" "text",
    "deliverables" "text",
    "tools_allowed" "text",
    "eligibility" "text",
    "status" "text",
    "start_date" timestamp with time zone,
    "end_date" timestamp with time zone,
    "results_date" timestamp with time zone,
    "max_participants" "text",
    "is_published" boolean,
    "sort_order" bigint,
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."contests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_filter_options" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "value" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."custom_filter_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "value" "text"
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."designations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."designations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid",
    "contact_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "retry_count" integer DEFAULT 0,
    "error_message" "text",
    "sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "last_attempt_at" timestamp with time zone,
    "next_retry_at" timestamp with time zone,
    "tracking_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "opened" boolean DEFAULT false,
    "opened_at" timestamp with time zone,
    "clicked" boolean DEFAULT false,
    "clicked_at" timestamp with time zone,
    "batch_number" integer,
    CONSTRAINT "email_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."email_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."followup_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "followup_campaign_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "trigger_type" character varying(30) NOT NULL,
    "followup_mode" character varying(20) NOT NULL,
    "status" character varying(20) DEFAULT 'pending'::character varying,
    "opened_at" timestamp without time zone,
    "followup_sent_at" timestamp without time zone,
    "created_at" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_followup_status" CHECK ((("status")::"text" = ANY (ARRAY[('pending'::character varying)::"text", ('sent'::character varying)::"text", ('failed'::character varying)::"text"]))),
    CONSTRAINT "chk_mode" CHECK ((("followup_mode")::"text" = ANY (ARRAY[('automatic'::character varying)::"text", ('manual'::character varying)::"text"]))),
    CONSTRAINT "chk_trigger" CHECK ((("trigger_type")::"text" = ANY (ARRAY[('opened'::character varying)::"text", ('clicked'::character varying)::"text", ('not_opened'::character varying)::"text"])))
);


ALTER TABLE "public"."followup_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."geographies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."geographies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hero_video" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "video" "text",
    "page_name" "text"
);


ALTER TABLE "public"."hero_video" OWNER TO "postgres";


ALTER TABLE "public"."hero_video" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."hero_video_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."holidays" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "holiday_date" "date" NOT NULL,
    "holiday_name" "text" DEFAULT 'Holiday'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."holidays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."index_video" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "video_url" "text",
    "word" "text",
    "label" "text"
);


ALTER TABLE "public"."index_video" OWNER TO "postgres";


ALTER TABLE "public"."index_video" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."index_video_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."industries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."industries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insight" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "excerpt" "text",
    "body_content" "text",
    "thumbnail" "text",
    "slug" "text",
    "category" "text",
    "image1" "text",
    "image2" "text",
    "image3" "text",
    "image4" "text",
    "image5" "text"
);


ALTER TABLE "public"."insight" OWNER TO "postgres";


ALTER TABLE "public"."insight" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."insight_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lb_case_studies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_title" "text" NOT NULL,
    "client" "text",
    "project_name" "text",
    "hide_client" boolean DEFAULT false NOT NULL,
    "product_type" "text",
    "primary_category" "text",
    "start_date" "date",
    "end_date" "date",
    "written_by" "text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "what_the_job_was" "text",
    "what_limited_us" "text",
    "how_we_ran_it" "text",
    "problems_solved" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "methods_we_used" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "software_technology" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "vendors_used" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "how_long_it_took" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "what_came_out_of_it" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "what_we_would_do_differently" "text",
    "team" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "external_links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "images" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lb_case_studies_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'complete'::"text"])))
);


ALTER TABLE "public"."lb_case_studies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lb_categories" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "sort" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."lb_categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lb_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lesson" "text" NOT NULL,
    "category" "text" NOT NULL,
    "next_time" "text",
    "happened" "text",
    "project" "text",
    "client" "text",
    "hide_client" boolean DEFAULT false NOT NULL,
    "seen_before" "text" DEFAULT 'once'::"text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "photos" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "links" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "written_by" "text" NOT NULL,
    "status" "text" DEFAULT 'quick'::"text" NOT NULL,
    "helpful" integer DEFAULT 0 NOT NULL,
    "helpful_by" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "search_tsv" "tsvector" GENERATED ALWAYS AS (((("setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("lesson", ''::"text")), 'A'::"char") || "setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("next_time", ''::"text")), 'B'::"char")) || "setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("happened", ''::"text")), 'C'::"char")) || "setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("project", ''::"text")), 'C'::"char"))) STORED,
    "from_case" "uuid",
    "from_challenge" "uuid",
    CONSTRAINT "lb_insights_seen_before_check" CHECK (("seen_before" = ANY (ARRAY['once'::"text", 'repeated'::"text", 'standard'::"text"]))),
    CONSTRAINT "lb_insights_status_check" CHECK (("status" = ANY (ARRAY['quick'::"text", 'complete'::"text"])))
);


ALTER TABLE "public"."lb_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lb_members" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "sort" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."lb_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lb_product_types" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "sort" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."lb_product_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "email" "text",
    "phone" "text",
    "linkedin_url" "text",
    "full_name" "text",
    "headline" "text",
    "location" "text",
    "source_query" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "company_name" character varying(255),
    "designation" character varying(255),
    "role" character varying(100),
    "job_title" "text",
    "industry" "text",
    "geography" "text",
    "phone_attempted" boolean DEFAULT false NOT NULL,
    "email_attempted" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mail_sent_log" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email_id" "text",
    "subject" "text",
    "mail_content" "text",
    "status" "text",
    "mail_type" "text"
);


ALTER TABLE "public"."mail_sent_log" OWNER TO "postgres";


ALTER TABLE "public"."mail_sent_log" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."mail_sent_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."mail_sequences" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sequence_name" "text",
    "sub1" "text",
    "body1" "text",
    "sub2" "text",
    "body2" "text",
    "sub3" "text",
    "body3" "text"
);


ALTER TABLE "public"."mail_sequences" OWNER TO "postgres";


ALTER TABLE "public"."mail_sequences" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."mail_sequences_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."meeting-attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "company" "text" NOT NULL,
    "company_website" "text" NOT NULL,
    "company_info" "text" NOT NULL,
    "business_size" "text" NOT NULL,
    "project_scope" "text" NOT NULL,
    "services" "text"[] NOT NULL,
    "budget" "text" NOT NULL,
    "timeline" "text" NOT NULL,
    "important_features" "text" NOT NULL,
    "has_components" boolean NOT NULL,
    "components_details" "text",
    "has_manufacturing" boolean NOT NULL,
    "require_manufacturing" boolean,
    "manufacturing_moq" "text",
    "additional_details" "text" NOT NULL,
    "form_experience" integer,
    "hear_about_us" "text" NOT NULL,
    "meeting_date" "date" NOT NULL,
    "meeting_time" "text",
    "file_url" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reply" "text",
    "meeting_link" "text",
    "Event_Id" "text",
    "team_message_id" "text",
    "client_message_id" "text",
    "tc_is_sent" boolean DEFAULT false,
    "client_followup_is_sent" boolean DEFAULT false,
    "tc_sent_at" timestamp with time zone,
    "project_name" "text",
    "client_reply_notified" boolean DEFAULT false,
    "product_category" "text",
    "organization_type" "text"
);


ALTER TABLE "public"."meeting-attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_attachments_backup" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "company" "text" NOT NULL,
    "company_website" "text" NOT NULL,
    "company_info" "text" NOT NULL,
    "business_size" "text" NOT NULL,
    "project_scope" "text" NOT NULL,
    "services" "text"[] NOT NULL,
    "budget" "text" NOT NULL,
    "timeline" "text" NOT NULL,
    "important_features" "text" NOT NULL,
    "has_components" boolean NOT NULL,
    "components_details" "text",
    "has_manufacturing" boolean NOT NULL,
    "require_manufacturing" boolean,
    "manufacturing_moq" "text",
    "additional_details" "text" NOT NULL,
    "form_experience" integer,
    "hear_about_us" "text" NOT NULL,
    "meeting_date" "date" NOT NULL,
    "meeting_time" "text",
    "file_url" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reply" "text",
    "meeting_link" "text",
    "Event_Id" "text",
    "team_message_id" "text",
    "client_message_id" "text",
    "tc_is_sent" boolean DEFAULT false,
    "client_followup_is_sent" boolean DEFAULT false,
    "tc_sent_at" timestamp with time zone,
    "project_name" "text",
    "client_reply_notified" boolean DEFAULT false,
    "product_category" "text",
    "organization_type" "text"
);


ALTER TABLE "public"."meeting_attachments_backup" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_mail_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "meeting_id" "uuid",
    "email" "text" NOT NULL,
    "audience" "text",
    "mail_type" "text" NOT NULL,
    "subject" "text",
    "body" "text",
    "status" "text" DEFAULT 'sent'::"text",
    "sent_at" timestamp with time zone DEFAULT "now"(),
    "smtp_message_id" "text",
    "in_reply_to" "text",
    "references_id" "text",
    "gmail_thread_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "whatsapp_status" "text"
);


ALTER TABLE "public"."meeting_mail_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."newsletter_subscriptions" (
    "id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "subscribed_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    "is_active" boolean,
    "source" "text"
);


ALTER TABLE "public"."newsletter_subscriptions" OWNER TO "postgres";


ALTER TABLE "public"."newsletter_subscriptions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."newsletter_subscriptions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."number_of_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text" NOT NULL,
    "value" integer NOT NULL,
    "sort_order" integer DEFAULT 0,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."number_of_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."openPositions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "location" "text",
    "type" "text",
    "department" "text",
    "description" "text"
);


ALTER TABLE "public"."openPositions" OWNER TO "postgres";


ALTER TABLE "public"."openPositions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."openPositions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" integer NOT NULL,
    "title" "text",
    "description" "text",
    "full_description" "text",
    "category" "text",
    "price_usd" integer,
    "price_inr" integer,
    "rating" numeric,
    "reviews" integer,
    "image" "text",
    "images" "jsonb",
    "badge" "text",
    "features" "jsonb",
    "specifications" "jsonb",
    "file_formats" "jsonb",
    "design_software" "jsonb",
    "video_url" "text",
    "deliverables" "jsonb",
    "design_stage" "text",
    "industry" "text",
    "tags" "jsonb",
    "slag" "text"
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_name" "text" DEFAULT 'Untitled project'::"text" NOT NULL,
    "client_name" "text" DEFAULT ''::"text" NOT NULL,
    "project_code" "text" DEFAULT ''::"text" NOT NULL,
    "start_date" "date" NOT NULL,
    "prepared_by" "text" DEFAULT ''::"text" NOT NULL,
    "version" "text" DEFAULT 'R0'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prototype" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slug" "text" DEFAULT 'medical-device-prototype'::"text",
    "title" "text" DEFAULT 'Medical Device Prototype'::"text",
    "category" "text" DEFAULT 'Medical'::"text",
    "Material" "text" DEFAULT 'Titanium, ABS'::"text",
    "type" "text" DEFAULT 'Functional'::"text",
    "image" "text" DEFAULT 'https://images.unsplash.com/photo-1559757175-5700dde675bc?w=800'::"text",
    "client" "text" DEFAULT 'MedTech Innovations'::"text",
    "timeline" "text" DEFAULT '8 weeks'::"text",
    "description" "text" DEFAULT 'A groundbreaking medical device prototype featuring precision-machined titanium components and custom ABS housings. The project required FDA-compliant materials and rigorous testing protocols.'::"text",
    "challenge" "text" DEFAULT 'Creating a device that meets strict medical regulatory requirements while maintaining user-friendly ergonomics and manufacturability at scale.'::"text",
    "solution" "text" DEFAULT 'We developed a modular design approach with biocompatible materials, implementing iterative testing cycles to validate both safety and usability.'::"text",
    "galleryImage1" "text" DEFAULT 'https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1200'::"text",
    "galleryImage2" "text" DEFAULT '      "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1200",'::"text",
    "galleryImage3" "text" DEFAULT 'https://images.unsplash.com/photo-1582719471384-894fbb16e074?w=1200'::"text",
    "Product_name" "text",
    "video" "text",
    "description1" "text",
    "timeline1" "text",
    "description2" "text",
    "description3" "text",
    "description4" "text",
    "timeline2" "text",
    "timeline3" "text",
    "timeline4" "text",
    "title1" "text",
    "title2" "text",
    "title3" "text",
    "title4" "text"
);


ALTER TABLE "public"."prototype" OWNER TO "postgres";


ALTER TABLE "public"."prototype" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."prototype_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."remove_timing" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meeting_date" "date",
    "meeting_time" "text"
);


ALTER TABLE "public"."remove_timing" OWNER TO "postgres";


ALTER TABLE "public"."remove_timing" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."remove_timing_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."rfq" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text",
    "followup_count" integer DEFAULT 0,
    "last_followup_at" timestamp with time zone
);


ALTER TABLE "public"."rfq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rfq_followup_audit" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rfq_id" bigint,
    "email" "text" NOT NULL,
    "action" "text" NOT NULL,
    "ok" boolean NOT NULL,
    "error" "text"
);


ALTER TABLE "public"."rfq_followup_audit" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."rfq_followup_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."rfq_followup_audit_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."rfq_followup_audit_id_seq" OWNED BY "public"."rfq_followup_audit"."id";



ALTER TABLE "public"."rfq" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."rfq_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."sequence_branch_step_attachments" (
    "id" bigint NOT NULL,
    "branch_step_id" bigint NOT NULL,
    "file_name" "text" NOT NULL,
    "file_size" bigint,
    "storage_bucket" "text" DEFAULT 'sequence-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sequence_branch_step_attachments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sequence_branch_step_attachments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sequence_branch_step_attachments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sequence_branch_step_attachments_id_seq" OWNED BY "public"."sequence_branch_step_attachments"."id";



CREATE TABLE IF NOT EXISTS "public"."sequence_branch_steps" (
    "id" bigint NOT NULL,
    "step" integer NOT NULL,
    "parent_step" integer,
    "parent_branch" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sequence_id" "uuid",
    "wait_hours" integer DEFAULT 0 NOT NULL,
    "parent_step_id" bigint,
    "send_action" "text" DEFAULT 'send_automatically'::"text" NOT NULL,
    "send_after_value" integer,
    "send_after_unit" "text",
    "template_id" "uuid",
    CONSTRAINT "sequence_branch_steps_parent_branch_check" CHECK (("parent_branch" = ANY (ARRAY['STARTING'::"text", 'OPENED'::"text", 'NOT_OPENED'::"text"]))),
    CONSTRAINT "sequence_branch_steps_send_action_check" CHECK (("send_action" = ANY (ARRAY['send_email'::"text", 'send_automatically'::"text", 'skip'::"text"]))),
    CONSTRAINT "sequence_branch_steps_send_after_unit_check" CHECK ((("send_after_unit" IS NULL) OR ("send_after_unit" = ANY (ARRAY['minutes'::"text", 'hours'::"text", 'days'::"text"]))))
);


ALTER TABLE "public"."sequence_branch_steps" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sequence_branch_steps_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sequence_branch_steps_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sequence_branch_steps_id_seq" OWNED BY "public"."sequence_branch_steps"."id";



CREATE TABLE IF NOT EXISTS "public"."sequence_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "current_step" integer DEFAULT 1 NOT NULL,
    "current_email_type" "text" DEFAULT 'normal'::"text" NOT NULL,
    "current_email_log_id" "uuid",
    "sent_at" timestamp with time zone,
    "next_run_at" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "enrolled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_action_at" timestamp with time zone,
    "current_step_id" "uuid",
    CONSTRAINT "sequence_enrollments_current_email_type_check" CHECK (("current_email_type" = ANY (ARRAY['normal'::"text", 'increment'::"text"])))
);


ALTER TABLE "public"."sequence_enrollments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_step_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_step_id" "uuid" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" DEFAULT 'application/octet-stream'::"text" NOT NULL,
    "file_size" bigint DEFAULT 0 NOT NULL,
    "storage_bucket" "text" DEFAULT 'sequence-attachments'::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sequence_step_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_step_batch_state" (
    "sequence_id" "uuid" NOT NULL,
    "sequence_step_id" "uuid" NOT NULL,
    "batch_size" integer DEFAULT 30 NOT NULL,
    "batch_enabled" boolean DEFAULT true NOT NULL,
    "first_batch_delay_hours" double precision DEFAULT 1 NOT NULL,
    "subsequent_batch_delay_hours" double precision DEFAULT 1 NOT NULL,
    "current_batch_number" integer DEFAULT 0 NOT NULL,
    "batch_sent" integer DEFAULT 0 NOT NULL,
    "next_batch_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sequence_step_batch_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_step_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "sequence_step_id" "uuid" NOT NULL,
    "contact_id" "uuid" NOT NULL,
    "email_log_id" "uuid",
    "sent_at" timestamp with time zone,
    "opened" boolean DEFAULT false NOT NULL,
    "opened_at" timestamp with time zone,
    "clicked" boolean DEFAULT false NOT NULL,
    "clicked_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "step_id" "uuid",
    CONSTRAINT "sequence_step_logs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."sequence_step_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequence_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sequence_id" "uuid" NOT NULL,
    "step_number" integer NOT NULL,
    "parent_step_id" "uuid",
    "parent_branch" "text" NOT NULL,
    "normal_subject" "text" NOT NULL,
    "normal_body" "text" NOT NULL,
    "from_name" "text",
    "wait_hours" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "increment_subject" "text",
    "increment_body" "text",
    "recipient_type" "text" DEFAULT 'all'::"text" NOT NULL,
    "send_action" "text" DEFAULT 'send_automatically'::"text" NOT NULL,
    "send_after_value" integer,
    "send_after_unit" "text",
    "normal_template_id" "uuid",
    "increment_template_id" "uuid",
    CONSTRAINT "sequence_steps_parent_branch_check" CHECK (("parent_branch" = ANY (ARRAY['STARTING'::"text", 'OPENED'::"text", 'NOT_OPENED'::"text"]))),
    CONSTRAINT "sequence_steps_recipient_type_check" CHECK (("recipient_type" = ANY (ARRAY['all'::"text", 'opened'::"text", 'not_opened'::"text"]))),
    CONSTRAINT "sequence_steps_send_action_check" CHECK (("send_action" = ANY (ARRAY['send_email'::"text", 'send_automatically'::"text", 'skip'::"text"]))),
    CONSTRAINT "sequence_steps_send_after_unit_check" CHECK ((("send_after_unit" IS NULL) OR ("send_after_unit" = ANY (ARRAY['minutes'::"text", 'hours'::"text", 'days'::"text"]))))
);


ALTER TABLE "public"."sequence_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sequences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "starting_campaign_id" "uuid",
    "audience_segment" "text",
    "trigger_type" "text" DEFAULT 'behaviour'::"text" NOT NULL,
    "campaign_id" "uuid",
    "recipient_type" "text" DEFAULT 'all'::"text" NOT NULL,
    "send_mode" "text" DEFAULT 'both'::"text" NOT NULL,
    "subject_1" "text",
    "body_1" "text",
    "subject_2" "text",
    "body_2" "text",
    "subject_2a" "text",
    "body_2a" "text",
    "subject_3" "text",
    "body_3" "text",
    "subject_3a" "text",
    "body_3a" "text",
    "subject_4" "text",
    "body_4" "text",
    "subject_4a" "text",
    "body_4a" "text",
    "subject_5" "text",
    "body_5" "text",
    "subject_5a" "text",
    "body_5a" "text",
    "subject_6" "text",
    "body_6" "text",
    "subject_6a" "text",
    "body_6a" "text",
    "subject_7" "text",
    "body_7" "text",
    "subject_7a" "text",
    "body_7a" "text",
    "subject_8" "text",
    "body_8" "text",
    "subject_8a" "text",
    "body_8a" "text",
    "subject_9" "text",
    "body_9" "text",
    "subject_9a" "text",
    "body_9a" "text",
    "subject_10" "text",
    "body_10" "text",
    "subject_10a" "text",
    "body_10a" "text",
    "subject_11" "text",
    "body_11" "text",
    "subject_11a" "text",
    "body_11a" "text",
    "subject_12" "text",
    "body_12" "text",
    "subject_12a" "text",
    "body_12a" "text",
    "batch_enabled" boolean DEFAULT false NOT NULL,
    "batch_size" integer DEFAULT 30 NOT NULL,
    "first_batch_delay_hours" double precision DEFAULT 1 NOT NULL,
    "subsequent_batch_delay_hours" double precision DEFAULT 1 NOT NULL,
    CONSTRAINT "sequences_recipient_type_check" CHECK (("recipient_type" = ANY (ARRAY['all'::"text", 'opened'::"text", 'not_opened'::"text"]))),
    CONSTRAINT "sequences_send_mode_check" CHECK (("send_mode" = ANY (ARRAY['automatic'::"text", 'manual'::"text", 'both'::"text"]))),
    CONSTRAINT "sequences_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text"]))),
    CONSTRAINT "sequences_trigger_type_check" CHECK (("trigger_type" = ANY (ARRAY['manual'::"text", 'time_based'::"text", 'behaviour'::"text"])))
);


ALTER TABLE "public"."sequences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slide1" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "hero_video" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide1" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slide10" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide10" OWNER TO "postgres";


ALTER TABLE "public"."slide10" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide10_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide11" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide11" OWNER TO "postgres";


ALTER TABLE "public"."slide11" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide11_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "public"."slide1" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide1_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide2" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "quote" "text",
    "card1" "text",
    "card2" "text",
    "card3" "text",
    "product_name" "text",
    "image1" "text",
    "image2" "text",
    "image3" "text"
);


ALTER TABLE "public"."slide2" OWNER TO "postgres";


ALTER TABLE "public"."slide2" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide2_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide3" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slogan" "text",
    "image" "text",
    "title" "text",
    "statement" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide3" OWNER TO "postgres";


ALTER TABLE "public"."slide3" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide3_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide4" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sketch_video" "text",
    "product_name" "text",
    "caption" "text"
);


ALTER TABLE "public"."slide4" OWNER TO "postgres";


ALTER TABLE "public"."slide4" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide4_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide5" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image" "text",
    "title" "text",
    "statement" "text",
    "product_name" "text",
    "caption" "text"
);


ALTER TABLE "public"."slide5" OWNER TO "postgres";


ALTER TABLE "public"."slide5" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide5_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide6" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "score1" "text",
    "score1_statement" "text",
    "score2" "text",
    "score2_statement" "text",
    "score3" "text",
    "score3_statement" "text",
    "score4" "text",
    "score4_statement" "text",
    "product_name" "text",
    "statement" "text",
    "client" "text"
);


ALTER TABLE "public"."slide6" OWNER TO "postgres";


ALTER TABLE "public"."slide6" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide6_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide7" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide7" OWNER TO "postgres";


ALTER TABLE "public"."slide7" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide7_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide8" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "image" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide8" OWNER TO "postgres";


ALTER TABLE "public"."slide8" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide8_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."slide9" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "video" "text",
    "product_name" "text"
);


ALTER TABLE "public"."slide9" OWNER TO "postgres";


ALTER TABLE "public"."slide9" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."slide9_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."stages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "stage_name" "text" DEFAULT 'New stage'::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "duration_days" integer DEFAULT 5 NOT NULL,
    "dependency_type" "text" DEFAULT 'after'::"text" NOT NULL,
    "offset_days" integer DEFAULT 2 NOT NULL,
    "fixed_start" "date",
    "fixed_ref" "date",
    "start_date" "date",
    "end_date" "date",
    "stage_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."stages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."states" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "country_code" "text",
    "country_name" "text"
);


ALTER TABLE "public"."states" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."states_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."states_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."states_id_seq" OWNED BY "public"."states"."id";



CREATE TABLE IF NOT EXISTS "public"."techno_commercial" (
    "id" "text" NOT NULL,
    "client_name" "text",
    "project_name" "text",
    "concern_person" "text",
    "email" "text",
    "phone" "text",
    "packages" "text"[],
    "total_inr" numeric,
    "status" "text" DEFAULT 'Draft'::"text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "remark_date" timestamp with time zone,
    "remark" "text",
    "feedback" "text",
    "project_status" "text"
);


ALTER TABLE "public"."techno_commercial" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text",
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "template_source" "text" DEFAULT 'database'::"text" NOT NULL,
    "storage_bucket" "text",
    "storage_path" "text"
);


ALTER TABLE "public"."templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."venture_form_data" (
    "id" integer NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" "text",
    "founder_name" "text",
    "founder_email" "text",
    "founder_phone" "text",
    "founder_linkedin" "text",
    "startup_name" "text",
    "startup_website" "text",
    "tagline" "text",
    "industry" "text",
    "stage" "text",
    "founded_year" "text",
    "team_size" "text",
    "co_founders" "text",
    "problem_statement" "text",
    "solution_description" "text",
    "target_market" "text",
    "business_model" "text",
    "traction" "text",
    "current_funding" "text",
    "funding_seeking" "text",
    "services_needed" "text",
    "partnership_type" "text",
    "additional_info" "text",
    "pitch_deck_url" "text",
    "status" "text",
    "is_reviewed" "text",
    "notes" "text"
);


ALTER TABLE "public"."venture_form_data" OWNER TO "postgres";


ALTER TABLE "public"."venture_form_data" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."venture_form_data_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."videos" (
    "id" "text" NOT NULL,
    "title" "text",
    "description" "text",
    "thumbnail" "text",
    "youtube_id" "text",
    "duration" "text",
    "views" "text",
    "category" "text",
    "is_reel" boolean,
    "is_featured" boolean,
    "is_published" boolean,
    "tags" "jsonb",
    "sort_order" bigint,
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."videos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weekly_email_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "contact_id" "text" NOT NULL,
    "email" "text",
    "full_name" "text",
    "company" "text",
    "designation" "text",
    "industry" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "queued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attempted_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "next_retry_at" timestamp with time zone,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "opened_at" timestamp with time zone,
    "clicked_at" timestamp with time zone,
    "scheduled_for" timestamp with time zone,
    "schedule_type" "text",
    "schedule_timezone" "text",
    "schedule_batch" integer,
    "schedule_batch_size" integer,
    "schedule_interval_minutes" integer,
    "manually_scheduled" boolean DEFAULT false NOT NULL,
    "schedule_updated_at" timestamp with time zone,
    CONSTRAINT "weekly_email_queue_schedule_batch_check" CHECK ((("schedule_batch" IS NULL) OR ("schedule_batch" > 0))),
    CONSTRAINT "weekly_email_queue_schedule_batch_size_check" CHECK ((("schedule_batch_size" IS NULL) OR ("schedule_batch_size" > 0))),
    CONSTRAINT "weekly_email_queue_schedule_interval_check" CHECK ((("schedule_interval_minutes" IS NULL) OR ("schedule_interval_minutes" >= 0))),
    CONSTRAINT "weekly_email_queue_schedule_type_check" CHECK ((("schedule_type" IS NULL) OR ("schedule_type" = ANY (ARRAY['one_time'::"text", 'weekly'::"text", 'monthly'::"text"])))),
    CONSTRAINT "weekly_email_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."weekly_email_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weekly_email_queue_backup_20260923" (
    "id" "uuid",
    "contact_id" "text",
    "email" "text",
    "full_name" "text",
    "company" "text",
    "designation" "text",
    "industry" "text",
    "status" "text",
    "attempts" integer,
    "queued_at" timestamp with time zone,
    "attempted_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "next_retry_at" timestamp with time zone,
    "error_message" "text",
    "created_at" timestamp with time zone
);


ALTER TABLE "public"."weekly_email_queue_backup_20260923" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient" "text" NOT NULL,
    "type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "status" "text" NOT NULL,
    "message_id" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "name" "text"
);


ALTER TABLE "public"."whatsapp_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."whatsapp_message" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipient" "text" NOT NULL,
    "type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "status" "text" NOT NULL,
    "message_id" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text"
);


ALTER TABLE "public"."whatsapp_message" OWNER TO "postgres";


ALTER TABLE ONLY "public"."rfq_followup_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."rfq_followup_audit_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sequence_branch_step_attachments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sequence_branch_step_attachments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."sequence_branch_steps" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sequence_branch_steps_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."states" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."states_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."teammember"
    ADD CONSTRAINT "Teammember_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_bills"
    ADD CONSTRAINT "acc_bills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_clients"
    ADD CONSTRAINT "acc_clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_documents"
    ADD CONSTRAINT "acc_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_followups"
    ADD CONSTRAINT "acc_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_payments_out"
    ADD CONSTRAINT "acc_payments_out_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_projects"
    ADD CONSTRAINT "acc_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_settings"
    ADD CONSTRAINT "acc_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."acc_vendors"
    ADD CONSTRAINT "acc_vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_panel"
    ADD CONSTRAINT "admin_panel_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."apify_scrapers"
    ADD CONSTRAINT "apify_scrapers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."apify_scrapers"
    ADD CONSTRAINT "apify_scrapers_url_key" UNIQUE ("url");



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."audience_segments"
    ADD CONSTRAINT "audience_segments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_analytics"
    ADD CONSTRAINT "campaign_analytics_pkey" PRIMARY KEY ("campaign_id");



ALTER TABLE ONLY "public"."campaign_attachments"
    ADD CONSTRAINT "campaign_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_followup_logs"
    ADD CONSTRAINT "campaign_followup_logs_campaign_id_contact_id_followup_camp_key" UNIQUE ("campaign_id", "contact_id", "followup_campaign_id");



ALTER TABLE ONLY "public"."campaign_followup_logs"
    ADD CONSTRAINT "campaign_followup_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "campaign_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_schedules"
    ADD CONSTRAINT "campaign_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_types"
    ADD CONSTRAINT "campaign_types_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."campaign_types"
    ADD CONSTRAINT "campaign_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."case_studies"
    ADD CONSTRAINT "case_studies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_video"
    ADD CONSTRAINT "client_video_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_categories"
    ADD CONSTRAINT "company_categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."company_categories"
    ADD CONSTRAINT "company_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_sizes"
    ADD CONSTRAINT "company_sizes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."company_sizes"
    ADD CONSTRAINT "company_sizes_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."contact"
    ADD CONSTRAINT "contact_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."contact_list_members"
    ADD CONSTRAINT "contact_list_members_list_id_contact_id_key" UNIQUE ("list_id", "contact_id");



ALTER TABLE ONLY "public"."contact_list_members"
    ADD CONSTRAINT "contact_list_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_lists"
    ADD CONSTRAINT "contact_lists_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."contact_lists"
    ADD CONSTRAINT "contact_lists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact"
    ADD CONSTRAINT "contact_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_types"
    ADD CONSTRAINT "contact_types_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."contact_types"
    ADD CONSTRAINT "contact_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contest_submissions"
    ADD CONSTRAINT "contest_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contests"
    ADD CONSTRAINT "contests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_filter_options"
    ADD CONSTRAINT "custom_filter_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_filter_options"
    ADD CONSTRAINT "custom_filter_options_user_id_category_value_key" UNIQUE ("user_id", "category", "value");



ALTER TABLE ONLY "public"."designations"
    ADD CONSTRAINT "designations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."designations"
    ADD CONSTRAINT "designations_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "followup_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geographies"
    ADD CONSTRAINT "geographies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."geographies"
    ADD CONSTRAINT "geographies_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."hero_video"
    ADD CONSTRAINT "hero_video_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."holidays"
    ADD CONSTRAINT "holidays_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."index_video"
    ADD CONSTRAINT "index_video_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."industries"
    ADD CONSTRAINT "industries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."industries"
    ADD CONSTRAINT "industries_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."insight"
    ADD CONSTRAINT "insight_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lb_case_studies"
    ADD CONSTRAINT "lb_case_studies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lb_categories"
    ADD CONSTRAINT "lb_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lb_insights"
    ADD CONSTRAINT "lb_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lb_members"
    ADD CONSTRAINT "lb_members_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."lb_members"
    ADD CONSTRAINT "lb_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lb_product_types"
    ADD CONSTRAINT "lb_product_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_user_id_linkedin_url_key" UNIQUE ("user_id", "linkedin_url");



ALTER TABLE ONLY "public"."mail_sent_log"
    ADD CONSTRAINT "mail_sent_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mail_sequences"
    ADD CONSTRAINT "mail_sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting-attachments"
    ADD CONSTRAINT "meeting-attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_attachments_backup"
    ADD CONSTRAINT "meeting_attachments_backup_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_mail_log"
    ADD CONSTRAINT "meeting_mail_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."newsletter_subscriptions"
    ADD CONSTRAINT "newsletter_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."number_of_profiles"
    ADD CONSTRAINT "number_of_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."number_of_profiles"
    ADD CONSTRAINT "number_of_profiles_value_key" UNIQUE ("value");



ALTER TABLE ONLY "public"."openPositions"
    ADD CONSTRAINT "openPositions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prototype"
    ADD CONSTRAINT "prototype_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."remove_timing"
    ADD CONSTRAINT "remove_timing_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rfq_followup_audit"
    ADD CONSTRAINT "rfq_followup_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rfq"
    ADD CONSTRAINT "rfq_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "roles_name_key" UNIQUE ("label");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_branch_step_attachments"
    ADD CONSTRAINT "sequence_branch_step_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_branch_steps"
    ADD CONSTRAINT "sequence_branch_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_contact_id_key" UNIQUE ("sequence_id", "contact_id");



ALTER TABLE ONLY "public"."sequence_step_attachments"
    ADD CONSTRAINT "sequence_step_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_step_batch_state"
    ADD CONSTRAINT "sequence_step_batch_state_pk" PRIMARY KEY ("sequence_id", "sequence_step_id");



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_seq_step_contact_key" UNIQUE ("sequence_id", "sequence_step_id", "contact_id");



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide10"
    ADD CONSTRAINT "slide10_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide11"
    ADD CONSTRAINT "slide11_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide1"
    ADD CONSTRAINT "slide1_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide2"
    ADD CONSTRAINT "slide2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide3"
    ADD CONSTRAINT "slide3_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide4"
    ADD CONSTRAINT "slide4_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide5"
    ADD CONSTRAINT "slide5_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide6"
    ADD CONSTRAINT "slide6_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide7"
    ADD CONSTRAINT "slide7_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide8"
    ADD CONSTRAINT "slide8_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."slide9"
    ADD CONSTRAINT "slide9_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stages"
    ADD CONSTRAINT "stages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."states"
    ADD CONSTRAINT "states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."techno_commercial"
    ADD CONSTRAINT "techno_commercial_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."templates"
    ADD CONSTRAINT "templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_role_key" UNIQUE ("user_id", "role");



ALTER TABLE ONLY "public"."venture_form_data"
    ADD CONSTRAINT "venture_form_data_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."videos"
    ADD CONSTRAINT "videos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weekly_email_queue"
    ADD CONSTRAINT "weekly_email_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_logs"
    ADD CONSTRAINT "whatsapp_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_message"
    ADD CONSTRAINT "whatsapp_message_pkey" PRIMARY KEY ("id");



CREATE INDEX "campaign_attachments_campaign_idx" ON "public"."campaign_attachments" USING "btree" ("campaign_id");



CREATE UNIQUE INDEX "contacts_email_nonempty_key" ON "public"."contacts" USING "btree" ("lower"(TRIM(BOTH FROM "email"))) WHERE (("email" IS NOT NULL) AND (TRIM(BOTH FROM "email") <> ''::"text"));



CREATE UNIQUE INDEX "contacts_email_unique_lower" ON "public"."contacts" USING "btree" ("lower"(TRIM(BOTH FROM "email"))) WHERE (("email" IS NOT NULL) AND (TRIM(BOTH FROM "email") <> ''::"text"));



CREATE UNIQUE INDEX "contacts_linkedin_url_key" ON "public"."contacts" USING "btree" ("linkedin_url");



CREATE INDEX "custom_filter_options_user_category_idx" ON "public"."custom_filter_options" USING "btree" ("user_id", "category");



CREATE INDEX "designations_sort_idx" ON "public"."designations" USING "btree" ("sort_order");



CREATE INDEX "geographies_sort_idx" ON "public"."geographies" USING "btree" ("sort_order");



CREATE INDEX "idx_acc_bills_project" ON "public"."acc_bills" USING "btree" ("project_id");



CREATE INDEX "idx_acc_bills_vendor" ON "public"."acc_bills" USING "btree" ("vendor_id");



CREATE INDEX "idx_acc_documents_client" ON "public"."acc_documents" USING "btree" ("client_id");



CREATE INDEX "idx_acc_documents_project" ON "public"."acc_documents" USING "btree" ("project_id");



CREATE INDEX "idx_acc_documents_type" ON "public"."acc_documents" USING "btree" ("doc_type");



CREATE INDEX "idx_acc_followups_status" ON "public"."acc_followups" USING "btree" ("status");



CREATE INDEX "idx_acc_payments_out_vendor" ON "public"."acc_payments_out" USING "btree" ("vendor_id");



CREATE INDEX "idx_acc_projects_client" ON "public"."acc_projects" USING "btree" ("client_id");



CREATE INDEX "idx_contact_list_members_contact" ON "public"."contact_list_members" USING "btree" ("contact_id");



CREATE INDEX "idx_contact_list_members_list" ON "public"."contact_list_members" USING "btree" ("list_id");



CREATE INDEX "idx_email_logs_campaign" ON "public"."email_logs" USING "btree" ("campaign_id");



CREATE INDEX "idx_email_logs_clicked" ON "public"."email_logs" USING "btree" ("clicked");



CREATE INDEX "idx_email_logs_contact" ON "public"."email_logs" USING "btree" ("contact_id");



CREATE INDEX "idx_email_logs_opened" ON "public"."email_logs" USING "btree" ("opened");



CREATE INDEX "idx_email_logs_sent_at" ON "public"."email_logs" USING "btree" ("sent_at");



CREATE INDEX "idx_email_logs_status" ON "public"."email_logs" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_email_logs_tracking_id" ON "public"."email_logs" USING "btree" ("tracking_id");



CREATE INDEX "idx_followup_logs_campaign" ON "public"."campaign_followup_logs" USING "btree" ("campaign_id");



CREATE INDEX "idx_followup_logs_status" ON "public"."campaign_followup_logs" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_followups_campaign" ON "public"."campaign_followups" USING "btree" ("campaign_id");



CREATE INDEX "idx_holidays_date" ON "public"."holidays" USING "btree" ("holiday_date");



CREATE INDEX "idx_meeting_mail_log_email" ON "public"."meeting_mail_log" USING "btree" ("email");



CREATE INDEX "idx_meeting_mail_log_meeting_id" ON "public"."meeting_mail_log" USING "btree" ("meeting_id");



CREATE INDEX "idx_sequence_branch_steps_parent" ON "public"."sequence_branch_steps" USING "btree" ("parent_step", "parent_branch");



CREATE INDEX "idx_sequence_branch_steps_parent_step_id" ON "public"."sequence_branch_steps" USING "btree" ("parent_step_id");



CREATE INDEX "idx_sequence_branch_steps_sequence_id" ON "public"."sequence_branch_steps" USING "btree" ("sequence_id");



CREATE INDEX "idx_stages_order" ON "public"."stages" USING "btree" ("project_id", "stage_order");



CREATE INDEX "idx_stages_project" ON "public"."stages" USING "btree" ("project_id");



CREATE INDEX "idx_whatsapp_logs_created_at" ON "public"."whatsapp_logs" USING "btree" ("created_at");



CREATE INDEX "idx_whatsapp_logs_recipient" ON "public"."whatsapp_logs" USING "btree" ("recipient");



CREATE INDEX "industries_sort_idx" ON "public"."industries" USING "btree" ("sort_order");



CREATE INDEX "lb_cases_cat_idx" ON "public"."lb_case_studies" USING "btree" ("primary_category");



CREATE INDEX "lb_cases_created_idx" ON "public"."lb_case_studies" USING "btree" ("created_at" DESC);



CREATE INDEX "lb_cases_status_idx" ON "public"."lb_case_studies" USING "btree" ("status");



CREATE INDEX "lb_cases_tags_gin" ON "public"."lb_case_studies" USING "gin" ("tags");



CREATE INDEX "lb_insights_category_idx" ON "public"."lb_insights" USING "btree" ("category");



CREATE INDEX "lb_insights_created_idx" ON "public"."lb_insights" USING "btree" ("created_at" DESC);



CREATE INDEX "lb_insights_search_gin" ON "public"."lb_insights" USING "gin" ("search_tsv");



CREATE INDEX "lb_insights_tags_gin" ON "public"."lb_insights" USING "gin" ("tags");



CREATE INDEX "lb_insights_writtenby_idx" ON "public"."lb_insights" USING "btree" ("written_by");



CREATE INDEX "lb_members_sort_idx" ON "public"."lb_members" USING "btree" ("sort");



CREATE INDEX "lb_product_types_sort_idx" ON "public"."lb_product_types" USING "btree" ("sort");



CREATE INDEX "leads_user_created_idx" ON "public"."leads" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "rfq_followup_audit_email_idx" ON "public"."rfq_followup_audit" USING "btree" ("email");



CREATE INDEX "rfq_followup_audit_rfq_id_idx" ON "public"."rfq_followup_audit" USING "btree" ("rfq_id");



CREATE INDEX "sequence_branch_step_attachments_step_idx" ON "public"."sequence_branch_step_attachments" USING "btree" ("branch_step_id");



CREATE INDEX "sequence_branch_steps_sequence_idx" ON "public"."sequence_branch_steps" USING "btree" ("sequence_id");



CREATE INDEX "sequence_enrollments_current_step_id_idx" ON "public"."sequence_enrollments" USING "btree" ("current_step_id");



CREATE INDEX "sequence_enrollments_next_run_at_idx" ON "public"."sequence_enrollments" USING "btree" ("next_run_at");



CREATE INDEX "sequence_enrollments_status_idx" ON "public"."sequence_enrollments" USING "btree" ("status");



CREATE INDEX "sequence_step_attachments_step_idx" ON "public"."sequence_step_attachments" USING "btree" ("sequence_step_id");



CREATE INDEX "sequence_step_batch_state_next_batch_at_idx" ON "public"."sequence_step_batch_state" USING "btree" ("next_batch_at");



CREATE INDEX "sequence_step_logs_email_log_id_idx" ON "public"."sequence_step_logs" USING "btree" ("email_log_id");



CREATE INDEX "sequence_step_logs_step_id_idx" ON "public"."sequence_step_logs" USING "btree" ("step_id");



CREATE INDEX "sequence_steps_archived_idx" ON "public"."sequence_steps" USING "btree" ("sequence_id", "archived_at");



CREATE UNIQUE INDEX "sequence_steps_child_branch_unique" ON "public"."sequence_steps" USING "btree" ("sequence_id", "parent_step_id", "parent_branch") WHERE (("parent_step_id" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "sequences_campaign_id_idx" ON "public"."sequences" USING "btree" ("campaign_id");



CREATE INDEX "sequences_starting_campaign_id_idx" ON "public"."sequences" USING "btree" ("starting_campaign_id");



CREATE UNIQUE INDEX "states_country_name_unique" ON "public"."states" USING "btree" ("country_code", "name");



CREATE UNIQUE INDEX "uq_email_logs_tracking_id" ON "public"."email_logs" USING "btree" ("tracking_id");



CREATE UNIQUE INDEX "weekly_email_queue_contact_id_key" ON "public"."weekly_email_queue" USING "btree" ("contact_id");



CREATE UNIQUE INDEX "weekly_email_queue_email_unique_lower" ON "public"."weekly_email_queue" USING "btree" ("lower"(TRIM(BOTH FROM "email"))) WHERE (("email" IS NOT NULL) AND (TRIM(BOTH FROM "email") <> ''::"text"));



CREATE INDEX "weekly_email_queue_pending_idx" ON "public"."weekly_email_queue" USING "btree" ("queued_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "weekly_email_queue_scheduled_pending_idx" ON "public"."weekly_email_queue" USING "btree" ("scheduled_for", "queued_at") WHERE (("status" = 'pending'::"text") AND ("scheduled_for" IS NOT NULL));



CREATE OR REPLACE TRIGGER "apify_scrapers_set_updated_at" BEFORE UPDATE ON "public"."apify_scrapers" FOR EACH ROW EXECUTE FUNCTION "public"."set_apify_scrapers_updated_at"();



CREATE OR REPLACE TRIGGER "contacts_queue_weekly_email_on_insert" AFTER INSERT ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."queue_contact_for_weekly_email"();



CREATE OR REPLACE TRIGGER "lb_case_studies_touch" BEFORE UPDATE ON "public"."lb_case_studies" FOR EACH ROW EXECUTE FUNCTION "public"."lb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "lb_insights_touch" BEFORE UPDATE ON "public"."lb_insights" FOR EACH ROW EXECUTE FUNCTION "public"."lb_touch_updated_at"();



CREATE OR REPLACE TRIGGER "leads_queue_weekly_email_on_insert" AFTER INSERT ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."queue_lead_for_weekly_email"();



CREATE OR REPLACE TRIGGER "leads_sync_contact_on_delete" AFTER DELETE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."delete_lead_contact_sync"();



CREATE OR REPLACE TRIGGER "leads_sync_contact_on_insert" AFTER INSERT ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."sync_lead_insert_to_contact"();



CREATE OR REPLACE TRIGGER "leads_sync_contact_on_update" AFTER UPDATE OF "email" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."sync_lead_email_update_to_contact"();



CREATE OR REPLACE TRIGGER "trg_holidays_updated" BEFORE UPDATE ON "public"."holidays" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_projects_updated" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_stages_updated" BEFORE UPDATE ON "public"."stages" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_update_email_logs_updated_at" BEFORE UPDATE ON "public"."email_logs" FOR EACH ROW EXECUTE FUNCTION "public"."update_email_logs_updated_at"();



ALTER TABLE ONLY "public"."acc_bills"
    ADD CONSTRAINT "acc_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."acc_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_bills"
    ADD CONSTRAINT "acc_bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."acc_vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_documents"
    ADD CONSTRAINT "acc_documents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."acc_clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_documents"
    ADD CONSTRAINT "acc_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."acc_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_followups"
    ADD CONSTRAINT "acc_followups_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."acc_documents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_followups"
    ADD CONSTRAINT "acc_followups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."acc_projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_payments_out"
    ADD CONSTRAINT "acc_payments_out_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."acc_vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."acc_projects"
    ADD CONSTRAINT "acc_projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."acc_clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campaign_analytics"
    ADD CONSTRAINT "campaign_analytics_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_attachments"
    ADD CONSTRAINT "campaign_attachments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_contacts"
    ADD CONSTRAINT "campaign_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id");



ALTER TABLE ONLY "public"."contact_list_members"
    ADD CONSTRAINT "contact_list_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contact_list_members"
    ADD CONSTRAINT "contact_list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_filter_options"
    ADD CONSTRAINT "custom_filter_options_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_schedules"
    ADD CONSTRAINT "fk_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "fk_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "fk_email_logs_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_logs"
    ADD CONSTRAINT "fk_email_logs_contact" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_followups"
    ADD CONSTRAINT "fk_followup_campaign" FOREIGN KEY ("followup_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_campaign" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_contact" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."followup_history"
    ADD CONSTRAINT "fk_history_followup_campaign" FOREIGN KEY ("followup_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lb_case_studies"
    ADD CONSTRAINT "lb_case_studies_primary_category_fkey" FOREIGN KEY ("primary_category") REFERENCES "public"."lb_categories"("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_mail_log"
    ADD CONSTRAINT "meeting_mail_log_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting-attachments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequence_branch_step_attachments"
    ADD CONSTRAINT "sequence_branch_step_attachments_branch_step_id_fkey" FOREIGN KEY ("branch_step_id") REFERENCES "public"."sequence_branch_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_branch_steps"
    ADD CONSTRAINT "sequence_branch_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."sequence_branch_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_branch_steps"
    ADD CONSTRAINT "sequence_branch_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id");



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_attachments"
    ADD CONSTRAINT "sequence_step_attachments_sequence_step_id_fkey" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_batch_state"
    ADD CONSTRAINT "sequence_step_batch_state_step_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_email_log_id_fkey" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_step_logs"
    ADD CONSTRAINT "sequence_step_logs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_increment_template_id_fkey" FOREIGN KEY ("increment_template_id") REFERENCES "public"."templates"("id");



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_normal_template_id_fkey" FOREIGN KEY ("normal_template_id") REFERENCES "public"."templates"("id");



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequence_steps"
    ADD CONSTRAINT "sequence_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sequences"
    ADD CONSTRAINT "sequences_starting_campaign_id_fkey" FOREIGN KEY ("starting_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stages"
    ADD CONSTRAINT "stages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Allow all on acc_bills" ON "public"."acc_bills" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_clients" ON "public"."acc_clients" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_documents" ON "public"."acc_documents" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_followups" ON "public"."acc_followups" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_payments_out" ON "public"."acc_payments_out" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_projects" ON "public"."acc_projects" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_settings" ON "public"."acc_settings" USING (true) WITH CHECK (true);



CREATE POLICY "Allow all on acc_vendors" ON "public"."acc_vendors" USING (true) WITH CHECK (true);



CREATE POLICY "Allow anon delete apify scrapers" ON "public"."apify_scrapers" FOR DELETE TO "anon" USING (true);



CREATE POLICY "Allow anon insert apify scrapers" ON "public"."apify_scrapers" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "Allow anon select apify scrapers" ON "public"."apify_scrapers" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Allow anon update apify scrapers" ON "public"."apify_scrapers" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "Allow authenticated delete apify scrapers" ON "public"."apify_scrapers" FOR DELETE TO "authenticated" USING (true);



CREATE POLICY "Allow authenticated insert apify scrapers" ON "public"."apify_scrapers" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "Allow authenticated select apify scrapers" ON "public"."apify_scrapers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Allow authenticated update apify scrapers" ON "public"."apify_scrapers" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Allow public inserts" ON "public"."whatsapp_logs" FOR INSERT WITH CHECK (true);



CREATE POLICY "Allow public selects" ON "public"."whatsapp_logs" FOR SELECT USING (true);



CREATE POLICY "Anyone can read designations" ON "public"."designations" FOR SELECT USING (true);



CREATE POLICY "Anyone can read geographies" ON "public"."geographies" FOR SELECT USING (true);



CREATE POLICY "Anyone can read industries" ON "public"."industries" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide1" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide10" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide11" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide2" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide3" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide4" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide5" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide6" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide7" FOR SELECT USING (true);



CREATE POLICY "Enable read access for all users" ON "public"."slide8" FOR SELECT USING (true);



CREATE POLICY "Users delete own leads" ON "public"."leads" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users insert own leads" ON "public"."leads" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users read own leads" ON "public"."leads" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users update own leads" ON "public"."leads" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."acc_bills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_followups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_payments_out" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."acc_vendors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_panel" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allow anon delete" ON "public"."admin_panel" FOR DELETE TO "anon" USING (true);



CREATE POLICY "allow anon delete" ON "public"."contest_submissions" FOR DELETE TO "anon" USING (true);



CREATE POLICY "allow anon insert" ON "public"."admin_panel" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "allow anon insert" ON "public"."contest_submissions" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "allow anon login read" ON "public"."admin_panel" FOR SELECT TO "anon" USING (true);



CREATE POLICY "allow anon select" ON "public"."contest_submissions" FOR SELECT TO "anon" USING (true);



CREATE POLICY "allow anon update" ON "public"."admin_panel" FOR UPDATE TO "anon" USING (true);



CREATE POLICY "allow anon update" ON "public"."contest_submissions" FOR UPDATE TO "anon" USING (true);



CREATE POLICY "anon_delete_remove_timing" ON "public"."remove_timing" FOR DELETE TO "anon" USING (true);



CREATE POLICY "anon_full_access" ON "public"."acc_bills" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_clients" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_documents" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_followups" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_payments_out" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_projects" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_settings" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."acc_vendors" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."admin_panel" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."case_studies" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."client_video" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."contact" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."contest_submissions" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."contests" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."hero_video" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."index_video" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."insight" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."mail_sent_log" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."meeting-attachments" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."meeting_attachments_backup" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."meeting_mail_log" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."newsletter_subscriptions" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."openPositions" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."products" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."prototype" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."remove_timing" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."rfq" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."rfq_followup_audit" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide1" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide10" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide11" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide2" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide3" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide4" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide5" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide6" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide7" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide8" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."slide9" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."teammember" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."techno_commercial" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."user_roles" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."venture_form_data" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."videos" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."whatsapp_logs" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access" ON "public"."whatsapp_message" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_full_access_case_studies" ON "public"."case_studies" TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon_insert_remove_timing" ON "public"."remove_timing" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "anon_select_remove_timing" ON "public"."remove_timing" FOR SELECT TO "anon" USING (true);



CREATE POLICY "anon_update_remove_timing" ON "public"."remove_timing" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



ALTER TABLE "public"."apify_scrapers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "apify_scrapers delete" ON "public"."apify_scrapers" FOR DELETE TO "anon" USING (true);



CREATE POLICY "apify_scrapers insert" ON "public"."apify_scrapers" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "apify_scrapers select" ON "public"."apify_scrapers" FOR SELECT TO "anon" USING (true);



CREATE POLICY "apify_scrapers update" ON "public"."apify_scrapers" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



CREATE POLICY "campaign attachments delete" ON "public"."campaign_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "campaign attachments insert" ON "public"."campaign_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "campaign attachments select" ON "public"."campaign_attachments" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."campaign_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."case_studies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_video" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contact_list_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_list_members delete" ON "public"."contact_list_members" FOR DELETE TO "anon" USING (true);



CREATE POLICY "contact_list_members insert" ON "public"."contact_list_members" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "contact_list_members select" ON "public"."contact_list_members" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."contact_lists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_lists delete" ON "public"."contact_lists" FOR DELETE TO "anon" USING (true);



CREATE POLICY "contact_lists insert" ON "public"."contact_lists" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "contact_lists select" ON "public"."contact_lists" FOR SELECT TO "anon" USING (true);



CREATE POLICY "contact_lists update" ON "public"."contact_lists" FOR UPDATE TO "anon" USING (true) WITH CHECK (true);



ALTER TABLE "public"."contests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_filter_options" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "custom_filter_options: delete own" ON "public"."custom_filter_options" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "custom_filter_options: insert own" ON "public"."custom_filter_options" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "custom_filter_options: select own" ON "public"."custom_filter_options" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."designations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."geographies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hero_video" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."holidays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."index_video" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."industries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."insight" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lb case_studies full access" ON "public"."lb_case_studies" USING (true) WITH CHECK (true);



CREATE POLICY "lb insights full access" ON "public"."lb_insights" USING (true) WITH CHECK (true);



CREATE POLICY "lb members readable" ON "public"."lb_members" FOR SELECT USING (true);



CREATE POLICY "lb product_types readable" ON "public"."lb_product_types" FOR SELECT USING (true);



ALTER TABLE "public"."lb_case_studies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lb_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lb_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lb_product_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mail_sequences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meeting-attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meeting_attachments_backup" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."newsletter_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."openPositions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prototype" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public delete holidays" ON "public"."holidays" FOR DELETE USING (true);



CREATE POLICY "public delete projects" ON "public"."projects" FOR DELETE USING (true);



CREATE POLICY "public delete stages" ON "public"."stages" FOR DELETE USING (true);



CREATE POLICY "public insert" ON "public"."meeting_attachments_backup" FOR INSERT WITH CHECK (true);



CREATE POLICY "public insert " ON "public"."meeting-attachments" FOR INSERT WITH CHECK (true);



CREATE POLICY "public insert contest submissions" ON "public"."contest_submissions" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "public insert holidays" ON "public"."holidays" FOR INSERT WITH CHECK (true);



CREATE POLICY "public insert projects" ON "public"."projects" FOR INSERT WITH CHECK (true);



CREATE POLICY "public insert stages" ON "public"."stages" FOR INSERT WITH CHECK (true);



CREATE POLICY "public read holidays" ON "public"."holidays" FOR SELECT USING (true);



CREATE POLICY "public read projects" ON "public"."projects" FOR SELECT USING (true);



CREATE POLICY "public read stages" ON "public"."stages" FOR SELECT USING (true);



CREATE POLICY "public update holidays" ON "public"."holidays" FOR UPDATE USING (true) WITH CHECK (true);



CREATE POLICY "public update projects" ON "public"."projects" FOR UPDATE USING (true) WITH CHECK (true);



CREATE POLICY "public update stages" ON "public"."stages" FOR UPDATE USING (true) WITH CHECK (true);



ALTER TABLE "public"."remove_timing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rfq" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rfq_followup_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sequence attachments delete" ON "public"."sequence_step_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "sequence attachments insert" ON "public"."sequence_step_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "sequence attachments select" ON "public"."sequence_step_attachments" FOR SELECT TO "anon" USING (true);



CREATE POLICY "sequence branch attachments delete" ON "public"."sequence_branch_step_attachments" FOR DELETE TO "anon" USING (true);



CREATE POLICY "sequence branch attachments insert" ON "public"."sequence_branch_step_attachments" FOR INSERT TO "anon" WITH CHECK (true);



CREATE POLICY "sequence branch attachments select" ON "public"."sequence_branch_step_attachments" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."sequence_branch_step_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sequence_step_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide10" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide11" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide3" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide4" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide5" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide6" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide7" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide8" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slide9" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."teammember" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."techno_commercial" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users manage their own custom options" ON "public"."custom_filter_options" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."venture_form_data" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."videos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."whatsapp_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."whatsapp_message" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";














































































































































































GRANT ALL ON FUNCTION "public"."complete_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_batch_enabled" boolean, "p_first_delay" double precision, "p_subsequent_delay" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."create_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_batch_enabled" boolean, "p_first_delay" double precision, "p_subsequent_delay" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_sequence_batch_state"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_batch_enabled" boolean, "p_first_delay" double precision, "p_subsequent_delay" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."delete_lead_contact_sync"() TO "anon";
GRANT ALL ON FUNCTION "public"."delete_lead_contact_sync"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_lead_contact_sync"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_sequence_batch_count"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_next_delay_hours" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."increment_sequence_batch_count"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_next_delay_hours" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_sequence_batch_count"("p_sequence_id" "uuid", "p_sequence_step_id" "uuid", "p_batch_size" integer, "p_next_delay_hours" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."lb_touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."lb_touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."lb_touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_contact_for_weekly_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_contact_for_weekly_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_contact_for_weekly_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_lead_for_weekly_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_lead_for_weekly_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_lead_for_weekly_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_email_click"("p_tracking_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_email_open"("p_tracking_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_apify_scrapers_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_apify_scrapers_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_apify_scrapers_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_lead_email_update_to_contact"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_lead_email_update_to_contact"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_lead_email_update_to_contact"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_lead_insert_to_contact"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_lead_insert_to_contact"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_lead_insert_to_contact"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_email_logs_updated_at"() TO "service_role";
























GRANT ALL ON TABLE "public"."teammember" TO "anon";
GRANT ALL ON TABLE "public"."teammember" TO "authenticated";
GRANT ALL ON TABLE "public"."teammember" TO "service_role";



GRANT ALL ON SEQUENCE "public"."Teammember_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."Teammember_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."Teammember_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."acc_bills" TO "anon";
GRANT ALL ON TABLE "public"."acc_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_bills" TO "service_role";



GRANT ALL ON TABLE "public"."acc_clients" TO "anon";
GRANT ALL ON TABLE "public"."acc_clients" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_clients" TO "service_role";



GRANT ALL ON TABLE "public"."acc_documents" TO "anon";
GRANT ALL ON TABLE "public"."acc_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_documents" TO "service_role";



GRANT ALL ON TABLE "public"."acc_followups" TO "anon";
GRANT ALL ON TABLE "public"."acc_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_followups" TO "service_role";



GRANT ALL ON TABLE "public"."acc_payments_out" TO "anon";
GRANT ALL ON TABLE "public"."acc_payments_out" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_payments_out" TO "service_role";



GRANT ALL ON TABLE "public"."acc_projects" TO "anon";
GRANT ALL ON TABLE "public"."acc_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_projects" TO "service_role";



GRANT ALL ON TABLE "public"."acc_settings" TO "anon";
GRANT ALL ON TABLE "public"."acc_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_settings" TO "service_role";



GRANT ALL ON TABLE "public"."acc_vendors" TO "anon";
GRANT ALL ON TABLE "public"."acc_vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."acc_vendors" TO "service_role";



GRANT ALL ON TABLE "public"."admin_panel" TO "anon";
GRANT ALL ON TABLE "public"."admin_panel" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_panel" TO "service_role";



GRANT ALL ON SEQUENCE "public"."admin_panel_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."admin_panel_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."admin_panel_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."apify_scrapers" TO "anon";
GRANT ALL ON TABLE "public"."apify_scrapers" TO "authenticated";
GRANT ALL ON TABLE "public"."apify_scrapers" TO "service_role";



GRANT ALL ON TABLE "public"."audience_segments" TO "anon";
GRANT ALL ON TABLE "public"."audience_segments" TO "authenticated";
GRANT ALL ON TABLE "public"."audience_segments" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_analytics" TO "anon";
GRANT ALL ON TABLE "public"."campaign_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_analytics" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_attachments" TO "anon";
GRANT ALL ON TABLE "public"."campaign_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_contacts" TO "anon";
GRANT ALL ON TABLE "public"."campaign_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "anon";
GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_followup_logs" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_followups" TO "anon";
GRANT ALL ON TABLE "public"."campaign_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_followups" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_schedules" TO "anon";
GRANT ALL ON TABLE "public"."campaign_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_types" TO "anon";
GRANT ALL ON TABLE "public"."campaign_types" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_types" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."case_studies" TO "anon";
GRANT ALL ON TABLE "public"."case_studies" TO "authenticated";
GRANT ALL ON TABLE "public"."case_studies" TO "service_role";



GRANT ALL ON TABLE "public"."client_video" TO "anon";
GRANT ALL ON TABLE "public"."client_video" TO "authenticated";
GRANT ALL ON TABLE "public"."client_video" TO "service_role";



GRANT ALL ON SEQUENCE "public"."client_video_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."client_video_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."client_video_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."company_categories" TO "anon";
GRANT ALL ON TABLE "public"."company_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."company_categories" TO "service_role";



GRANT ALL ON TABLE "public"."company_sizes" TO "anon";
GRANT ALL ON TABLE "public"."company_sizes" TO "authenticated";
GRANT ALL ON TABLE "public"."company_sizes" TO "service_role";



GRANT ALL ON TABLE "public"."contact" TO "anon";
GRANT ALL ON TABLE "public"."contact" TO "authenticated";
GRANT ALL ON TABLE "public"."contact" TO "service_role";



GRANT ALL ON TABLE "public"."contact_list_members" TO "anon";
GRANT ALL ON TABLE "public"."contact_list_members" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_list_members" TO "service_role";



GRANT ALL ON TABLE "public"."contact_lists" TO "anon";
GRANT ALL ON TABLE "public"."contact_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_lists" TO "service_role";



GRANT ALL ON TABLE "public"."contact_types" TO "anon";
GRANT ALL ON TABLE "public"."contact_types" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_types" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."contacts_backup_20260923" TO "anon";
GRANT ALL ON TABLE "public"."contacts_backup_20260923" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts_backup_20260923" TO "service_role";



GRANT ALL ON TABLE "public"."contest_submissions" TO "anon";
GRANT ALL ON TABLE "public"."contest_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."contest_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."contests" TO "anon";
GRANT ALL ON TABLE "public"."contests" TO "authenticated";
GRANT ALL ON TABLE "public"."contests" TO "service_role";



GRANT ALL ON TABLE "public"."custom_filter_options" TO "anon";
GRANT ALL ON TABLE "public"."custom_filter_options" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_filter_options" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."designations" TO "anon";
GRANT ALL ON TABLE "public"."designations" TO "authenticated";
GRANT ALL ON TABLE "public"."designations" TO "service_role";



GRANT ALL ON TABLE "public"."email_logs" TO "anon";
GRANT ALL ON TABLE "public"."email_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."email_logs" TO "service_role";



GRANT ALL ON TABLE "public"."followup_history" TO "anon";
GRANT ALL ON TABLE "public"."followup_history" TO "authenticated";
GRANT ALL ON TABLE "public"."followup_history" TO "service_role";



GRANT ALL ON TABLE "public"."geographies" TO "anon";
GRANT ALL ON TABLE "public"."geographies" TO "authenticated";
GRANT ALL ON TABLE "public"."geographies" TO "service_role";



GRANT ALL ON TABLE "public"."hero_video" TO "anon";
GRANT ALL ON TABLE "public"."hero_video" TO "authenticated";
GRANT ALL ON TABLE "public"."hero_video" TO "service_role";



GRANT ALL ON SEQUENCE "public"."hero_video_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."hero_video_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."hero_video_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."holidays" TO "anon";
GRANT ALL ON TABLE "public"."holidays" TO "authenticated";
GRANT ALL ON TABLE "public"."holidays" TO "service_role";



GRANT ALL ON TABLE "public"."index_video" TO "anon";
GRANT ALL ON TABLE "public"."index_video" TO "authenticated";
GRANT ALL ON TABLE "public"."index_video" TO "service_role";



GRANT ALL ON SEQUENCE "public"."index_video_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."index_video_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."index_video_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."industries" TO "anon";
GRANT ALL ON TABLE "public"."industries" TO "authenticated";
GRANT ALL ON TABLE "public"."industries" TO "service_role";



GRANT ALL ON TABLE "public"."insight" TO "anon";
GRANT ALL ON TABLE "public"."insight" TO "authenticated";
GRANT ALL ON TABLE "public"."insight" TO "service_role";



GRANT ALL ON SEQUENCE "public"."insight_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."insight_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."insight_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lb_case_studies" TO "anon";
GRANT ALL ON TABLE "public"."lb_case_studies" TO "authenticated";
GRANT ALL ON TABLE "public"."lb_case_studies" TO "service_role";



GRANT ALL ON TABLE "public"."lb_categories" TO "anon";
GRANT ALL ON TABLE "public"."lb_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."lb_categories" TO "service_role";



GRANT ALL ON TABLE "public"."lb_insights" TO "anon";
GRANT ALL ON TABLE "public"."lb_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."lb_insights" TO "service_role";



GRANT ALL ON TABLE "public"."lb_members" TO "anon";
GRANT ALL ON TABLE "public"."lb_members" TO "authenticated";
GRANT ALL ON TABLE "public"."lb_members" TO "service_role";



GRANT ALL ON TABLE "public"."lb_product_types" TO "anon";
GRANT ALL ON TABLE "public"."lb_product_types" TO "authenticated";
GRANT ALL ON TABLE "public"."lb_product_types" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."mail_sent_log" TO "anon";
GRANT ALL ON TABLE "public"."mail_sent_log" TO "authenticated";
GRANT ALL ON TABLE "public"."mail_sent_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."mail_sent_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."mail_sent_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."mail_sent_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."mail_sequences" TO "anon";
GRANT ALL ON TABLE "public"."mail_sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."mail_sequences" TO "service_role";



GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."mail_sequences_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."meeting-attachments" TO "anon";
GRANT ALL ON TABLE "public"."meeting-attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting-attachments" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_attachments_backup" TO "anon";
GRANT ALL ON TABLE "public"."meeting_attachments_backup" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_attachments_backup" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_mail_log" TO "anon";
GRANT ALL ON TABLE "public"."meeting_mail_log" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_mail_log" TO "service_role";



GRANT ALL ON TABLE "public"."newsletter_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."newsletter_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."newsletter_subscriptions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."newsletter_subscriptions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."newsletter_subscriptions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."newsletter_subscriptions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."number_of_profiles" TO "anon";
GRANT ALL ON TABLE "public"."number_of_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."number_of_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."openPositions" TO "anon";
GRANT ALL ON TABLE "public"."openPositions" TO "authenticated";
GRANT ALL ON TABLE "public"."openPositions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."openPositions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."openPositions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."openPositions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."prototype" TO "anon";
GRANT ALL ON TABLE "public"."prototype" TO "authenticated";
GRANT ALL ON TABLE "public"."prototype" TO "service_role";



GRANT ALL ON SEQUENCE "public"."prototype_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."prototype_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."prototype_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."remove_timing" TO "anon";
GRANT ALL ON TABLE "public"."remove_timing" TO "authenticated";
GRANT ALL ON TABLE "public"."remove_timing" TO "service_role";



GRANT ALL ON SEQUENCE "public"."remove_timing_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."remove_timing_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."remove_timing_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."rfq" TO "anon";
GRANT ALL ON TABLE "public"."rfq" TO "authenticated";
GRANT ALL ON TABLE "public"."rfq" TO "service_role";



GRANT ALL ON TABLE "public"."rfq_followup_audit" TO "anon";
GRANT ALL ON TABLE "public"."rfq_followup_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."rfq_followup_audit" TO "service_role";



GRANT ALL ON SEQUENCE "public"."rfq_followup_audit_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."rfq_followup_audit_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."rfq_followup_audit_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."rfq_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."rfq_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."rfq_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_branch_step_attachments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sequence_branch_step_attachments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "anon";
GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_branch_steps" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sequence_branch_steps_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_enrollments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_enrollments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_enrollments" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "anon";
GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_step_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_step_batch_state" TO "anon";
GRANT ALL ON TABLE "public"."sequence_step_batch_state" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_step_batch_state" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_step_logs" TO "anon";
GRANT ALL ON TABLE "public"."sequence_step_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_step_logs" TO "service_role";



GRANT ALL ON TABLE "public"."sequence_steps" TO "anon";
GRANT ALL ON TABLE "public"."sequence_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."sequence_steps" TO "service_role";



GRANT ALL ON TABLE "public"."sequences" TO "anon";
GRANT ALL ON TABLE "public"."sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."sequences" TO "service_role";



GRANT ALL ON TABLE "public"."slide1" TO "anon";
GRANT ALL ON TABLE "public"."slide1" TO "authenticated";
GRANT ALL ON TABLE "public"."slide1" TO "service_role";



GRANT ALL ON TABLE "public"."slide10" TO "anon";
GRANT ALL ON TABLE "public"."slide10" TO "authenticated";
GRANT ALL ON TABLE "public"."slide10" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide10_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide10_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide10_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide11" TO "anon";
GRANT ALL ON TABLE "public"."slide11" TO "authenticated";
GRANT ALL ON TABLE "public"."slide11" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide11_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide11_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide11_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide1_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide1_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide1_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide2" TO "anon";
GRANT ALL ON TABLE "public"."slide2" TO "authenticated";
GRANT ALL ON TABLE "public"."slide2" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide2_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide2_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide2_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide3" TO "anon";
GRANT ALL ON TABLE "public"."slide3" TO "authenticated";
GRANT ALL ON TABLE "public"."slide3" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide3_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide3_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide3_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide4" TO "anon";
GRANT ALL ON TABLE "public"."slide4" TO "authenticated";
GRANT ALL ON TABLE "public"."slide4" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide4_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide4_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide4_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide5" TO "anon";
GRANT ALL ON TABLE "public"."slide5" TO "authenticated";
GRANT ALL ON TABLE "public"."slide5" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide5_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide5_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide5_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide6" TO "anon";
GRANT ALL ON TABLE "public"."slide6" TO "authenticated";
GRANT ALL ON TABLE "public"."slide6" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide6_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide6_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide6_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide7" TO "anon";
GRANT ALL ON TABLE "public"."slide7" TO "authenticated";
GRANT ALL ON TABLE "public"."slide7" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide7_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide7_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide7_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide8" TO "anon";
GRANT ALL ON TABLE "public"."slide8" TO "authenticated";
GRANT ALL ON TABLE "public"."slide8" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide8_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide8_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide8_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."slide9" TO "anon";
GRANT ALL ON TABLE "public"."slide9" TO "authenticated";
GRANT ALL ON TABLE "public"."slide9" TO "service_role";



GRANT ALL ON SEQUENCE "public"."slide9_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."slide9_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."slide9_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."stages" TO "anon";
GRANT ALL ON TABLE "public"."stages" TO "authenticated";
GRANT ALL ON TABLE "public"."stages" TO "service_role";



GRANT ALL ON TABLE "public"."states" TO "anon";
GRANT ALL ON TABLE "public"."states" TO "authenticated";
GRANT ALL ON TABLE "public"."states" TO "service_role";



GRANT ALL ON SEQUENCE "public"."states_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."states_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."states_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."techno_commercial" TO "anon";
GRANT ALL ON TABLE "public"."techno_commercial" TO "authenticated";
GRANT ALL ON TABLE "public"."techno_commercial" TO "service_role";



GRANT ALL ON TABLE "public"."templates" TO "anon";
GRANT ALL ON TABLE "public"."templates" TO "authenticated";
GRANT ALL ON TABLE "public"."templates" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."venture_form_data" TO "anon";
GRANT ALL ON TABLE "public"."venture_form_data" TO "authenticated";
GRANT ALL ON TABLE "public"."venture_form_data" TO "service_role";



GRANT ALL ON SEQUENCE "public"."venture_form_data_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."venture_form_data_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."venture_form_data_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."videos" TO "anon";
GRANT ALL ON TABLE "public"."videos" TO "authenticated";
GRANT ALL ON TABLE "public"."videos" TO "service_role";



GRANT ALL ON TABLE "public"."weekly_email_queue" TO "anon";
GRANT ALL ON TABLE "public"."weekly_email_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_email_queue" TO "service_role";



GRANT ALL ON TABLE "public"."weekly_email_queue_backup_20260923" TO "anon";
GRANT ALL ON TABLE "public"."weekly_email_queue_backup_20260923" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_email_queue_backup_20260923" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_logs" TO "anon";
GRANT ALL ON TABLE "public"."whatsapp_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_logs" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_message" TO "anon";
GRANT ALL ON TABLE "public"."whatsapp_message" TO "authenticated";
GRANT ALL ON TABLE "public"."whatsapp_message" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































