/**
 * scheduled-campaign-runner — Supabase Edge Function (cloud scheduler).
 *
 * Triggered by a Supabase pg_cron job every minute (see
 * supabase/scheduled-campaign-setup.sql). It finds campaigns whose scheduled
 * IST date/time has arrived and sends them directly to Gmail SMTP — so a
 * campaign fires at/after its scheduled time even when the laptop (local
 * Node.js backend) is completely OFF.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS FUNCTION SENDS THE EMAILS ITSELF
 * ────────────────────────────────────────────────────────────────────────────
 * The existing Node.js sender (emailWorker.js + Nodemailer) cannot run inside
 * a Supabase Edge Function:
 *   - Edge Functions run on Deno; Nodemailer depends on Node's `net`/`tls`
 *     modules which the Deno Deploy runtime does not provide.
 *   - Outbound connections from Edge Functions to SMTP ports 25 and 587 are
 *     BLOCKED; only port 465 (implicit TLS) is allowed.
 *   - The local backend is unreachable while the laptop is off, so the Edge
 *     Function cannot "trigger" it either.
 * Therefore this function performs the send itself with a small, self-contained
 * SMTP client (Deno.connectTls → smtp.gmail.com:465). It deliberately reuses
 * the exact same conventions as the existing worker so nothing downstream
 * changes:
 *   - Same tables: campaigns, campaign_contacts, email_logs, campaign_analytics
 *   - Same status flow: scheduled → sending → sent (or failed)
 *   - Same merge tags: {{first_name}}, {{company}}, {{designation}}, {{email}}
 *   - Same open-tracking pixel: the existing `campaign-tracker` Edge Function
 *   - Same per-recipient retry semantics (3 retries, then 'failed')
 * Normal/manual sends keep going through the local backend unchanged.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * DUPLICATE-SEND PROTECTION (cron runs every minute):
 *   - Campaign claim: UPDATE campaigns SET status='sending'
 *       WHERE id=... AND status='scheduled'  (atomic — one winner only)
 *   - Recipient claim: UPDATE email_logs SET status='sending'
 *       WHERE campaign_id=... AND status='pending' (atomic — a recipient is
 *       only ever sent by the invocation that claimed its email_log row)
 *   - Budget exit: claimed-but-unsent logs are released back to 'pending' and
 *     the campaign is returned to 'scheduled' (only when recipients remain),
 *     so the next cron tick drains the remainder instead of orphaning it.
 *   - Recovery: campaigns/logs stuck in 'sending' for >10 min (crashed run)
 *     are reclaimed so interrupted sends resume instead of being orphaned.
 *   - A campaign whose logs are all 'sent'/'failed' is marked 'sent' and is
 *     never selected again.
 *
 * TIMEZONE:
 *   The UI stores schedule_date ("YYYY-MM-DD") and schedule_time (12h/24h) as
 *   IST wall-clock (Asia/Kolkata — the app's intended timezone). This function
 *   ports parseTime/istDateTimeToUtc from backend/services/campaignScheduler.js
 *   verbatim: the wall-clock time is converted to its absolute UTC instant by
 *   Date.UTC(...) - (5h30m), independent of where the function runs. It never
 *   blindly adds/subtracts hours, so 7:00 PM always means 7:00 PM IST.
 *
 * SECRETS (never hard-coded, never logged):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY          — auto-injected by Supabase
 *   SMTP_HOST, SMTP_PORT (465), SMTP_USER, SMTP_PASSWORD,
 *   SMTP_FROM, SMTP_FROM_NAME, SMTP_REPLY_TO         — supabase secrets set
 *   CRON_SECRET                                      — shared secret sent by the
 *                                                     cron job via x-cron-secret
 *   TRACKING_BASE_URL                                — optional; when set, the
 *                                                     legacy click/open rewrite is
 *                                                     also embedded (same as normal
 *                                                     sends). Leave empty on edge.
 *   EDGE_FUNCTION_URL                                — optional override of the
 *                                                     campaign-tracker pixel base.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { personalizeTemplate } from '../_shared/personalization.ts';
import { toEmailSafeHtml } from '../_shared/email-render.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Configuration (env) ───────────────────────────────────────────────────
const CRON_SECRET = (Deno.env.get('CRON_SECRET') || '').trim();

const SMTP_HOST = (Deno.env.get('SMTP_HOST') || 'smtp.gmail.com').trim();
const SMTP_PORT = parseInt(Deno.env.get('SMTP_PORT') || '465', 10);
const SMTP_USER = (Deno.env.get('SMTP_USER') || '').trim();
const SMTP_PASSWORD = Deno.env.get('SMTP_PASSWORD') || '';
const SMTP_FROM_NAME = (Deno.env.get('SMTP_FROM_NAME') || '').trim();
const SMTP_FROM_ADDR = (Deno.env.get('SMTP_FROM') || '').trim() || SMTP_USER;
const SMTP_REPLY_TO = (Deno.env.get('SMTP_REPLY_TO') || '').trim() || SMTP_FROM_ADDR;

const EDGE_FUNCTION_BASE =
  (Deno.env.get('EDGE_FUNCTION_URL') || '').trim().replace(/\/+$/, '') ||
  `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;

// Pacing / budget. The free-tier Edge Function wall-clock limit is 150s, so a
// run stays well under it and drains large campaigns across a few cron ticks.
const EMAIL_DELAY_MS = Math.max(0, parseInt(Deno.env.get('EMAIL_DELAY_MS') || '250', 10));
const MAX_EMAILS_PER_RUN = Math.max(1, parseInt(Deno.env.get('MAX_EMAILS_PER_RUN') || '60', 10));
const TIME_BUDGET_MS = Math.max(1000, parseInt(Deno.env.get('TIME_BUDGET_MS') || '100000', 10));
const RECLAIM_AFTER_MS = 10 * 60 * 1000; // campaigns/logs stuck >10min are recoverable
const RETRY_DELAYS = [30, 60, 120]; // seconds — matches the backend worker
const MAX_RETRIES = RETRY_DELAYS.length;

// IST (Asia/Kolkata) = UTC+05:30.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function log(...args: unknown[]) {
  console.log('[Scheduler]', ...args);
}
function logErr(...args: unknown[]) {
  console.error('[Scheduler]', ...args);
}

// ─── Time helpers (ported verbatim from campaignScheduler.js) ─────────────
function parseTime(timeStr: string): { hours: number; minutes: number; seconds: number } | null {
  if (!timeStr) return null;
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  const meridian = (match[4] || '').toUpperCase();
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  if (meridian === 'PM' && hours !== 12) hours += 12;
  if (meridian === 'AM' && hours === 12) hours = 0;
  return { hours, minutes, seconds };
}

function istDateTimeToUtc(dateStr: string, timeStr: string): Date | null {
  if (!dateStr || !timeStr) return null;
  const dateMatch = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const time = parseTime(timeStr);
  if (!time) return null;
  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);
  const localCalendar = new Date(Date.UTC(year, month - 1, day));
  if (
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() !== month - 1 ||
    localCalendar.getUTCDate() !== day
  ) {
    return null;
  }
  const asUtc = Date.UTC(year, month - 1, day, time.hours, time.minutes, time.seconds);
  const utcInstant = new Date(asUtc - IST_OFFSET_MS);
  return Number.isNaN(utcInstant.getTime()) ? null : utcInstant;
}

function todayISTDateStr(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};
const WEEK_NUMBERS = ['First', 'Second', 'Third', 'Fourth', 'Last'];

/**
 * Compute the next run instant (UTC Date) for a campaign_schedules row.
 * Ported verbatim from backend/utils/scheduleTime.js.
 */
