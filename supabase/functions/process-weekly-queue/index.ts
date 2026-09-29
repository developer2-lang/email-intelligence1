/**
 * process-weekly-queue — Supabase Edge Function (weekly new-contact emails).
 *
 * Triggered by a pg_cron job every THURSDAY, every 30 minutes, 02:00–18:00 UTC
 * (= 07:30 AM–11:30 PM IST), via supabase/weekly-queue-setup.sql (job name
 * weekly-new-contact-email, schedule '* /30 2-18 * * 4'). It drains
 * `public.weekly_email_queue` —
 * the rows snapshotted by the `contacts` INSERT trigger
 * (20260927000000_weekly_new_contact_automation.sql) — and emails each NEW
 * contact exactly ONCE through Gmail SMTP.
 *
 * ─── TWO INDEPENDENT ENTRY POINTS, ONE SENDER ─────────────────────────────
 * The same function serves two pg_cron jobs, distinguished ONLY by the JSON
 * body's `mode` field. Nothing else differs — same SMTP, same template, same
 * claim/atomicity/retry logic, same per-run budget.
 *
 *   mode "all" (default, body '{}')  → job `weekly-new-contact-email`,
 *     the 30-minute 02:00-18:00 UTC Thursday cron (07:30 AM-11:30 PM IST). THIS
 *     IS THE PRE-EXISTING AUTOMATIC FLOW AND IT IS UNCHANGED. It still POSTs
 *     '{}'. See supabase/weekly-queue-setup.sql.
 *
 *   mode "scheduled_only"  → job `weekly-queue-manual-schedule`, a 5-minute
 *     cron (every 5 minutes, all week). Additive; only picks up rows a user
 *     manually rescheduled from the Weekly Queue page to a date/time that is
 *     NOT a Thursday slot. See supabase/weekly-queue-manual-schedule-setup.sql.

 *
 * ─── scheduled_for (migration 20261011000000) ──────────────────────────────
 * A pending row is claimable only when it is DUE:
 *
 *   scheduled_for IS NULL      → always due. This is every row created by the
 *     contacts/leads triggers and every row that existed before the migration,
 *     so the Thursday 7:30 AM IST behaviour is byte-for-byte the same as before.
 *   scheduled_for IS NOT NULL  → due only once scheduled_for <= now(). A record
 *     the user moved to "Oct 1, 10:00 AM IST" simply waits for that instant.
 *
 * In "scheduled_only" mode the claim is additionally narrowed to the EARLIEST
 * distinct scheduled_for instant among due rows, so one cron fire drains exactly
 * one manual batch and can never bleed into the next (which is due later).
 *
 *   - NEW contacts only: the queue table is only ever populated by an INSERT
 *     trigger on public.contacts, so contacts that existed before the
 *     migration are never present.
 *   - One-time send: UNIQUE(contact_id) means a contact has at most one queue
 *     row; rows are atomically claimed (pending → sending) so concurrent
 *     invocations (cron + a manual smoke test) can never double-send.
 *   - Manual rescheduling is a pure due-date change: the Weekly Queue page
 *     UPDATEs scheduled_for on selected PENDING rows and nothing else. This
 *     function remains the only thing that ever sends, and it never marks a row
 *     'sent' — only a successful SMTP send does.
 *   - Budget pacing: the free Edge Function wall-clock limit is ~150s, so the
 *     run stops at TIME_BUDGET_MS / MAX_EMAILS_PER_RUN and releases the
 *     remainder back to 'pending' — leftovers are drained by the next run.
 *   - Retries: a failed send backs off 10 min → 1 h → 24 h, then 'failed'.
 *   - 'skipped' = undeliverable email or the contact row no longer exists —
 *     never emailed, never retried.
 *   - Per-email tracking: the HTML embeds the email-open-tracker pixel and
 *     rewrites links through click-tracker; opens/clicks are stored on this
 *     queue row's opened_at/clicked_at (first open/click only).
 *
 * TEMPLATE RESOLUTION (the email body + subject), in order:
 *   1. WELCOME_TEMPLATE_ID secret → that templates row (Storage file, else
 *      templates.body).
 *   2. The most recent templates row whose name matches "welcome".
 *   3. A small built-in welcome message (kept working with zero setup).
 * Subject: WELCOME_SUBJECT secret, else the template's subject column, else
 * a default. Merge tags ({{first_name}}, {{company}}, ...) are personalized
 * per recipient via the shared _shared/personalization.ts helper.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { personalizeTemplate } from '../_shared/personalization.ts';
import { toEmailSafeHtml } from '../_shared/email-render.ts';
import { sendSmtpEmail } from '../_shared/smtp.ts';

const supabaseUrl = Deno.env.get('R_SUPABASE_URL')!;
const supabaseKey =
  Deno.env.get('R_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

// Supabase edge-function base URL used to build the open-pixel / click-redirect
// URLs (same convention as send-campaign / sequence-runner).
const EDGE_FUNCTION_BASE =
  (Deno.env.get('R_SUPABASE_EDGE_FUNCTION_URL') || '').trim().replace(/\/+$/, '') ||
  `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`;

// ─── Configuration (env) ───────────────────────────────────────────────────
// Prefer the R_-prefixed secret (this project's convention — R_CRON_SECRET is
// set on the Edge Function); fall back to the legacy CRON_SECRET name so the
// function keeps working if a deploy predates the rename. The cron job sends
// this same value in the x-cron-secret header (read from the Supabase Vault
// secret `weekly_cron_secret` at run time), so the two must match exactly.
const CRON_SECRET = (Deno.env.get('R_CRON_SECRET') || Deno.env.get('CRON_SECRET') || '').trim();
const WELCOME_TEMPLATE_ID = (Deno.env.get('WELCOME_TEMPLATE_ID') || '').trim();
const WELCOME_SUBJECT = (Deno.env.get('WELCOME_SUBJECT') || '').trim();

// Pacing / budget. Keep well under the ~150s Edge wall-clock limit.
const EMAIL_DELAY_MS = Math.max(0, parseInt(Deno.env.get('EMAIL_DELAY_MS') || '200', 10));
const MAX_EMAILS_PER_RUN = Math.max(1, parseInt(Deno.env.get('MAX_EMAILS_PER_RUN') || '30', 10));
const TIME_BUDGET_MS = Math.max(1000, parseInt(Deno.env.get('TIME_BUDGET_MS') || '120000', 10));

// A contact stuck in 'sending' for this long was left by a crashed run.
const STALE_SENDING_MS = 10 * 60 * 1000;
// Weekly cadence → gentle backoff: 10 min, 1 h, 24 h, then 'failed'.
const RETRY_DELAYS = [600, 3600, 86400]; // seconds
const MAX_RETRIES = RETRY_DELAYS.length;

function log(...args: unknown[]) {
  console.log('[WeeklyQueue]', ...args);
}
function logErr(...args: unknown[]) {
  console.error('[WeeklyQueue]', ...args);
}

// ─── HTML/text helpers (mirror send-campaign) ──────────────────────────────
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

// ─── Per-email open/click tracking (mirrors send-campaign) ─────────────────
// Rewrites every clickable external URL to the click-tracker Edge Function,
// which records the FIRST click on this weekly_email_queue row
// (queue_id -> clicked_at) and 302-redirects to the destination. mailto:,
// #anchors, relative URLs and URLs in non-href attributes (e.g. <img src>)
// are left untouched, so the open pixel keeps working.
function rewriteLinksForTracking(html: string, queueId: string): string {
  const clickUrl = (url: string) =>
    `${EDGE_FUNCTION_BASE}/click-tracker?source=weekly&queue_id=${encodeURIComponent(queueId)}&url=${encodeURIComponent(url)}`;
  const HREF_RE = /(\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)(["'])/gi;
  const TOKEN_RE = /(<[^>]*>)|(https?:\/\/[^\s<>"']+)/gi;

  return String(html || '').replace(TOKEN_RE, (match, tag: string, bareUrl: string) => {
    if (tag) {
      return tag.replace(HREF_RE, (m, p: string, q: string, url: string, q2: string) => {
        if (url.includes('/click-tracker')) return m;
        return `${p}${q}${clickUrl(url)}${q2}`;
      });
    }
    const clean = bareUrl.replace(/[.,;:!?)\]}$]*$/, '');
    if (!/^https?:\/\//i.test(clean)) return match;
    const punct = bareUrl.slice(clean.length);
    return `<a href="${clickUrl(clean)}">${clean}</a>${punct}`;
  });
}

/** Always-reachable open pixel handled by the email-open-tracker function. */
function appendWeeklyOpenPixel(html: string, queueId: string, contactEmail: string): string {
  const params = new URLSearchParams({
    action: 'track',
    source: 'weekly',
    queue_id: queueId,
    contact_email: contactEmail,
  });
  const pixelUrl = `${EDGE_FUNCTION_BASE}/email-open-tracker?${params.toString()}`;
  const pixel =
    `<img src="${pixelUrl}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${pixel}\n</body>`)
    : `${html}\n${pixel}`;
}

