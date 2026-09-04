/**
 * send-campaign — Supabase Edge Function ("Send Now").
 *
 * Lets the React app send a campaign immediately without the local Node.js
 * backend (localhost:5000). It validates the campaign payload, saves it to
 * Supabase, resolves the audience, and emails every recipient directly via
 * Gmail SMTP using the exact same conventions as the existing cloud scheduler
 * (scheduled-campaign-runner):
 *
 *   - Same tables: campaigns, campaign_contacts, email_logs, campaign_analytics
 *   - Same status flow: sending → sent (or failed)
 *   - Same merge tags: {{first_name}}, {{company}}, {{designation}}, {{email}}
 *   - Same open-tracking pixel: the existing campaign-tracker Edge Function
 *   - Same per-recipient retry semantics (3 retries, then 'failed')
 *   - Same duplicate-send protection: email_logs rows are claimed atomically
 *     (pending → sending) so a recipient is only ever emailed by one invocation,
 *     and campaign_contacts/email_logs are created idempotently.
 *   - Strict follow-up rule preserved: a follow-up campaign ONLY sends to the
 *     contacts who opened its ORIGINAL campaign — never the audience segment.
 *
 * LARGE CAMPAIGNS / EDGE BUDGET:
 *   Edge Functions have a wall-clock limit (~150s free tier). This function
 *   sends within a per-run budget; if the campaign is too large to finish in
 *   one invocation it hands the remainder to the existing pg_cron scheduler:
 *   it releases the still-pending recipients and returns the campaign to
 *   "scheduled" with schedule_date/schedule_time set to the current IST time,
 *   so scheduled-campaign-runner claims it on its next tick and drains the
 *   rest within a minute. Recipients are never skipped or double-sent.
 *
 * AUTH (no secrets in the frontend):
 *   The app calls supabase.functions.invoke('send-campaign', ...). Because the
 *   app has no Supabase Auth session, supabase-js sends the project anon/
 *   publishable key in the `apikey` header and omits `Authorization`. This
 *   function accepts either that project key (verified against SUPABASE_ANON_KEY
 *   or the SEND_CAMPAIGN_ANON_KEY secret) or a valid Supabase user JWT whose
 *   `iss` matches this project's Supabase URL. The publishable key is a public
 *   client credential already shipped to the browser — it grants the same
 *   "anon" access as the rest of the app; SMTP and service-role stay server-side.
 *   SMTP credentials are never hard-coded; they come from the same supabase
 *   secrets used by scheduled-campaign-runner (SMTP_HOST, SMTP_PORT=465,
 *   SMTP_USER, SMTP_PASSWORD, SMTP_FROM_NAME, SMTP_FROM, SMTP_REPLY_TO,
 *   EDGE_FUNCTION_URL). Service role is only used inside this function.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { personalizeTemplate } from '../_shared/personalization.ts';
import { toEmailSafeHtml } from '../_shared/email-render.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Configuration (env) ───────────────────────────────────────────────────
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

// Pacing / budget. Send Now should go as far as possible in this invocation;
// anything left over hands off to the cron runner (see header comment).
const EMAIL_DELAY_MS = Math.max(0, parseInt(Deno.env.get('EMAIL_DELAY_MS') || '200', 10));
const MAX_EMAILS_PER_RUN = Math.max(1, parseInt(Deno.env.get('MAX_EMAILS_PER_RUN') || '500', 10));
const TIME_BUDGET_MS = Math.max(1000, parseInt(Deno.env.get('TIME_BUDGET_MS') || '100000', 10));
const RETRY_DELAYS = [30, 60, 120]; // seconds — matches the backend worker
const MAX_RETRIES = RETRY_DELAYS.length;

// IST (Asia/Kolkata) = UTC+05:30.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function log(...args: unknown[]) {
  console.log('[SendNow]', ...args);
}
function logErr(...args: unknown[]) {
  console.error('[SendNow]', ...args);
}

// ─── CORS + JSON responses ─────────────────────────────────────────────────
// The Supabase gateway does not add CORS headers to function-originated
// responses (verified against the live endpoint), and it forwards browser
// preflight OPTIONS to the function instead of short-circuiting them. Without
// these headers the browser blocks the call and supabase-js surfaces the
// misleading "Failed to send a request to the Edge Function" fetch error.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-region',
  'Access-Control-Max-Age': '86400',
};

function corsHeaders(): Record<string, string> {
  return { ...CORS_HEADERS };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ─── Auth guard ────────────────────────────────────────────────────────────
// The app has no Supabase Auth users, so browser calls carry no user JWT.
// With the new-format publishable key, supabase-js sends the project key in
// the `apikey` header and deliberately omits `Authorization` when there is no
// session. This function accepts EITHER:
//   1. a valid Supabase JWT (user or anon) whose `iss` matches this project
//      (future-proof — keeps working unchanged once Auth is added), OR
//   2. the project's anon/publishable key in the `Authorization` or `apikey`
//      header, verified against the runtime SUPABASE_ANON_KEY env (or the
//      SEND_CAMPAIGN_ANON_KEY secret if set). The publishable key is a public
//      client credential already shipped to the browser — the same "anon"
//      trust level as the rest of the app. SMTP/service-role stay server-side.
const ANON_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const runtimeKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  if (runtimeKey) keys.add(runtimeKey);
  const explicitKey = Deno.env.get('SEND_CAMPAIGN_ANON_KEY')?.trim();
  if (explicitKey) keys.add(explicitKey);
  return keys;
})();

function presentedKey(req: Request): string {
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  return (req.headers.get('apikey') || '').trim();
}

function isValidSupabaseJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    const iss = String(payload.iss || '');
    const url = new URL(supabaseUrl);
    return iss.startsWith(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}

function isAuthorized(req: Request): boolean {
  const key = presentedKey(req);
  if (!key) return false;
  if (ANON_KEYS.has(key)) return true;
  return isValidSupabaseJwt(key);
}

// ─── Time helpers (ported from campaignScheduler.js) ───────────────────────
function todayISTDateStr(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function nowISTTimeStr(): string {
  const now = new Date(Date.now() + IST_OFFSET_MS);
  return [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join(':');
}

// ─── Column-presence guard (graceful rollout) ───────────────────────────────
// The campaigns.template_id column is added by a migration the operator runs
// manually. Until it runs, writing it fails with "column does not exist". This
// probe (cached per invocation) lets the edge function omit it safely.
let _hasTemplateIdCol: boolean | undefined;
async function campaignsHaveTemplateId(): Promise<boolean> {
  if (_hasTemplateIdCol !== undefined) return _hasTemplateIdCol;
  const { error } = await supabase.from('campaigns').select('template_id').limit(1);
  _hasTemplateIdCol = !error;
  return _hasTemplateIdCol;
}

// ─── Campaign validation + upsert (mirrors buildCampaignRecord) ────────────
interface CampaignPayload {
  id?: string | null;
  campaign_name: string;
  subject_line: string;
  subject?: string;
  from_name: string;
  audience_segment: string;
  campaign_type?: string;
  html_content: string;
  schedule_date?: string;
  schedule_time?: string;
  template_name?: string | null;
  template_id?: string | null;
  schedule?: unknown;
  /**
   * Attachment metadata (files already uploaded to Supabase Storage by the
   * composer). Persisted against the campaign and attached to every email.
   */
  attachments?: Array<{
    file_name?: string;
    file_type?: string;
    file_size?: number;
    storage_bucket?: string;
    storage_path?: string;
  }>;
  /** Explicitly selected contact IDs from drag-and-drop (takes precedence over audience_segment) */
  selected_contact_ids?: string[];
  /** Batch sending configuration (Send Now with "Send in batches" ON). */
  send_in_batches?: boolean;
  batch_size?: number;
  first_batch_delay_hours?: number;
  subsequent_batch_delay_hours?: number;
}