function computeNextRun(schedule: any): Date | null {
  if (!schedule || !schedule.schedule_type) return null;
  const time = parseTime(schedule.send_time);
  if (!time) return null;

  const anchorStr = schedule.start_date || todayISTDateStr();
  const match = String(anchorStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const nowUtc = Date.now();
  const instant = (y: number, mo: number, d: number): Date | null => istDateTimeToUtc(
    `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    schedule.send_time
  );

  if (schedule.schedule_type === 'one_time') {
    return instant(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  if (schedule.schedule_type === 'weekly') {
    const days = Array.isArray(schedule.weekly_days)
      ? schedule.weekly_days
      : String(schedule.weekly_days || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (days.length === 0) return null;
    const selectedIdx = new Set(days.map((d: string) => WEEKDAY_INDEX[d]).filter((i: number | undefined) => i != null));
    if (selectedIdx.size === 0) return null;

    const interval = Math.max(1, Number(schedule.repeat_interval) || 1);
    const anchorDay = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const anchorEpochDays = Math.floor(anchorDay.getTime() / 86400000);

    for (let offset = 0; offset < 365; offset++) {
      const candidate = new Date((anchorEpochDays + offset) * 86400000);
      if (!selectedIdx.has(candidate.getUTCDay())) continue;
      const weeksElapsed = Math.floor(offset / 7);
      if (weeksElapsed % interval !== 0) continue;
      const next = instant(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate());
      if (next && next.getTime() >= nowUtc) return next;
    }
    return null;
  }

  if (schedule.schedule_type === 'monthly') {
    const interval = Math.max(1, Number(schedule.repeat_interval) || 1);
    let y = Number(match[1]);
    let mo = Number(match[2]) - 1;

    for (let i = 0; i < 120; i++) {
      const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let candidateDay;

      if (schedule.monthly_type === 'day_of_month') {
        candidateDay = Math.max(1, Math.min(daysInMonth, Number(schedule.day_of_month) || 1));
      } else {
        const wd = WEEKDAY_INDEX[schedule.weekday];
        const wn = WEEK_NUMBERS.indexOf(schedule.week_number);
        if (wd == null || wn === -1) return null;
        const firstWeekday = new Date(Date.UTC(y, mo, 1)).getUTCDay();
        if (wn === WEEK_NUMBERS.length - 1) {
          const lastWeekday = new Date(Date.UTC(y, mo, daysInMonth)).getUTCDay();
          candidateDay = daysInMonth - ((lastWeekday - wd + 7) % 7);
        } else {
          candidateDay = 1 + ((wd - firstWeekday + 7) % 7) + wn * 7;
        }
      }

      const next = instant(y, mo, candidateDay);
      if (next && next.getTime() >= nowUtc) return next;

      const nextMonth = new Date(Date.UTC(y, mo + interval, 1));
      y = nextMonth.getUTCFullYear();
      mo = nextMonth.getUTCMonth();
    }
    return null;
  }

  return null;
}

/**
 * Whether a scheduled campaign is due NOW. Any of these being <= now makes it
 * due (mirrors backend/utils/scheduleTime.js isCampaignDue):
 *   - legacy IST wall-clock (campaigns.schedule_date/schedule_time),
 *   - campaigns.scheduled_at (absolute timestamptz),
 *   - a one_time campaign_schedules row (start_date + send_time),
 *   - a recurring schedule whose next_run (or recomputed next run) has arrived.
 * Overdue campaigns are always due, so they fire on the very next cron tick.
 */
function isCampaignDue(campaign: any, schedule: any, nowMs: number): boolean {
  const now = nowMs == null ? Date.now() : nowMs;

  const legacy = istDateTimeToUtc(campaign.schedule_date, campaign.schedule_time);
  if (legacy !== null && legacy.getTime() <= now) return true;

  if (campaign.scheduled_at) {
    const at = new Date(campaign.scheduled_at).getTime();
    if (!Number.isNaN(at) && at <= now) return true;
  }

  if (schedule) {
    if (schedule.schedule_type === 'one_time') {
      const at = istDateTimeToUtc(schedule.start_date, schedule.send_time);
      if (at !== null && at.getTime() <= now) return true;
    } else if (schedule.schedule_type === 'weekly' || schedule.schedule_type === 'monthly') {
      let next = schedule.next_run ? new Date(schedule.next_run).getTime() : null;
      if (next === null || Number.isNaN(next)) {
        const recomputed = computeNextRun(schedule);
        next = recomputed ? recomputed.getTime() : null;
      }
      if (next !== null && next <= now) return true;
    }
  }

  return false;
}

async function getCampaignSchedule(campaignId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('campaign_schedules')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('is_active', true)
    .maybeSingle();
  if (error && error.code !== '42P01') {
    throw new Error(`Failed to fetch schedule for campaign ${campaignId}: ${error.message}`);
  }
  return data || null;
}

// ─── Campaign discovery + atomic claim ─────────────────────────────────────
/**
 * Is a batched campaign due for its NEXT batch right now?
 *
 * Batched campaigns (send_in_batches=true, batch_size > 0) are queued by the
 * React UI: the follow-up campaign is set status='scheduled' and next_batch_at
 * is the instant the next batch should fire. A campaign is due when:
 *   - it is a FRESH queue (current_batch_number === 0 — no batch sent yet):
 *     the FIRST batch fires immediately regardless of next_batch_at, OR
 *   - next_batch_at is null or has already passed.
 * Queueing the first batch never has to wait: the UI pre-loads next_batch_at
 * with the "after first batch" time (so the Schedule column can display it
 * right away) while current_batch_number===0 keeps the first batch due now.
 * Once every eligible recipient is drained, next_batch_at is cleared back to
 * null AND status is set to 'sent', so a completed batch campaign is never
 * re-selected (status check below).
 */
function isBatchedCampaignDue(campaign: any, nowMs: number): boolean {
  if (campaign.send_in_batches !== true) return false;
  const batchSize = Number(campaign.batch_size);
  if (!(Number.isInteger(batchSize) && batchSize > 0)) return false;
  // Round-trip through the same counter the runner increments after every
  // batch; a campaign that has never fired a batch is due right now.
  const batchNumber = Number(campaign.current_batch_number) || 0;
  if (batchNumber === 0) return true;
  const next = campaign.next_batch_at ? new Date(campaign.next_batch_at).getTime() : null;
  return next === null || (!Number.isNaN(next) && next <= nowMs);
}

/**
 * Find campaigns that are scheduled AND due. Every status='scheduled' campaign
 * is examined together with its campaign_schedules row (see isCampaignDue):
 * legacy IST wall-clock, scheduled_at, one_time schedules and recurring
 * (weekly/monthly) next_run are all considered. Overdue campaigns are due, so
 * anything whose time passed while nobody was watching is picked up now.
 *
 * Batched campaigns that have NO calendar schedule are picked up here too via
 * isBatchedCampaignDue — the UI queues them with status='scheduled' and the
 * scheduler drains them one batch per tick.
 */
async function getDueCampaigns(): Promise<any[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*, campaign_schedules(*)')
    .eq('status', 'scheduled');
  if (error) throw error;

  const now = Date.now();
  const due: any[] = [];
  for (const campaign of data || []) {
    const schedules = (campaign.campaign_schedules || [])
      .filter((s: any) => s && s.is_active !== false);
    const schedule = schedules.length > 0 ? schedules[0] : null;
    if (isCampaignDue(campaign, schedule, now)) {
      log(`Campaign ${campaign.id} ("${campaign.campaign_name}") is overdue and due`);
      due.push(campaign);
    } else if (isBatchedCampaignDue(campaign, now)) {
      log(`Campaign ${campaign.id} ("${campaign.campaign_name}") is due for its next batch`);
      due.push(campaign);
    } else if (campaign.schedule_date || campaign.scheduled_at || schedule || campaign.send_in_batches === true) {
      log(`Campaign ${campaign.id} ("${campaign.campaign_name}") not due yet — skipped`);
    }
  }
  return due;
}

async function getStuckSendingCampaigns(): Promise<any[]> {
  const cutoff = new Date(Date.now() - RECLAIM_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'sending')
    .lt('updated_at', cutoff);
  if (error) throw error;
  return data || [];
}

/**
 * Atomically claim a due campaign. Only ONE invocation can transition
 * 'scheduled' → 'sending', so concurrent cron ticks can never double-send.
 */
async function claimCampaign(id: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('campaigns')
    .update({ status: 'sending', updated_at: nowIso })
    .eq('id', id)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Failed to claim campaign ${id}: ${error.message}`);
  return data != null;
}

// ─── Recipient resolution (ported from supabaseService.js) ─────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_DELIVERABLE_EMAIL_RE =
  /(^__)|@example\.(com|org|net|edu)$|\.(test|invalid|localhost|local)$/i;

function isDeliverableRecipientEmail(email: string): boolean {
  const value = String(email || '').trim();
  if (!value) return false;
  if (!EMAIL_REGEX.test(value)) return false;
  return !NON_DELIVERABLE_EMAIL_RE.test(value);
}

async function resolveContactsForCampaign(
  campaignId: string,
  audienceSegment: string
): Promise<{
  contacts: any[];
  sourceCampaignId: string | null;
  openedAtByContact: Map<string, string | null>;
}> {
  // Follow-up rule: a campaign that is configured as a FOLLOW-UP (row in
  // campaign_followups with followup_campaign_id = this campaign) only ever
  // sends to the contacts who opened the ORIGINAL campaign.
  const { data: configs, error: cfgError } = await supabase
    .from('campaign_followups')
    .select('campaign_id')
    .eq('followup_campaign_id', campaignId)
    .limit(1);
  if (cfgError && cfgError.code !== '42P01') {
    throw new Error(`Failed to check follow-up config: ${cfgError.message}`);
  }

  let valid: any[];
  const sourceCampaignId = configs && configs[0] && configs[0].campaign_id ? String(configs[0].campaign_id) : null;
  const openedAtByContact = new Map<string, string | null>();

  if (sourceCampaignId) {
    const { data: openedLogs, error: openedError } = await supabase
      .from('email_logs')
      .select('contact_id, opened_at')
      .eq('campaign_id', sourceCampaignId)
      .eq('opened', true);
    if (openedError) throw new Error(`Failed to fetch opened contacts: ${openedError.message}`);
    // Prefer the MOST RECENT open per contact so follow-up bookkeeping records
    // the same opened_at the opener actually engaged on.
    for (const r of openedLogs || []) {
      const cid = String(r.contact_id);
      const ts = r.opened_at ? new Date(r.opened_at).getTime() : 0;
      const prev = openedAtByContact.get(cid) ? new Date(openedAtByContact.get(cid)!).getTime() : 0;
      if (!openedAtByContact.has(cid) || ts >= prev) openedAtByContact.set(cid, r.opened_at || null);
    }
    const openedIds = Array.from(new Set((openedLogs || []).map((r: any) => r.contact_id)));
    if (openedIds.length === 0) {
      valid = [];
    } else {
      const { data: rows, error: contactsError } = await supabase
        .from('contacts')
        .select('*')
        .in('id', openedIds);
      if (contactsError) throw new Error(`Failed to fetch follow-up contacts: ${contactsError.message}`);
      valid = (rows || []).filter((c: any) => isDeliverableRecipientEmail(c.email));
    }
    if (valid.length === 0) {
      log(`Campaign ${campaignId} is a follow-up of ${sourceCampaignId} — no opened recipients found; 0 recipients.`);
    }
  } else {
    const segment = String(audienceSegment || '').trim();
    let query = supabase.from('contacts').select('*');
    if (segment && segment !== 'All Contacts') {
      // Filter by contact_type exactly matching the selected audience segment
      query = query.eq('contact_type', segment);
    }
    const { data: contacts, error } = await query;
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

    const seenEmails = new Set<string>();
    valid = (contacts || []).filter((c: any) => {
      if (!isDeliverableRecipientEmail(c.email)) return false;
      const key = String(c.email).trim().toLowerCase();
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });
  }

  // Link resolved contacts to campaign_contacts (idempotent) — keeps the DB
  // consistent with what the local worker would have written.
  if (valid.length > 0) {
    const { data: existing, error: existingError } = await supabase
      .from('campaign_contacts')
      .select('contact_id')
      .eq('campaign_id', campaignId);
    if (existingError && existingError.code !== '42P01') {
      throw new Error(`Failed to fetch existing campaign contacts: ${existingError.message}`);
    }
    const existingIds = new Set((existing || []).map((r: any) => r.contact_id));
    const newRows = valid
      .filter((c: any) => !existingIds.has(c.id))
      .map((c: any) => ({ campaign_id: campaignId, contact_id: c.id }));
    if (newRows.length > 0) {
      const { error: insertError } = await supabase.from('campaign_contacts').insert(newRows);
      if (insertError && insertError.code !== '42P01') {
        throw new Error(`Failed to link campaign contacts: ${insertError.message}`);
      }
    }
  }

  return { contacts: valid, sourceCampaignId, openedAtByContact };
}

// ─── email_logs helpers ────────────────────────────────────────────────────
async function createEmailLogs(campaignId: string, contacts: any[]): Promise<void> {
  if (contacts.length === 0) return;
  const rows = contacts.map((c: any) => ({
    campaign_id: campaignId,
    contact_id: c.id,
    email: c.email,
    status: 'pending',
    retry_count: 0,
    tracking_id: crypto.randomUUID(),
  }));
  const { error } = await supabase.from('email_logs').insert(rows);
  if (error) {
    // email_logs may predate the tracking columns → retry without tracking_id.
    if (error.code === '42703') {
      const { error: err2 } = await supabase.from('email_logs').insert(
        rows.map(({ tracking_id: _t, ...rest }) => rest)
      );
      if (err2 && err2.code !== '23505') throw new Error(`Failed to create email logs: ${err2.message}`);
    } else if (error.code !== '23505') {
      throw new Error(`Failed to create email logs: ${error.message}`);
    }
  }
  log(`Queued ${contacts.length} recipient(s) for campaign ${campaignId}`);
}

async function getLogsByCampaign(campaignId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('email_logs')
    .select('*')
    .eq('campaign_id', campaignId);
  if (error) throw new Error(`Failed to fetch email logs: ${error.message}`);
  return data || [];
}

/**
 * Atomically claim the pending email_logs for a campaign (pending → sending),
 * optionally limited to `limit` rows so a batched campaign sends exactly its
 * configured batch size per invocation. Rows returned are the ONLY ones this
 * invocation is allowed to send.
 *
 * IMPORTANT: the limit is enforced with a two-step SELECT-then-UPDATE (id list
 * pinned by `.eq('status','pending')`), never by relying on PostgREST to honor
 * `.limit()` on an UPDATE — PATCH+limit is not reliably supported, and that
 * would make a "batch_size=1" follow-up claim ALL pending rows instead of one.
 * This is the same pattern used by the shared `_shared/batch.ts` helper.
 */
async function claimPendingLogs(campaignId: string, limit?: number): Promise<any[]> {
  const nowIso = new Date().toISOString();

  // Step 1 — deterministically select the IDs to claim (SELECT supports limit).
  let select = supabase
    .from('email_logs')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`);
  if (limit && limit > 0) select = select.limit(limit);
  const { data: pending, error: selErr } = await select;
  if (selErr) throw new Error(`Failed to fetch pending logs: ${selErr.message}`);
  if (!pending || pending.length === 0) return [];

  const ids = (pending as any[]).map((p) => p.id);

  // Step 2 — claim exactly those IDs (status='pending' re-check keeps it atomic:
  // a row already claimed by a concurrent tick in the meantime is left alone).
  const { data, error } = await supabase
    .from('email_logs')
    .update({ status: 'sending', last_attempt_at: nowIso })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*');
  if (error) throw new Error(`Failed to claim pending logs: ${error.message}`);
  return data || [];
}

/** Reclaim logs stuck in 'sending' by a crashed invocation (>10 min). */
async function recoverStuckLogs(campaignId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RECLAIM_AFTER_MS).toISOString();
  const { error } = await supabase
    .from('email_logs')
    .update({ status: 'pending' })
    .eq('campaign_id', campaignId)
    .eq('status', 'sending')
    .lt('last_attempt_at', cutoff);
  if (error) throw new Error(`Failed to recover stuck logs: ${error.message}`);
}

/** On budget exit, release logs WE claimed (last_attempt_at <= our claim time). */
async function releaseClaimedLogs(campaignId: string, claimTimeIso: string): Promise<void> {
  const { error } = await supabase
    .from('email_logs')
    .update({ status: 'pending' })
    .eq('campaign_id', campaignId)
    .eq('status', 'sending')
    .lte('last_attempt_at', claimTimeIso);
  if (error) throw new Error(`Failed to release claimed logs: ${error.message}`);
}

async function updateEmailLog(id: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('email_logs').update(updates).eq('id', id);
  if (error) throw new Error(`Failed to update email log ${id}: ${error.message}`);
}

/**
 * Write a terminal/status update ONLY while this invocation still owns the
 * campaign claim ('sending'). Guarding with status='sending' means a stale
 * finalize can never stomp a campaign that a concurrent tick already claimed,
 * advanced to its next recurring occurrence, or finalized.
 */
async function finalizeCampaign(campaignId: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('status', 'sending');
  if (error) throw new Error(`Failed to finalize campaign ${campaignId}: ${error.message}`);
}

async function getLogsStats(campaignId: string) {
  const logs = await getLogsByCampaign(campaignId);
  const delivered = logs.filter((l) => l.status === 'sent').length;
  const failed = logs.filter((l) => l.status === 'failed').length;
  const pending = logs.filter((l) => l.status === 'pending').length;
  const opened = logs.filter((l) => l.opened === true).length;
  const clicked = logs.filter((l) => l.clicked === true).length;
  return {
    total: logs.length,
    delivered,
    failed,
    pending,
    opened,
    clicked,
    open_rate: delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0,
    click_rate: delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0,
  };
}

/**
 * Record a delivered follow-up in campaign_followup_logs so the UI's
 * eligibility bookkeeping (remaining_eligible / sent_count) stays correct when
 * the scheduler — not the browser — delivers the follow-up. Idempotent: the
 * UNIQUE (campaign_id, contact_id, followup_campaign_id) constraint makes a
 * repeated delivery a no-op, exactly as in send-followup Edge Function.
 */
async function recordFollowupDelivery(
  followupCampaignId: string,
  sourceCampaignId: string,
  contactId: string,
  email: string,
  openedAt: string | null
): Promise<void> {
  const sentAt = new Date().toISOString();
  const { error } = await supabase
    .from('campaign_followup_logs')
    .upsert(
      {
        campaign_id: sourceCampaignId,
        contact_id: contactId,
        email,
        followup_campaign_id: followupCampaignId,
        opened_at: openedAt || null,
        status: 'sent',
        sent_at: sentAt,
      },
      { onConflict: 'campaign_id,contact_id,followup_campaign_id' }
    );
  if (error && error.code !== '42P01' && error.code !== '42703') {
    logErr(`Could not record follow-up delivery for ${email}: ${error.message}`);
  }
}

// ─── Analytics sync (ported from emailLogService.syncCampaignAnalytics) ────
async function syncCampaignAnalytics(campaignId: string): Promise<void> {
  const stats = await getLogsStats(campaignId);
  const { error } = await supabase
    .from('campaign_analytics')
    .upsert(
      {
        campaign_id: campaignId,
        total_recipients: stats.total,
        delivered: stats.delivered,
        opened: stats.opened,
        clicked: stats.clicked,
        open_rate: stats.delivered > 0
          ? Number(((stats.opened / stats.delivered) * 100).toFixed(1))
          : 0,
        click_rate: stats.delivered > 0
          ? Number(((stats.clicked / stats.delivered) * 100).toFixed(1))
          : 0,
      },
      { onConflict: 'campaign_id' }
    );
  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('cannot insert into view') || message.includes('cannot update view') || message.includes('55000')) {
      log('campaign_analytics is a view; skipping analytics sync.');
      return;
    }
    throw new Error(`Failed to sync analytics: ${error.message}`);
  }
}

// ─── Personalization ───────────────────────────────────────────────────────
// Merge tags resolve against the actual recipient row from public.contacts via
// the shared _shared/personalization.ts helper (no hard-coded placeholder list).
function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(html: string): string {
  return String(html || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

function hasHtmlTags(str: string): boolean {
  return /<\s*(\/)?\s*[a-zA-Z][^>]*>/.test(String(str || ''));
}

function plainTextToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let openList: string | null = null;
  let paragraph: string[] = [];
  const closeList = () => {
    if (openList) {
      out.push(`</${openList}>`);
      openList = null;
    }
  };
  const emitParagraph = () => {
    if (paragraph.length) {
      closeList();
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      emitParagraph();
      closeList();
      continue;
    }
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || number) {
      emitParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (openList !== type) {
        closeList();
        out.push(`<${type}>`);
        openList = type;
      }
      out.push(`<li>${(bullet ? bullet[2] : number![2]).trim()}</li>`);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  emitParagraph();
  closeList();
  return out.join('\n');
}

function wrapHtmlDocument(html: string): string {
  const value = String(html || '');
  if (!value.trim()) return value;
  if (/<!doctype\b|<\s*html\b|<\s*head\b/i.test(value)) return value;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>img{border:0;max-width:100%;}a{color:#1a73e8;}table{border-collapse:collapse;}</style>',
    '</head>',
    '<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#333333;">',
    value,
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Rewrites every clickable external URL in the personalized HTML to the
 * click-tracker Edge Function, which records the click on this email_log
 * (tracking_id → clicked/clicked_at) and 302-redirects to the destination.
 *
 * - Existing <a href="http(s)://..."> anchors get their href rewritten.
 * - Bare http(s):// URLs in the text are auto-wrapped in a tracked anchor.
 * - mailto:, #anchors, relative URLs and URLs in non-href attributes (e.g.
 *   <img src="...">) are left untouched, so the open pixel keeps working.
 */
function rewriteLinksForTracking(html: string, trackingId: string, baseUrl: string): string {
  const clickUrl = (url: string) =>
    `${baseUrl}/click-tracker?tracking_id=${encodeURIComponent(trackingId)}&url=${encodeURIComponent(url)}`;
  const HREF_RE = /(\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)(["'])/gi;
  const TOKEN_RE = /(<[^>]*>)|(https?:\/\/[^\s<>"']+)/gi;

  return String(html || '').replace(TOKEN_RE, (match, tag: string, bareUrl: string) => {
    if (tag) {
      return tag.replace(HREF_RE, (m, p: string, q: string, url: string, q2: string) => {
        if (url.includes('/click-tracker')) return m;
        return `${p}${q}${clickUrl(url)}${q2}`;
      });
    }
    const clean = bareUrl.replace(/[\.,;:!?\)\]\}]+$/, '');
    if (!/^https?:\/\//i.test(clean)) return match;
    const punct = bareUrl.slice(clean.length);
    return `<a href="${clickUrl(clean)}">${clean}</a>${punct}`;
  });
}

/** Always-reachable open pixel handled by the existing campaign-tracker function. */
function appendEdgeTrackingPixel(
  html: string,
  campaignId: string,
  contactEmail: string,
  trackingId: string
): string {
  const params = new URLSearchParams({
    action: 'track',
    campaign_id: campaignId,
    contact_email: contactEmail,
    tracking_id: trackingId,
  });
  const pixelUrl = `${EDGE_FUNCTION_BASE}/campaign-tracker?${params.toString()}`;
  const pixel =
    `<img src="${pixelUrl}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${pixel}\n</body>`)
    : `${html}\n${pixel}`;
}

// ─── Minimal SMTP client (Deno → smtp.gmail.com:465, implicit TLS) ─────────
function b64EncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64EncodeUtf8(text: string): string {
  return b64EncodeBytes(new TextEncoder().encode(text));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP operation timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** RFC 2047 encoded-word for non-ASCII headers (Subject / display name). */
function encodeHeader(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${b64EncodeUtf8(value)}?=`;
}

class SmtpSession {
  private conn!: Deno.Conn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  async connect(hostname: string, port: number): Promise<void> {
    this.conn = await withTimeout(Deno.connectTls({ hostname, port }), this.timeoutMs);
    this.reader = this.conn.readable.getReader();
    await this.readReply([220]); // consume the server greeting
  }

  private async readLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf('\n');
      if (idx !== -1) {
        const line = this.buf.slice(0, idx).replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        return line;
      }
      const chunk = await withTimeout(this.reader.read(), this.timeoutMs);
      if (chunk.done) throw new Error('SMTP connection closed unexpectedly');
      this.buf += new TextDecoder().decode(chunk.value);
    }
  }

  private async readReply(expected: number[]): Promise<void> {
    let lastCode = 0;
    let text = '';
    while (true) {
      const line = await this.readLine();
      lastCode = parseInt(line.slice(0, 3), 10);
      text = line.slice(4);
      if (line.length < 4 || line[3] !== '-') break;
    }
    if (!expected.includes(lastCode)) {
      throw new Error(`SMTP error ${lastCode}: ${text}`);
    }
  }

  private async cmd(line: string): Promise<void> {
    await withTimeout(this.conn.write(new TextEncoder().encode(line + '\r\n')), this.timeoutMs);
  }

  async ehlo(domain: string): Promise<void> {
    await this.cmd(`EHLO ${domain}`);
    await this.readReply([250]);
  }

  async authPlain(user: string, pass: string): Promise<void> {
    const payload = new Uint8Array(user.length + pass.length + 2);
    let i = 0;
    payload[i++] = 0;
    for (let j = 0; j < user.length; j++) payload[i++] = user.charCodeAt(j);
    payload[i++] = 0;
    for (let j = 0; j < pass.length; j++) payload[i++] = pass.charCodeAt(j);
    await this.cmd(`AUTH PLAIN ${b64EncodeBytes(payload)}`);
    await this.readReply([235]);
  }

  async mailFrom(from: string): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`);
    await this.readReply([250]);
  }

  async rcptTo(to: string): Promise<void> {
    await this.cmd(`RCPT TO:<${to}>`);
    await this.readReply([250, 251]);
  }

  async data(lines: string[]): Promise<void> {
    await this.cmd('DATA');
    await this.readReply([354]);
    for (const line of lines) {
      await this.cmd(/^\./.test(line) ? '.' + line : line); // dot-stuffing
    }
    await this.cmd('.');
    await this.readReply([250]);
  }

  async quit(): Promise<void> {
    try { await this.cmd('QUIT'); } catch { /* ignore */ }
    try { this.conn.close(); } catch { /* ignore */ }
  }
}