// ─── Recipient validation (same rules as send-campaign) ────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_DELIVERABLE_EMAIL_RE =
  /(^__)|@example\.(com|org|net|edu)$|\.(test|invalid|localhost|local)$/i;

function isDeliverableRecipientEmail(email: string): boolean {
  const value = String(email || '').trim();
  if (!value) return false;
  if (!EMAIL_REGEX.test(value)) return false;
  return !NON_DELIVERABLE_EMAIL_RE.test(value);
}

// ─── Template resolution ───────────────────────────────────────────────────
interface TemplateRow {
  id?: string;
  name?: string | null;
  body?: string | null;
  subject?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
}

async function templateRowHtml(tpl: TemplateRow): Promise<string | null> {
  if (tpl.storage_bucket && tpl.storage_path) {
    try {
      const { data: file } = await supabase.storage
        .from(tpl.storage_bucket)
        .download(tpl.storage_path);
      if (file) return await file.text();
      log(`[Template] Storage file "${tpl.storage_path}" missing — falling back to templates.body`);
    } catch (error) {
      log(`[Template] Storage download failed — falling back to templates.body: ${(error as Error).message}`);
    }
  }
  return String(tpl.body || '').trim() || null;
}

function templateSubject(tpl: TemplateRow): string {
  return typeof tpl.subject === 'string' && tpl.subject.trim() ? tpl.subject.trim() : '';
}