function buildCampaignRecord(data: CampaignPayload, status: string) {
  const subjectLine = data.subject_line !== undefined ? data.subject_line : data.subject;

  const missing: string[] = [];
  if (!data.campaign_name || !String(data.campaign_name).trim()) missing.push('campaign_name');
  if (subjectLine === undefined || subjectLine === null || !String(subjectLine).trim()) missing.push('subject_line');
  if (!data.from_name || !String(data.from_name).trim()) missing.push('from_name');
  if (!data.audience_segment || !String(data.audience_segment).trim()) missing.push('audience_segment');
  if (!data.html_content || !String(data.html_content).trim()) missing.push('html_content');
  if (missing.length > 0) throw new Error(`Missing required fields: ${missing.join(', ')}`);

  const record: Record<string, unknown> = {
    id: data.id ? String(data.id) : null,
    campaign_name: String(data.campaign_name).trim(),
    subject_line: String(subjectLine).trim(),
    from_name: String(data.from_name).trim(),
    audience_segment: String(data.audience_segment).trim(),
    campaign_type: String(data.campaign_type || 'Campaign').trim(),
    email_body: data.html_content,
    html_content: data.html_content,
    template_name: data.template_name ? String(data.template_name).trim() : null,
    template_id: data.template_id ? String(data.template_id).trim() : null,
    schedule_date: data.schedule_date ? String(data.schedule_date).trim() : null,
    schedule_time: data.schedule_time ? String(data.schedule_time).trim() : null,
    status,
  };

  // Persist batch-sending configuration (send_in_batches / batch_size /
  // first_batch_delay_hours / subsequent_batch_delay_hours) so the scheduler's
  // isBatchedCampaignDue can pace subsequent batches correctly. The runner reads
  // these columns straight off the campaign row — if they are not saved here a
  // batched Send Now would drop all recipients in the first invocation.
  if (data.send_in_batches) {
    record.send_in_batches = true;
    record.batch_size = Number(data.batch_size) > 0 ? Number(data.batch_size) : 30;
    record.first_batch_delay_hours = Number.isFinite(Number(data.first_batch_delay_hours))
      ? Number(data.first_batch_delay_hours)
      : 2;
    record.subsequent_batch_delay_hours = Number.isFinite(Number(data.subsequent_batch_delay_hours))
      ? Number(data.subsequent_batch_delay_hours)
      : 1;
  } else {
    // A non-batched Send Now must always clear any previous batch state, so a
    // campaign that was batched then re-sent without batches never re-fires.
    record.send_in_batches = false;
    record.current_batch_number = 0;
    record.next_batch_at = null;
  }

  return record;
}