interface MimeAttachment {
  file_name: string;
  file_type: string;
  data: Uint8Array;
}

/** Load the campaign's attachment metadata rows from Supabase. */
async function loadCampaignAttachments(campaignId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('campaign_attachments')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true });
  if (error) {
    if (error.code === '42P01') {
      log('[Campaign Attachment] campaign_attachments table missing (42P01) — sending without attachments');
      return [];
    }
    throw new Error(`Failed to fetch attachments: ${error.message}`);
  }
  return data || [];
}

/**
 * Download one attachment's bytes from Storage with the server-side Supabase
 * client. Throws with the EXACT bucket/path on failure so a missing file is
 * never silently sent without its attachment.
 */
async function downloadAttachment(att: any): Promise<MimeAttachment> {
  const bucket = String(att.storage_bucket || 'campaign-attachments');
  const path = String(att.storage_path || '');
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(
      `Failed to download attachment "${att.file_name || path}" from Storage — bucket="${bucket}" path="${path}"${error ? `: ${error.message}` : ' (empty response)'}`
    );
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  log(`[Campaign Attachment] Downloaded from Storage: ${bucket}/${path}`);
  return {
    file_name: att.file_name || 'attachment',
    file_type: att.file_type || 'application/octet-stream',
    data: bytes,
  };
}