/** Resolve a Welcome template: id secret → name-like "welcome" → null. */
async function findWelcomeTemplate(): Promise<{ html: string; subject: string; source: string } | null> {
  if (WELCOME_TEMPLATE_ID) {
    try {
      const { data: row, error } = await supabase
        .from('templates')
        .select('*')
        .eq('id', WELCOME_TEMPLATE_ID)
        .maybeSingle();
      if (!error && row) {
        const html = await templateRowHtml(row as TemplateRow);
        if (html) {
          return { html, subject: templateSubject(row as TemplateRow), source: `WELCOME_TEMPLATE_ID (${WELCOME_TEMPLATE_ID})` };
        }
      }
    } catch (error) {
      log(`[Template] lookup by id failed: ${(error as Error).message}`);
    }
  }

  try {
    const base = supabase.from('templates').select('*').ilike('name', '%welcome%');
    let { data: rows, error } = await base.order('created_at', { ascending: false }).limit(1);
    if (error) {
      // created_at may not be a column on every install — retry without ordering.
      const retry = await base.limit(1);
      rows = retry.data;
      error = retry.error;
    }
    if (!error && rows && rows.length > 0) {
      const row = rows[0];
      const html = await templateRowHtml(row as TemplateRow);
      if (html) {
        return { html, subject: templateSubject(row as TemplateRow), source: `name-like "welcome" (${row.id})` };
      }
    }
  } catch (error) {
    log(`[Template] name lookup failed: ${(error as Error).message}`);
  }

  return null;
}

const DEFAULT_WELCOME_HTML = [
  '<p style="margin:0 0 12px;">Hi {{first_name}},</p>',
  '<p style="margin:0 0 12px;">Thanks for connecting — I\'m Rupali from IUOVA Design Consultancy. We help B2B teams turn cold outreach into booked meetings.</p>',
  '<p style="margin:0 0 12px;">Would you be open to a quick 15-minute call this week to explore how we could work together?</p>',
  '<p style="margin:0;">Best regards,<br/>Rupali Sirsath<br/>Business Development | IUOVA Design Consultancy</p>',
].join('\n');
const DEFAULT_WELCOME_SUBJECT = 'Welcome, {{first_name}}!';

async function resolveWelcomeContent(): Promise<{ html: string; subjectBase: string }> {
  const tpl = await findWelcomeTemplate();
  if (tpl) {
    log(`[Template] resolved via ${tpl.source}`);
    return { html: tpl.html, subjectBase: WELCOME_SUBJECT || tpl.subject || DEFAULT_WELCOME_SUBJECT };
  }
  log('[Template] no Welcome template found — using built-in HTML');
  return { html: DEFAULT_WELCOME_HTML, subjectBase: WELCOME_SUBJECT || DEFAULT_WELCOME_SUBJECT };
}