async function saveCampaignRecord(record: Record<string, unknown>): Promise<any> {
  const { id, ...fields } = record;
  const base: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };

  // Omit template_id until the migration adding the column has been applied.
  if (!(await campaignsHaveTemplateId())) {
    delete base.template_id;
  }

  if (id) {
    const { data, error } = await supabase
      .from('campaigns')
      .update(base)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(`Failed to update campaign: ${error.message}`);
    return data;
  }

  const { data, error } = await supabase
    .from('campaigns')
    .insert({ ...base, created_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw new Error(`Failed to save campaign: ${error.message}`);
  return data;
}

/**
 * Persist the composer's attachment metadata against the campaign. Replaces any
 * previous rows (a draft may be edited/sent more than once). Tolerates the
 * table missing so existing projects without campaign_attachments keep working.
 */
async function saveCampaignAttachments(campaignId: string, attachments?: unknown): Promise<void> {
  const list = Array.isArray(attachments) ? attachments : [];
  const { error: deleteError } = await supabase
    .from('campaign_attachments')
    .delete()
    .eq('campaign_id', campaignId);
  if (deleteError && deleteError.code !== '42P01') {
    throw new Error(`Failed to clear previous attachments: ${deleteError.message}`);
  }

  const rows = list
    .map((a: any) => ({
      campaign_id: campaignId,
      file_name: String(a?.file_name || 'attachment'),
      file_type: String(a?.file_type || 'application/octet-stream'),
      file_size: Number(a?.file_size) || 0,
      storage_bucket: String(a?.storage_bucket || 'campaign-attachments'),
      storage_path: String(a?.storage_path || ''),
    }))
    .filter((r: any) => r.storage_path);
  if (rows.length === 0) return;

  const { error } = await supabase.from('campaign_attachments').insert(rows);
  if (error && error.code !== '42P01') {
    throw new Error(`Failed to save attachments: ${error.message}`);
  }
  if (rows.length > 0) log(`Saved ${rows.length} attachment(s) for campaign ${campaignId}`);
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
  audienceSegment: string,
  selectedContactIds?: string[]
): Promise<any[]> {
  // Follow-up rule: a campaign configured as a FOLLOW-UP (row in
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
  const sourceCampaignId = configs && configs[0] && configs[0].campaign_id;

  if (sourceCampaignId) {
    const { data: openedLogs, error: openedError } = await supabase
      .from('email_logs')
      .select('contact_id')
      .eq('campaign_id', sourceCampaignId)
      .eq('opened', true);
    if (openedError) throw new Error(`Failed to fetch opened contacts: ${openedError.message}`);
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
  } else if (selectedContactIds && selectedContactIds.length > 0) {
    // Use explicitly selected contact IDs (from drag-and-drop)
    const { data: rows, error: contactsError } = await supabase
      .from('contacts')
      .select('*')
      .in('id', selectedContactIds);
    if (contactsError) throw new Error(`Failed to fetch selected contacts: ${contactsError.message}`);

    const seenEmails = new Set<string>();
    valid = (rows || []).filter((c: any) => {
      if (!isDeliverableRecipientEmail(c.email)) return false;
      const key = String(c.email).trim().toLowerCase();
      if (seenEmails.has(key)) return false;
      seenEmails.add(key);
      return true;
    });
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

  // Link resolved contacts to campaign_contacts (idempotent).
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

  return valid;
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

/** Atomically claim the pending email_logs for a campaign (pending → sending). */
async function claimPendingLogs(campaignId: string, limit?: number): Promise<any[]> {
  const nowIso = new Date().toISOString();

  // Step 1 — deterministically select the IDs to claim (SELECT supports limit,
  // needed for batch-paced sends that claim exactly batchSize recipients).
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
  // a row already claimed by a concurrent invocation is left alone).
  const { data, error } = await supabase
    .from('email_logs')
    .update({ status: 'sending', last_attempt_at: nowIso })
    .in('id', ids)
    .eq('status', 'pending')
    .select('*');
  if (error) throw new Error(`Failed to claim pending logs: ${error.message}`);
  return data || [];
}

/** Release logs WE claimed but did not finish (budget exit). */
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
 * Update a campaign ONLY while this invocation still owns it ('sending').
 * Guarding with status='sending' means a stale finalize can never stomp a
 * campaign a concurrent scheduler already claimed or finalized.
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
 * - Bare http(s):// URLs in the text are auto-wrapped in a tracked anchor
 *   (raw URLs typed in the composer were never clickable before).
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
  if (!/[\u0080-\uFFFF]/.test(value)) return value;
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
    // A ReadableStream supports only ONE active reader — acquire it once here
    // and reuse it for every reply. Calling getReader() per read would throw
    // "ReadableStream is locked" on the second reply.
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
    let lastCode: number;
    let text: string;
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
    try { this.reader.releaseLock(); } catch { /* ignore */ }
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
  log(`SMTP config: host=${SMTP_HOST} port=${SMTP_PORT} user=${SMTP_USER} passwordSet=${Boolean(SMTP_PASSWORD)} tls=implicit(465)`);
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
    log(`[Template] fetch failed for ${templateId}: ${error.message}`);
    return null;
  }
  if (!tpl) {
    log(`[Template] ${templateId} not found — falling back to stored body.`);
    return null;
  }
  // Prefer the uploaded file in Storage (the true original); fall back to the
  // body column when the file is missing.
  if (tpl.storage_bucket && tpl.storage_path) {
    const { data: file } = await supabase.storage.from(tpl.storage_bucket).download(tpl.storage_path);
    if (file) {
      const html = await file.text();
      log(`[Template] fetched ORIGINAL template HTML from Storage (${html.length} chars).`);
      return html;
    }
  }
  return String(tpl.body || '').trim() || null;
}

async function sendOneEmail(
  logRow: any,
  campaign: any,
  contactMap: Map<string, any>,
  index: number,
  total: number,
  attachments: MimeAttachment[] = []
): Promise<void> {
  const contact = contactMap.get(logRow.contact_id) || {};

  // When the campaign references a template, send the ORIGINAL template HTML
  // fetched at send time (template edits propagate to new sends), falling back
  // to the stored copy when there is no reference or the fetch fails.
  let bodyHtml = campaign.html_content || '';
  if (campaign.template_id) {
    const original = await fetchCampaignTemplateHtml(campaign.template_id);
    if (original) bodyHtml = original;
  }

  const decoded = decodeHtmlEntities(
    personalizeTemplate(bodyHtml, contact, logRow.email)
  );
  const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
  const plainText = stripHtml(personalizedHtml);

  let trackingId = logRow.tracking_id || null;
  if (!trackingId) {
    trackingId = crypto.randomUUID();
    await updateEmailLog(logRow.id, { tracking_id: trackingId });
    logRow.tracking_id = trackingId;
  }

  // Click tracking: rewrite every link to the click-tracker Edge Function,
  // which records clicked/clicked_at on this exact email_log and 302-redirects.
  // Always applied — the edge function is reachable even when the local
  // backend is off, unlike the legacy TRACKING_BASE_URL path.
  let html = rewriteLinksForTracking(personalizedHtml, trackingId, EDGE_FUNCTION_BASE);
  // Always embed the Supabase Edge Function open pixel — reachable even when
  // the laptop is off and marks this exact email_log opened.
  html = appendEdgeTrackingPixel(html, campaign.id, logRow.email, trackingId);
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(html));
  const subject = personalizeTemplate(campaign.subject_line, contact, logRow.email);

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  log(`[Personalization] recipient=${logRow.email}`);
  log(`[Personalization] contact_id=${contact.id || logRow.contact_id || '(none)'}`);
  log(`[Personalization] full_name=${contact.full_name || ''}`);
  log(`[Personalization] company=${contact.company || ''}`);
  log(`[Personalization] designation=${contact.designation || ''}`);
  log(`[Personalization] rendered_subject=${String(subject || '').slice(0, 200)}`);
  log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  log(`Sending ${index}/${total} → ${logRow.email}`);
  const result = await sendSmtp({ to: logRow.email, subject, html: docHtml, text: plainText, attachments });
  log(`SMTP accepted ${logRow.email} messageId=${result.messageId}`);
  if (attachments.length > 0) {
    log(`[Campaign Attachment] Email sent with ${attachments.length} attachment(s) → ${logRow.email}`);
  }
}