/**
 * Load every attachment record for the campaign and download all the files
 * from Storage, ready to embed in the MIME message. If any file cannot be
 * downloaded the send aborts with a clear error instead of mailing the
 * campaign without the attachment.
 */
async function loadAndDownloadAttachments(campaignId: string): Promise<MimeAttachment[]> {
  const records = await loadCampaignAttachments(campaignId);
  if (records.length === 0) {
    log(`[Campaign Attachment] Loading attachments for campaign ${campaignId}: none found`);
    return [];
  }
  log(`[Campaign Attachment] Loading attachments for campaign ${campaignId}: ${records.length} record(s)`);
  const mime: MimeAttachment[] = [];
  for (const att of records) {
    mime.push(await downloadAttachment(att));
  }
  log(`[Campaign Attachment] Sending ${mime.length} attachment(s) with every campaign email`);
  return mime;
}

/** Base64 in 76-char lines (RFC 2045) so long attachments wrap correctly. */
function b64Lines(bytes: Uint8Array): string[] {
  const b64 = b64EncodeBytes(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines;
}

/** ASCII-safe filename for the MIME Content-Disposition / Content-Type name. */
function safeAttachmentName(value: string): string {
  return String(value || 'file')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .trim() || 'file';
}

function buildMimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string;
  listUnsubscribe: string;
  messageId: string;
  attachments?: MimeAttachment[];
}): string[] {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  lines.push(`Reply-To: ${encodeHeader(opts.replyTo)}`);
  lines.push(`Message-ID: ${opts.messageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`List-Unsubscribe: ${opts.listUnsubscribe}`);

  const attachments = opts.attachments || [];

  // No attachments → keep the exact legacy multipart/alternative message.
  if (attachments.length === 0) {
    const boundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(opts.text || '');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(opts.html || '');
    lines.push(`--${boundary}--`);
    lines.push('');
    return lines;
  }

  // With attachments the body becomes an inner multipart/alternative inside an
  // outer multipart/mixed, and each file is an independent base64 part.
  const outerBoundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
  const innerBoundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${outerBoundary}"`);
  lines.push('');
  lines.push(`--${outerBoundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${innerBoundary}"`);
  lines.push('');
  lines.push(`--${innerBoundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(opts.text || '');
  lines.push(`--${innerBoundary}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(opts.html || '');
  lines.push(`--${innerBoundary}--`);
  lines.push('');
  for (const att of attachments) {
    const safeName = safeAttachmentName(att.file_name);
    lines.push(`--${outerBoundary}`);
    lines.push(`Content-Type: ${att.file_type || 'application/octet-stream'}; name="${safeName}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${safeName}"`);
    lines.push('');
    lines.push(...b64Lines(att.data));
    lines.push('');
  }
  lines.push(`--${outerBoundary}--`);
  lines.push('');
  return lines;
}

async function sendSmtp(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MimeAttachment[];
}): Promise<{ messageId: string }> {
  if (!SMTP_USER || !SMTP_PASSWORD) {
    throw new Error('SMTP_USER / SMTP_PASSWORD secrets are not configured');
  }
  if (SMTP_PORT !== 465) {
    throw new Error('Supabase Edge Functions only allow outbound SMTP on port 465 (implicit TLS)');
  }
  const fromName = SMTP_FROM_NAME ? `${encodeHeader(SMTP_FROM_NAME)} ` : '';
  const from = fromName ? `${fromName}<${SMTP_FROM_ADDR}>` : SMTP_FROM_ADDR;
  const messageId = `<${crypto.randomUUID()}@gmail.com>`;
  const listUnsubscribe = `mailto:${SMTP_FROM_ADDR}?subject=Unsubscribe`;

  const session = new SmtpSession(30000);
  try {
    await session.connect(SMTP_HOST, SMTP_PORT);
    await session.ehlo('supabase.co');
    await session.authPlain(SMTP_USER, SMTP_PASSWORD);
    await session.mailFrom(SMTP_FROM_ADDR);
    await session.rcptTo(opts.to);
    const lines = buildMimeMessage({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: SMTP_REPLY_TO,
      listUnsubscribe,
      messageId,
      attachments: opts.attachments,
    });
    await session.data(lines);
    await session.quit();
    return { messageId };
  } catch (error) {
    try { session.quit(); } catch { /* ignore */ }
    throw error;
  }
}