// ─── Queue row helpers ─────────────────────────────────────────────────────
async function markRow(id: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('weekly_email_queue').update(updates).eq('id', id);
  if (error) throw new Error(`Failed to update queue row ${id}: ${error.message}`);
}

/** Which rows this invocation is allowed to work on. */
type QueueMode = 'all' | 'scheduled_only';

/**
 * Recover rows a crashed run left in 'sending', then atomically claim up to
 * `limit` DUE pending rows (status 'pending' → 'sending'). Concurrent
 * invocations cannot double-claim because the UPDATE re-checks status='pending'.
 *
 * Due-ness is driven by `scheduled_for` (migration 20261011000000):
 *
 *   'all'            → scheduled_for IS NULL **or** scheduled_for <= now().
 *                      Rows with no manual schedule (i.e. every row the
 *                      contacts/leads triggers create) stay unconditionally
 *                      eligible, which is exactly the pre-migration behaviour —
 *                      the Thursday 07:30 AM IST run is unaffected. Rows a user
 *                      manually rescheduled are additionally honoured if they
 *                      have come due by then.
 *   'scheduled_only' → scheduled_for IS NOT NULL AND scheduled_for <= now(),
 *                      and only for the EARLIEST distinct due instant.
 *
 * Ordering is deliberately untouched in 'all' mode (`queued_at asc`, the
 * original query) so Thursday behaves identically. 'scheduled_only' orders by
 * scheduled_for first, because a manual batch schedule is expressed as
 * increasing timestamps.
 */
async function claimPending(
  limit: number,
  mode: QueueMode = 'all'
): Promise<{ claimed: any[]; reclaimed: number }> {
  const nowIso = new Date().toISOString();
  let reclaimed = 0;

  const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const { data: stale, error: staleError } = await supabase
    .from('weekly_email_queue')
    .select('id')
    .eq('status', 'sending')
    .lte('attempted_at', staleCutoff);
  if (staleError) {
    if (staleError.code === '42P01') {
      throw new Error('public.weekly_email_queue does not exist — apply migration 20260927000000 first');
    }
    logErr(`[Reclaim] failed to list stale rows: ${staleError.message}`);
  } else if (stale && stale.length > 0) {
    const staleIds = stale.map((r: any) => r.id);
    const { error: reclaimError } = await supabase
      .from('weekly_email_queue')
      .update({ status: 'pending', attempted_at: null })
      .in('id', staleIds)
      .eq('status', 'sending');
    if (reclaimError) {
      logErr(`[Reclaim] failed: ${reclaimError.message}`);
    } else {
      reclaimed = staleIds.length;
      log(`[Reclaim] released ${reclaimed} crashed row(s) back to pending`);
    }
  }

  // Both branches share the same base filters; only the due-ness gate, the
  // ordering and (in scheduled_only) the batch narrowing differ.
  const basePending = () =>
    supabase
      .from('weekly_email_queue')
      .select('id,scheduled_for')
      .eq('status', 'pending')
      .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`);

  const { data: pending, error: pendingError } =
    mode === 'scheduled_only'
      ? await basePending()
          // Only rows a user manually rescheduled, and only once they are due.
          .not('scheduled_for', 'is', null)
          .lte('scheduled_for', nowIso)
          .order('scheduled_for', { ascending: true })
          .order('queued_at', { ascending: true })
          .limit(limit)
      : await basePending()
          // Original ordering, plus the due-ness gate for manually rescheduled
          // rows. `scheduled_for.is.null` keeps every trigger-created row
          // unconditionally eligible → Thursday is unchanged.
          .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
          .order('queued_at', { ascending: true })
          .limit(limit);

  if (pendingError) throw new Error(`Failed to list pending rows: ${pendingError.message}`);
  if (!pending || pending.length === 0) return { claimed: [], reclaimed };

  // One fire drains exactly one manual batch: keep only the rows sharing the
  // earliest due instant, so a batch that is due at 11:00 can never be sent
  // early by a 10:05 fire that still has claim capacity left over.
  let candidates = pending as any[];
  if (mode === 'scheduled_only' && candidates.length > 0) {
    const earliest = candidates[0].scheduled_for as string | null;
    const sameInstant = candidates.filter((r: any) => r.scheduled_for === earliest);
    if (sameInstant.length < candidates.length) {
      log(
        `[Claim] narrowing to earliest due instant ${earliest} — ${sameInstant.length}/${candidates.length} row(s) held back for a later batch`
      );
    }
    candidates = sameInstant.slice(0, limit);
  }

  const ids = candidates.map((p: any) => p.id);
  // Re-assert due-ness in the UPDATE as well, so a row whose scheduled_for was
  // pushed forward between the SELECT and this write can never be claimed early.
  const baseClaim = () =>
    supabase
      .from('weekly_email_queue')
      .update({ status: 'sending', attempted_at: nowIso })
      .in('id', ids)
      .eq('status', 'pending')
      .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`);

  const { data: claimed, error: claimError } =
    mode === 'scheduled_only'
      ? await baseClaim().not('scheduled_for', 'is', null).select('*')
      : await baseClaim().select('*');

  if (claimError) throw new Error(`Failed to claim pending rows: ${claimError.message}`);
  return { claimed: claimed || [], reclaimed };
}