// ─── Send first batch of a batched campaign, then hand off ────────────────
/**
 * Deliver ONLY the first `batchSize` recipients of a batched Send Now, then
 * transition the campaign to "scheduled" with current_batch_number=1 and
 * next_batch_at = now + first_batch_delay_hours. The scheduled-campaign-runner
 * claims it via isBatchedCampaignDue at next_batch_at and sends exactly
 * batch_size recipients per tick until every recipient is drained — so a
 * "Batch Size = 1, delay = 5 min" campaign sends ONE recipient now, waits 5
 * minutes, then sends the next, and so on. All recipients were already queued
 * as email_logs above (the runner never re-creates them), so none is lost and
 * none is double-sent.
 */
async function sendFirstBatchAndHandOff(
  campaignId: string,
  campaign: any,
  contacts: any[],
  contactMap: Map<string, any>,
  mimeAttachments: MimeAttachment[],
  batchSize: number
): Promise<{ sent: number; failed: number; total: number; handedOff: boolean; status: string }> {
  const claimTimeIso = new Date().toISOString();
  const firstDelayHours = Number(campaign.first_batch_delay_hours);
  const firstDelayMs = Number.isFinite(firstDelayHours) ? Math.max(0, firstDelayHours) * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const totalBatches = Math.ceil(contacts.length / batchSize);

  log(
    `Campaign ${campaignId} is batched — sending ONLY batch 1 of ${totalBatches} ` +
    `(${batchSize} recipient(s)); hand-off to scheduled-campaign-runner for the rest.`
  );

  const start = Date.now();
  let sent = 0;
  let failed = 0;

  // Claim + deliver exactly batchSize recipients this invocation.
  const pending = await claimPendingLogs(campaignId, batchSize);
  const total = contacts.length;
  for (let i = 0; i < pending.length; i++) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    const logRow = pending[i];
    try {
      if (EMAIL_DELAY_MS > 0 && i > 0) {
        await new Promise((r) => setTimeout(r, EMAIL_DELAY_MS));
      }
      await sendOneEmail(logRow, campaign, contactMap, sent + failed + 1, total, mimeAttachments);
      await updateEmailLog(logRow.id, { status: 'sent', sent_at: new Date().toISOString() });
      sent++;
      log(`Campaign ${campaignId} batch 1 sent → ${logRow.email}`);
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

  // Release anything we claimed but did not finish (budget) so it stays eligible.
  await releaseClaimedLogs(campaignId, claimTimeIso);

  // Hand off: keep the campaign "scheduled", record batch 1 as done (counter=1),
  // and set next_batch_at so the runner fires batch 2 after first_batch_delay.
  const nextAt = new Date(Date.now() + firstDelayMs).toISOString();
  await finalizeCampaign(campaignId, {
    status: 'scheduled',
    current_batch_number: 1,
    next_batch_at: nextAt,
    recipient_count: contacts.length,
  });

  log(
    `Campaign ${campaignId} batch 1 complete (sent=${sent} failed=${failed}); ` +
    `next batch at ${nextAt} (${Number(firstDelayHours) || 0} hour(s) wait).`
  );

  try {
    await syncCampaignAnalytics(campaignId);
  } catch (analyticsError) {
    logErr(`Analytics sync failed (non-fatal): ${(analyticsError as Error).message}`);
  }

  return { sent, failed, total: contacts.length, handedOff: true, status: 'scheduled' };
}

// ─── Campaign processing (mirrors the scheduler's processCampaign) ─────────
async function processCampaign(
  campaignId: string,
  contactsHint: any[]
): Promise<{ sent: number; failed: number; total: number; handedOff: boolean; status: string }> {
  const claimTimeIso = new Date().toISOString();
  await supabase.from('campaigns').update({ updated_at: claimTimeIso }).eq('id', campaignId);

  const { data: campaign, error: campError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();
  if (campError) throw new Error(`Campaign ${campaignId} not found: ${campError.message}`);

  const contacts = contactsHint.length > 0
    ? contactsHint
    : await resolveContactsForCampaign(campaignId, campaign.audience_segment);
  log(`Campaign ${campaignId} resolved ${contacts.length} recipient(s)`);

  // Load + download the campaign's attachments once so every recipient gets
  // the same files without re-reading Storage per email. A file that cannot be
  // downloaded aborts the campaign with a clear error — never silently send an
  // email without its attachment.
  let mimeAttachments: MimeAttachment[];
  try {
    mimeAttachments = await loadAndDownloadAttachments(campaignId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logErr(`Campaign ${campaignId} aborted — ${message}`);
    await finalizeCampaign(campaignId, { status: 'failed', recipient_count: contacts.length });
    throw new Error(`Campaign ${campaignId} could not attach its files: ${message}`, { cause: error });
  }

  // Zero-recipient safety: nothing to send. Mark "failed" so the campaign is
  // never reported "sent" with zero deliveries.
  if (contacts.length === 0) {
    log(`Campaign ${campaignId} has 0 deliverable recipients — NOT sending.`);
    await finalizeCampaign(campaignId, { status: 'failed', recipient_count: 0 });
    return { sent: 0, failed: 0, total: 0, handedOff: false, status: 'failed' };
  }

  // Ensure one email_log per recipient (idempotent — never duplicates).
  const existingLogs = await getLogsByCampaign(campaignId);
  const alreadyQueued = new Set(existingLogs.map((l: any) => l.contact_id));
  const newContacts = contacts.filter((c: any) => !alreadyQueued.has(c.id));
  if (newContacts.length > 0) await createEmailLogs(campaignId, newContacts);

  const contactMap = new Map(contacts.map((c: any) => [c.id, c]));

  // ─── Batch-paced Send Now ────────────────────────────────────────────────
  // If the campaign is configured to send in batches and resolves to MORE than
  // one batch, only the FIRST batch is delivered here; the campaign is then
  // handed off to the scheduled-campaign-runner with current_batch_number=1 and
  // next_batch_at = now + first_batch_delay_hours. The runner's
  // isBatchedCampaignDue picks it up at next_batch_at and sends exactly
  // batch_size recipients per tick until every recipient is drained. This is
  // what makes a "Batch Size = 1, delay = 5 min" campaign send exactly ONE
  // recipient now and wait before the next.
  const sendInBatches = campaign.send_in_batches === true;
  const configuredBatchSize = Number(campaign.batch_size);
  const isBatchSend =
    sendInBatches && Number.isInteger(configuredBatchSize) && configuredBatchSize > 0 &&
    Math.ceil(contacts.length / configuredBatchSize) > 1;

  if (isBatchSend) {
    return await sendFirstBatchAndHandOff(
      campaignId,
      campaign,
      contacts,
      contactMap,
      mimeAttachments,
      configuredBatchSize
    );
  }

  // Drain pending logs within the invocation time budget.
  const start = Date.now();
  let sent = 0;
  let failed = 0;

  while (sent + failed < MAX_EMAILS_PER_RUN) {
    if (Date.now() - start > TIME_BUDGET_MS) {
      log(`Time budget reached — pausing campaign ${campaignId}; cron runner will continue.`);
      break;
    }
    const batch = await claimPendingLogs(campaignId);
    if (batch.length === 0) break;

    const total = contacts.length;
    for (let i = 0; i < batch.length; i++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      if (sent + failed >= MAX_EMAILS_PER_RUN) break;
      const logRow = batch[i];
      try {
        if (EMAIL_DELAY_MS > 0 && i > 0) {
          await new Promise((r) => setTimeout(r, EMAIL_DELAY_MS));
        }
        await sendOneEmail(logRow, campaign, contactMap, sent + failed + 1, total, mimeAttachments);
        await updateEmailLog(logRow.id, { status: 'sent', sent_at: new Date().toISOString() });
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

  // Release logs we claimed but did not finish this run (budget) so the cron
  // runner picks them up immediately on its next tick.
  await releaseClaimedLogs(campaignId, claimTimeIso);

  const stats = await getLogsStats(campaignId);
  try {
    await syncCampaignAnalytics(campaignId);
  } catch (analyticsError) {
    logErr(`Analytics sync failed (non-fatal): ${(analyticsError as Error).message}`);
  }

  // Send Now semantics: a normal campaign must complete inside this invocation
  // and end as "sent". The cron hand-off is reserved for campaigns that are
  // genuinely too large for the edge-function time budget (or recipient cap) —
  // a small list must never be returned as "scheduled".
  const budgetHit = Date.now() - start > TIME_BUDGET_MS;

  if (budgetHit || sent + failed >= MAX_EMAILS_PER_RUN) {
    // Hand off to scheduled-campaign-runner: set schedule to the current IST
    // time so the campaign is immediately due on the next cron tick.
    await finalizeCampaign(campaignId, {
      status: 'scheduled',
      schedule_date: todayISTDateStr(),
      schedule_time: nowISTTimeStr(),
      recipient_count: stats.total,
    });
    log(
      `Campaign ${campaignId} exceeded the invocation budget (${stats.total} recipient(s), ` +
      `${stats.pending} still pending) — returned to "scheduled" so the cron runner continues.`
    );
    return { sent, failed, total: stats.total, handedOff: true, status: 'scheduled' };
  }

  // Normal completion: this invocation was the send window, so finalize any
  // recipient still pending (e.g. a transient failure whose retry was scheduled
  // beyond this run) as "failed" — never leave them stranded pending on a
  // completed campaign, and never flip a small Send Now to "scheduled".
  // Only "pending" rows are touched here; in-flight "sending" rows can only
  // belong to a concurrent invocation, which must be left alone. The existing
  // error_message (the real SMTP reason) is preserved for diagnostics.
  const { error: leftoverError } = await supabase
    .from('email_logs')
    .update({ status: 'failed', last_attempt_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .eq('status', 'pending');
  if (leftoverError) {
    logErr(`Failed to finalize leftover email logs: ${leftoverError.message}`);
  }

  const finalStats = await getLogsStats(campaignId);
  const delivered = Number(finalStats.delivered) || 0;
  if (delivered > 0) {
    await finalizeCampaign(campaignId, {
      status: 'sent',
      sent_at: new Date().toISOString(),
      recipient_count: finalStats.total,
    });
    log(
      `Campaign ${campaignId} marked "sent" (${delivered} delivered / ` +
      `${finalStats.failed} failed / ${finalStats.total} total)`
    );
    return { sent, failed, total: finalStats.total, handedOff: false, status: 'sent' };
  }
  // Every recipient permanently failed — honest status, never a fake "sent".
  await finalizeCampaign(campaignId, {
    status: 'failed',
    recipient_count: finalStats.total,
  });
  logErr(
    `Campaign ${campaignId} marked "failed" — 0 delivered of ` +
    `${finalStats.failed} recipient(s).`
  );
  return { sent, failed, total: finalStats.total, handedOff: false, status: 'failed' };
}

// ─── Main entry ────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Browser preflight — the gateway forwards OPTIONS to this function and does
  // NOT add CORS headers, so handle it here (before any auth check) with the
  // headers the browser requires.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return respond(405, { success: false, error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    logErr('Unauthorized — missing/invalid Supabase JWT or project key');
    return respond(401, {
      success: false,
      error: 'Unauthorized: send a valid Supabase JWT or the project anon/publishable key',
    });
  }

  let payload: CampaignPayload;
  try {
    payload = await req.json();
  } catch {
    return respond(400, { success: false, error: 'Invalid JSON body' });
  }

  try {
    const record = buildCampaignRecord(payload, 'sending');
    const saved = await saveCampaignRecord(record);
    log(`Saved campaign ${saved.id} — sending now`);

    // Persist the composer's attachment metadata so the send below (and any
    // cron hand-off) knows which Storage files belong to this campaign.
    await saveCampaignAttachments(saved.id, payload.attachments);

    const contacts = await resolveContactsForCampaign(saved.id, saved.audience_segment, payload.selected_contact_ids);
    const result = await processCampaign(saved.id, contacts);

    return respond(200, {
      success: true,
      data: {
        campaign_id: saved.id,
        status: result.status,
        message: result.status === 'scheduled'
          ? 'Campaign is being sent; the remainder is in progress.'
          : result.status === 'failed'
            ? 'Campaign could not be sent (no deliverable recipients or all sends failed).'
            : 'Campaign sent.',
        recipient_count: result.total,
      },
    });
  } catch (error) {
    logErr(`Send failed: ${(error as Error).message}`);
    return respond(400, { success: false, error: (error as Error).message });
  }
});