// ─── Per-recipient send (mirrors emailWorker.sendOneEmail) ─────────────────
async function fetchCampaignTemplateHtml(templateId: string): Promise<string | null> {
  const { data: tpl, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .maybeSingle();
  if (error) {
    console.log(`[Template] fetch failed for ${templateId}: ${error.message}`);
    return null;
  }
  if (!tpl) {
    console.log(`[Template] ${templateId} not found — falling back to stored body.`);
    return null;
  }
  // Prefer the uploaded file in Storage (the true original); fall back to the
  // body column when the file is missing.
  if (tpl.storage_bucket && tpl.storage_path) {
    const { data: file } = await supabase.storage.from(tpl.storage_bucket).download(tpl.storage_path);
    if (file) {
      const html = await file.text();
      console.log(`[Template] fetched ORIGINAL template HTML from Storage (${html.length} chars).`);
      return html;
    }
  }
  return String(tpl.body || '').trim() || null;
}

async function sendOneEmail(
  emailLog: any,
  campaign: any,
  contactMap: Map<string, any>,
  index: number,
  total: number,
  attachments: MimeAttachment[] = []
): Promise<void> {
  const contact = contactMap.get(emailLog.contact_id) || {};

  // When the campaign references a template, send the ORIGINAL template HTML
  // fetched at send time (template edits propagate to new sends), falling back
  // to the stored copy when there is no reference or the fetch fails.
  let bodyHtml = campaign.html_content || '';
  if (campaign.template_id) {
    const original = await fetchCampaignTemplateHtml(campaign.template_id);
    if (original) bodyHtml = original;
  }

  const decoded = decodeHtmlEntities(
    personalizeTemplate(bodyHtml, contact, emailLog.email)
  );
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);

  let trackingId = emailLog.tracking_id || null;
  if (!trackingId) {
    trackingId = crypto.randomUUID();
    await updateEmailLog(emailLog.id, { tracking_id: trackingId });
    emailLog.tracking_id = trackingId;
  }

  // Click tracking: rewrite every link to the click-tracker Edge Function,
  // which records clicked/clicked_at on this exact email_log and 302-redirects.
  // Always applied — the edge function is reachable even when the local
  // backend is off, unlike the legacy TRACKING_BASE_URL path.
  let html = rewriteLinksForTracking(personalizedHtml, trackingId, EDGE_FUNCTION_BASE);
  // Always embed the Supabase Edge Function open pixel — it is reachable even
  // when the laptop is off and marks this exact email_log opened.
  html = appendEdgeTrackingPixel(html, campaign.id, emailLog.email, trackingId);
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(html));
  const subject = personalizeTemplate(campaign.subject_line || '', contact, emailLog.email);

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  log(`[Personalization] recipient=${emailLog.email}`);
  log(`[Personalization] contact_id=${contact.id || emailLog.contact_id || '(none)'}`);
  log(`[Personalization] full_name=${contact.full_name || ''}`);
  log(`[Personalization] company=${contact.company || ''}`);
  log(`[Personalization] designation=${contact.designation || ''}`);
  log(`[Personalization] rendered_subject=${String(subject || '').slice(0, 200)}`);
  log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  log(`Sending ${index}/${total} → ${emailLog.email}`);
  const result = await sendSmtp({ to: emailLog.email, subject, html: docHtml, text: plainText, attachments });
  log(`SMTP accepted ${emailLog.email} messageId=${result.messageId}`);
  if (attachments.length > 0) {
    log(`[Campaign Attachment] Email sent with ${attachments.length} attachment(s) → ${emailLog.email}`);
  }
}