// ─── One recipient ─────────────────────────────────────────────────────────
async function sendOne(
  row: any,
  contactMap: Map<string, any>,
  bodyTemplate: string,
  subjectTemplate: string
): Promise<{ status: 'sent' | 'skipped' | 'retried' | 'failed' }> {
  const contact = contactMap.get(row.contact_id) || null;
  const to = String(contact?.email || row.email || '').trim();

  if (!contact) {
    await markRow(row.id, { status: 'skipped', error_message: 'Contact no longer exists' });
    log(`SKIPPED ${to} — contact ${row.contact_id} not found`);
    return { status: 'skipped' };
  }
  if (!isDeliverableRecipientEmail(to)) {
    await markRow(row.id, { status: 'skipped', error_message: `Undeliverable email address: ${to}` });
    log(`SKIPPED ${to} — undeliverable email address`);
    return { status: 'skipped' };
  }

  try {
    const decoded = decodeHtmlEntities(personalizeTemplate(bodyTemplate, contact, to));
    const personalizedHtml = hasHtmlTags(decoded) ? decoded : plainTextToHtml(decoded);
    const plainText = stripHtml(personalizedHtml);
    // Per-email tracking: rewrite links for click tracking and embed the open
    // pixel, both keyed on this queue row's id (first open/click only).
    const tracked = rewriteLinksForTracking(personalizedHtml, row.id);
    const html = wrapHtmlDocument(toEmailSafeHtml(appendWeeklyOpenPixel(tracked, row.id, to)));
    const subject = personalizeTemplate(subjectTemplate, contact, to);

    log(`Sending → ${to}`);
    await sendSmtpEmail({ to, subject, html, text: plainText });

    await markRow(row.id, { status: 'sent', sent_at: new Date().toISOString(), error_message: null });
    log(`Sent → ${to}`);
    return { status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = (row.attempts || 0) + 1;
    logErr(`FAILED ${to}: ${message}`);
    if (attempts > MAX_RETRIES) {
      await markRow(row.id, { status: 'failed', attempts, error_message: `[SEND_FAILED] ${message}` });
      return { status: 'failed' };
    }
    const delaySec = RETRY_DELAYS[attempts - 1];
    await markRow(row.id, {
      status: 'pending',
      attempts,
      error_message: `[SEND_FAILED] ${message}`,
      next_retry_at: new Date(Date.now() + delaySec * 1000).toISOString(),
    });
    logErr(`Retry ${attempts} scheduled for ${to} in ${delaySec}s`);
    return { status: 'retried' };
  }
}

// ─── Main processing loop ──────────────────────────────────────────────────
async function processQueue(mode: QueueMode) {
  const start = Date.now();
  const counts = {
    mode,
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    released: 0,
    pending_remaining: 0,
  };

  const { claimed, reclaimed } = await claimPending(MAX_EMAILS_PER_RUN, mode);
  counts.claimed = claimed.length;
  counts.reclaimed = reclaimed;

  if (claimed.length === 0) {
    log(`No due queue rows for mode "${mode}".`);
    return counts;
  }

  const { html: bodyTemplate, subjectBase: subjectTemplate } = await resolveWelcomeContent();

  const allContactIds = Array.from(new Set(claimed.map((r: any) => r.contact_id)));
  const normalContactIds = allContactIds.filter((id: string) => !id.startsWith('lead-'));
  const leadQueueIds = allContactIds.filter((id: string) => id.startsWith('lead-'));

  const contactMap = new Map<string, any>();

  if (normalContactIds.length > 0) {
    const { data: contactRows, error: contactsError } = await supabase
      .from('contacts')
      .select('*')
      .in('id', normalContactIds);
    if (contactsError) throw new Error(`Failed to fetch contacts: ${contactsError.message}`);
    (contactRows || []).forEach((c: any) => contactMap.set(String(c.id), c));
  }

  if (leadQueueIds.length > 0) {
    const cleanLeadIds = leadQueueIds.map((id: string) => id.replace(/^lead-/, ''));
    const { data: leadRows, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .in('id', cleanLeadIds);
    if (leadsError) throw new Error(`Failed to fetch leads: ${leadsError.message}`);
    (leadRows || []).forEach((l: any) => {
      contactMap.set(`lead-${l.id}`, {
        ...l,
        company: l.company_name,
      });
    });
  }

  const finished = new Set<string>();

  for (let i = 0; i < claimed.length; i++) {
    if (dateBudgetExceeded(start)) break;
    if (i > 0 && EMAIL_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, EMAIL_DELAY_MS));
    }
    const row = claimed[i];
    try {
      const result = await sendOne(row, contactMap, bodyTemplate, subjectTemplate);
      finished.add(row.id);
      counts[result.status] = (counts[result.status] || 0) + 1;
    } catch (error) {
      logErr(`Unhandled error for ${row.email || row.contact_id}: ${(error as Error).message}`);
      break;
    }
  }

  // Release anything we claimed but did not finish (budget or unexpected error).
  const leftover = claimed.filter((r: any) => !finished.has(r.id)).map((r: any) => r.id);
  if (leftover.length > 0) {
    const { error } = await supabase
      .from('weekly_email_queue')
      .update({ status: 'pending' })
      .in('id', leftover)
      .eq('status', 'sending');
    if (error) logErr(`[Release] failed: ${error.message}`);
    counts.released = leftover.length;
    log(`Budget/error exit — released ${leftover.length} claimed row(s) back to pending.`);
  }

  const { count } = await supabase
    .from('weekly_email_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  counts.pending_remaining = count || 0;

  log(`Done in ${Date.now() - start}ms — ${counts.sent} sent, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.retried} retried, ${counts.released} released, ${counts.pending_remaining} pending left`);
  return counts;
}

function dateBudgetExceeded(start: number): boolean {
  return Date.now() - start > TIME_BUDGET_MS;
}

/**
 * Read the `mode` field from the cron POST body.
 *
 * The pre-existing Thursday job posts '{}', which resolves to 'all' — the
 * original, unchanged behaviour. The additive manual-schedule job posts
 * '{"mode":"scheduled_only"}'. An unreadable/absent/empty body is treated as
 * 'all' so a malformed request can never accidentally restrict the run.
 */
async function readMode(req: Request): Promise<QueueMode> {
  try {
    const raw = await req.text();
    if (!raw.trim()) return 'all';
    const parsed = JSON.parse(raw);
    return parsed?.mode === 'scheduled_only' ? 'scheduled_only' : 'all';
  } catch {
    return 'all';
  }
}

// ─── Main entry ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const start = Date.now();
  // Robust header check: tolerate trailing whitespace, log a clear hint, and
  // reject unless a secret is actually set (a set-but-empty env var must fail
  // closed, never pass). The caller — job 49 `weekly-new-contact-email` via
  // pg_net — must send exactly this value in x-cron-secret.
  const secret = (req.headers.get('x-cron-secret') || '').trim();
  if (!CRON_SECRET || !secret || secret !== CRON_SECRET) {
    logErr('Unauthorized — missing/invalid x-cron-secret header');
    logErr('Hint: set R_CRON_SECRET (or CRON_SECRET) to exactly the value the cron job sends in the x-cron-secret header');
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // The existing Thursday job POSTs '{}' → 'all' → identical behaviour to
  // before this field existed. The additive job POSTs {"mode":"scheduled_only"}.
  const mode = await readMode(req);
  log(`Processing weekly email queue (mode: ${mode})...`);

  try {
    const summary = await processQueue(mode);
    return new Response(
      JSON.stringify({ success: true, elapsed_ms: Date.now() - start, ...summary }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    logErr(`Tick failed: ${(error as Error).message}`);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