// ─── Campaign processing (mirrors emailWorker.processCampaign) ─────────────
async function processCampaign(campaignId: string): Promise<{ sent: number; failed: number; total: number }> {
  const claimTimeIso = new Date().toISOString();
  await supabase.from('campaigns').update({ updated_at: claimTimeIso }).eq('id', campaignId);

  try {
    await recoverStuckLogs(campaignId);

    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();
    if (campError) throw new Error(`Campaign ${campaignId} not found: ${campError.message}`);

    const resolved = await resolveContactsForCampaign(campaignId, campaign.audience_segment);
    const contacts = resolved.contacts;
    const sourceCampaignId = resolved.sourceCampaignId;
    const openedAtByContact = resolved.openedAtByContact;
    log(`Campaign ${campaignId} resolved ${contacts.length} recipient(s)`);

    // Zero-recipient safety: nothing to send. Mark the campaign finished (with
    // a clear reason) and clear any batch scheduling state so a past
    // next_batch_at can never keep a batched follow-up stuck as "Active" while
    // silently doing nothing. A follow-up whose openers are not deliverable
    // resolves to 0 here — finalizing it cleanly (not leaving it at status with
    // a stale next_batch_at) lets the UI show "Completed" instead of an
    // endless "Next batch" that never fires.
    if (contacts.length === 0) {
      log(`Campaign ${campaignId} ("${campaign.campaign_name}") has 0 deliverable recipients — NOT sending.`);
      log(`Marking campaign ${campaignId} as "sent" (0 deliverable recipients).`);
      const isBatchedHere = campaign.send_in_batches === true;
      await finalizeCampaign(campaignId, {
        status: 'sent',
        recipient_count: 0,
        // A drained batch campaign is "complete": clear next_batch_at and reset
        // the counter so the UI shows "Completed" and the scheduler never
        // re-selects it (status 'sent' also excludes it from getDueCampaigns).
        ...(isBatchedHere ? { next_batch_at: null, current_batch_number: 0 } : {}),
      });
      return { sent: 0, failed: 0, total: 0 };
    }

    // Load + download the campaign's attachments once so every recipient gets the
    // same files without re-reading Storage per email. A file that cannot be
    // downloaded aborts the campaign with a clear error — never silently send
    // an email without its attachment.
    let mimeAttachments: MimeAttachment[];
    try {
      mimeAttachments = await loadAndDownloadAttachments(campaignId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logErr(`Campaign ${campaignId} aborted — ${message}`);
      await finalizeCampaign(campaignId, { status: 'failed', recipient_count: contacts.length });
      throw new Error(`Campaign ${campaignId} could not attach its files: ${message}`, { cause: error });
    }

    // Ensure one email_log per recipient (idempotent — never duplicates).
    const existingLogs = await getLogsByCampaign(campaignId);
    const alreadyQueued = new Set(existingLogs.map((l: any) => l.contact_id));
    const newContacts = contacts.filter((c: any) => !alreadyQueued.has(c.id));
    if (newContacts.length > 0) await createEmailLogs(campaignId, newContacts);

    const contactMap = new Map(contacts.map((c: any) => [c.id, c]));

    // Batch pacing: a batched campaign (send_in_batches=true) sends EXACTLY its
    // configured batch_size recipients per cron tick, then advances next_batch_at
    // so the next batch fires after the configured delay. Non-batched campaigns
    // keep draining up to the per-run budget exactly as before.
    const isBatched = campaign.send_in_batches === true;
    const batchSize = Number(campaign.batch_size);
    const isValidBatch = isBatched && Number.isInteger(batchSize) && batchSize > 0;
    // The per-tick budget is whichever is smaller: a single configured batch, or
    // the hard per-run email ceiling.
    const runCap = isValidBatch ? Math.min(batchSize, MAX_EMAILS_PER_RUN) : MAX_EMAILS_PER_RUN;
    // The delay that separates THIS batch from the next one. A fresh queue
    // (current_batch_number 0) uses first_batch_delay_hours for the wait after
    // its very first batch; every later batch uses subsequent_batch_delay_hours.
    const batchIndex = Number(campaign.current_batch_number) || 0;
    const delayHours = batchIndex === 0 ? Number(campaign.first_batch_delay_hours) : Number(campaign.subsequent_batch_delay_hours);

    // Drain pending logs in batches, respecting the invocation time budget.
    const start = Date.now();
    let sent = 0;
    let failed = 0;

    while (sent + failed < runCap) {
      if (Date.now() - start > TIME_BUDGET_MS) {
        log(`Time budget reached — pausing campaign ${campaignId}; next cron tick will continue.`);
        break;
      }
      const batch = await claimPendingLogs(campaignId, runCap - (sent + failed));
      if (batch.length === 0) break;

      const total = contacts.length;
      for (let i = 0; i < batch.length; i++) {
        // Re-check the budget inside the loop too — a large claimed batch must
        // never push this invocation past the free-tier wall-clock limit.
        if (Date.now() - start > TIME_BUDGET_MS) break;
        if (sent + failed >= runCap) break;
        const logRow = batch[i];
        try {
          if (EMAIL_DELAY_MS > 0 && i > 0) {
            await new Promise((r) => setTimeout(r, EMAIL_DELAY_MS));
          }
          await sendOneEmail(logRow, campaign, contactMap, sent + failed + 1, total, mimeAttachments);
          await updateEmailLog(logRow.id, { status: 'sent', sent_at: new Date().toISOString() });
          // A follow-up delivery must also be recorded in campaign_followup_logs
          // (keyed to the ORIGINAL campaign) so the UI's remaining_eligible count
          // drops to 0 — and the Schedule column shows "Completed" — after the
          // last batch. Non-follow-up campaigns are unaffected (no source id).
          if (sourceCampaignId) {
            await recordFollowupDelivery(
              campaignId,
              sourceCampaignId,
              String(logRow.contact_id),
              String(logRow.email || ''),
              openedAtByContact.get(String(logRow.contact_id)) || null
            );
          }
          sent++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryCount = (logRow.retry_count || 0) + 1;
          if (retryCount > MAX_RETRIES) {
            await updateEmailLog(logRow.id, {
              status: 'failed',
              error_message: `[SEND_FAILED] ${message}`,
              retry_count: retryCount,
              last_attempt_at: new Date().toISOString(),
            });
            failed++;
            logErr(`FAILED ${logRow.email} (permanent): ${message}`);
          } else {
            const delaySec = RETRY_DELAYS[retryCount - 1];
            await updateEmailLog(logRow.id, {
              status: 'pending',
              retry_count: retryCount,
              last_attempt_at: new Date().toISOString(),
              next_retry_at: new Date(Date.now() + delaySec * 1000).toISOString(),
              error_message: `[SEND_FAILED] ${message}`,
            });
            logErr(`Retry ${retryCount} scheduled for ${logRow.email} in ${delaySec}s: ${message}`);
          }
        }
      }
    }

    // Release logs we claimed but did not finish this run (budget) so the next
    // cron tick picks them up immediately instead of waiting for recovery.
    await releaseClaimedLogs(campaignId, claimTimeIso);

    // Reclaim any 'sending' logs a crashed / timed-out run (this project or a
    // previous one) left behind, so their recipients are treated as claimable
    // again rather than silently counting as "drained". Without this, a log
    // stuck in 'sending' makes getLogsStats report 0 pending, which finalizes
    // a batched follow-up to 'sent' while a recipient was never actually sent
    // — leaving the UI stuck on 1 "eligible" recipient forever.
    await recoverStuckLogs(campaignId);

    // Finalize. A campaign is only "sent" when every recipient is drained
    // (all logs 'sent' or 'failed'). If recipients still remain pending — e.g.
    // the per-run budget was hit, or a recipient is waiting on a retry delay —
    // the campaign returns to "scheduled" so the next cron tick reclaims it
    // and keeps draining. This never orphans pending logs.
    const stats = await getLogsStats(campaignId);
    try {
      await syncCampaignAnalytics(campaignId);
    } catch (analyticsError) {
      logErr(`Analytics sync failed (non-fatal): ${(analyticsError as Error).message}`);
    }
    if (stats.pending > 0) {
      // Batched campaign with recipients still remaining: advance next_batch_at
      // from the ACTUAL batch execution time by the configured delay. The first
      // batch uses first_batch_delay_hours; every later batch uses
      // subsequent_batch_delay_hours. The campaign stays "scheduled" so the
      // next cron tick (once next_batch_at arrives) fires the next batch.
      if (isValidBatch) {
        const gapHours = delayHours;
        const gapMs = Math.max(0, Number(gapHours) || 0) * 60 * 60 * 1000;
        const nextAt = new Date(Date.now() + gapMs).toISOString();
        await finalizeCampaign(campaignId, {
          status: 'scheduled',
          next_batch_at: nextAt,
          current_batch_number: batchIndex + 1,
        });
        log(
          `Campaign ${campaignId} is batched — sent this batch; ` +
          `next batch at ${nextAt} (${Number(gapHours) || 0} hour(s) wait).`
        );
        return { sent, failed, total: stats.total };
      }
      await finalizeCampaign(campaignId, {
        status: 'scheduled',
      });
      log(
        `Campaign ${campaignId} still has ${stats.pending} pending recipient(s) — ` +
        `returned to "scheduled" so the next cron tick continues.`
      );
    } else {
      // Recurring advance: an active weekly/monthly schedule with a next
      // occurrence keeps the campaign "scheduled" (next_run advanced) instead
      // of marking it "sent" — the cron tick picks it up again next occurrence.
      const schedule = await getCampaignSchedule(campaignId);
      const isRecurring =
        schedule && (schedule.schedule_type === 'weekly' || schedule.schedule_type === 'monthly');
      if (isRecurring) {
        const next = computeNextRun(schedule);
        if (next) {
          const nowIso = new Date().toISOString();
          const { error: schedError } = await supabase
            .from('campaign_schedules')
            .update({ next_run: next.toISOString(), last_run: nowIso })
            .eq('campaign_id', campaignId);
          if (schedError) {
            throw new Error(`Failed to advance schedule for campaign ${campaignId}: ${schedError.message}`);
          }
          await finalizeCampaign(campaignId, { status: 'scheduled' });
          log(
            `Campaign ${campaignId} recurring — ${stats.delivered} delivered this occurrence; ` +
            `advanced to next run ${next.toISOString()} and kept "scheduled".`
          );
          return { sent, failed, total: stats.total };
        }
        log(`Campaign ${campaignId} recurring schedule has no further occurrence — finalizing "sent".`);
      }
      const delivered = Number(stats.delivered) || 0;
      if (delivered > 0) {
        await finalizeCampaign(campaignId, {
          status: 'sent',
          sent_at: new Date().toISOString(),
          recipient_count: stats.total,
          // A drained batch campaign is "complete": clear next_batch_at so the
          // UI shows "Completed" and the scheduler never re-selects it. The
          // batch counter is reset so a FUTURE re-queue starts at batch 1 again.
          ...(isBatched ? { next_batch_at: null, current_batch_number: 0 } : {}),
        });
        log(`Campaign ${campaignId} marked "sent" (${delivered} delivered / ${stats.total} total)`);
      } else {
        // Every recipient permanently failed — honest status instead of a fake
        // "sent" with zero deliveries.
        await finalizeCampaign(campaignId, {
          status: 'failed',
          recipient_count: stats.total,
        });
        logErr(`Campaign ${campaignId} marked "failed" — 0 delivered of ${stats.total} recipient(s).`);
      }
    }
    return { sent, failed, total: stats.total };
  } catch (error) {
    // Never downgrade a campaign that already delivered emails (worker parity).
    let delivered = 0;
    try {
      const stats = await getLogsStats(campaignId);
      delivered = stats.delivered;
    } catch { /* leave delivered = 0 */ }
    if (delivered > 0) {
      await finalizeCampaign(campaignId, {
        status: 'sent',
        sent_at: new Date().toISOString(),
        recipient_count: delivered,
      });
      log(`Campaign ${campaignId} finalized "sent" after error (${delivered} already delivered)`);
    } else {
      await finalizeCampaign(campaignId, {
        status: 'failed',
        recipient_count: 0,
      });
      logErr(`Campaign ${campaignId} marked "failed": ${(error as Error).message}`);
    }
    throw error;
  }
}

// ─── Main entry ────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const start = Date.now();
  const secret = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    logErr('Unauthorized — missing/invalid x-cron-secret header');
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const summary = { due: 0, recovered: 0, processed: 0, failed: 0 };
  try {
    log('Checking scheduled campaigns...');

    const due = await getDueCampaigns();
    log(`Found ${due.length} eligible campaign(s)`);
    summary.due = due.length;

    for (const campaign of due) {
      try {
        const claimed = await claimCampaign(campaign.id);
        if (!claimed) {
          log(`Campaign ${campaign.id} already claimed — skipping`);
          continue;
        }
        log(`Claiming campaign ${campaign.id} ("${campaign.campaign_name}")`);
        log(`Sending campaign ${campaign.id}`);
        await processCampaign(campaign.id);
        log(`Campaign ${campaign.id} completed`);
        summary.processed++;
      } catch (error) {
        summary.failed++;
        logErr(`Campaign ${campaign.id} failed: ${(error as Error).message}`);
      }
    }

    // Recover campaigns a previous invocation left stuck in 'sending'.
    const stuck = await getStuckSendingCampaigns();
    for (const campaign of stuck) {
      try {
        log(`Recovering campaign ${campaign.id} (stuck in "sending")`);
        await processCampaign(campaign.id);
        summary.recovered++;
      } catch (error) {
        logErr(`Recovery failed for campaign ${campaign.id}: ${(error as Error).message}`);
      }
    }

    log(`Done in ${Date.now() - start}ms — ${summary.processed} campaign(s) processed, ${summary.recovered} recovered`);
    return new Response(JSON.stringify({ success: true, ...summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logErr(`Scheduler tick failed: ${(error as Error).message}`);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
