/**
 * send-followup — Supabase Edge Function ("Send Follow-up").
 *
 * Lets the React app send follow-up emails directly via Gmail SMTP with no
 * local Node.js backend (localhost:5000). It mirrors the exact conventions of
 * the existing send-campaign Edge Function (CORS, auth, SMTP client, open
 * tracking) and ports the behaviour of backend/services/followupService.js:
 *
 *   - Recipients ALWAYS come from the ORIGINAL campaign's openers
 *     (email_logs opened=true) — verified again at send time. A contact who
 *     never opened the original is skipped, never emailed, even if selected.
 *   - Duplicate protection: campaign_followup_logs rows with status
 *     'sent'/'already_sent' for the (campaign, contact, follow-up) triple are
 *     skipped, and the UNIQUE constraint on that triple is the final gate.
 *   - Same tables as the cloud scheduler: campaigns, campaign_contacts,
 *     email_logs, campaign_analytics, campaign_followup_logs, followup_history.
 *   - Open tracking: every follow-up embeds the existing campaign-tracker
 *     Edge Function pixel so opens are recorded on the follow-up campaign's
 *     OWN email_logs (analytics for the follow-up, never the original).
 *
 * ACTIONS (POST JSON body):
 *   { action: 'send_selected', campaign_id, contact_ids, followup_campaign_id }
 *       Send the follow-up campaign to the selected opened contacts.
 *       campaign_id is the ORIGINAL campaign id, or 'all' to verify against
 *       every campaign (union recipients, deduped per contact).
 *   { action: 'send_pending', pending_id }
 *       Send one pending follow-up from campaign_followup_logs now, after
 *       re-verifying the recipient genuinely opened the original campaign.
 *
 * AUTH: identical to send-campaign — accepts the project anon/publishable key
 * in the `apikey` or `Authorization: Bearer` header (verified against
 * SUPABASE_ANON_KEY or the SEND_FOLLOWUP_ANON_KEY secret) or a valid Supabase
 * JWT whose `iss` matches this project. SMTP credentials and service-role stay
 * server-side.
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

const TRIGGER_TYPE = 'opened';

function log(...args: unknown[]) {
  console.log('[SendFollowup]', ...args);
}
function logErr(...args: unknown[]) {
  console.error('[SendFollowup]', ...args);
}

// ─── CORS + JSON responses ─────────────────────────────────────────────────
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

// ─── Auth guard (same as send-campaign) ────────────────────────────────────
const ANON_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const runtimeKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  if (runtimeKey) keys.add(runtimeKey);
  const explicitKey = Deno.env.get('SEND_FOLLOWUP_ANON_KEY')?.trim();
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
 * tracking_id uniquely identifies the follow-up email_log, so the follow-up
 * campaign's OWN analytics gets the click.
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
      // Body parts (multi-line HTML/text) carry embedded '\n' breaks. Split them
      // so EVERY transmitted line is a strict CRLF line (RFC 5321 §4.5.3.1.6) and
      // each line is dot-stuffed (SMTP transparency, RFC 5321 §4.5.2). A mixed
      // LF/CRLF stream can make mail servers mis-segment the MIME parts — which is
      // what causes Gmail to show the attachment in the list view but fail to render
      // its attachment card inside the opened message.
      const normalized = String(line).replace(/\r?\n/g, '\r\n');
      for (const piece of normalized.split('\r\n')) {
        await this.cmd(/^\./.test(piece) ? '.' + piece : piece);
      }
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
  const boundary = `----=_EmailIntelligence_${crypto.randomUUID()}`;
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

// ─── Supabase helpers (mirror supabaseService / emailLogService) ───────────
async function getCampaign(campaignId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, campaign_name, subject_line, from_name, audience_segment, campaign_type, email_body, html_content, template_name, status, mailchimp_campaign_id, recipient_count, sent_at, scheduled_at, created_at, updated_at')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch campaign: ${error.message}`);
  return data || null;
}

/**
 * True when a follow-up campaign has an active schedule (a `campaign_schedules`
 * row) and is set to `status='scheduled'`. Such follow-ups are delivered by the
 * campaign scheduler to openers only at the scheduled times — they must NOT be
 * sent on-open (sync_pending) or on-demand (send_selected / send_pending).
 */
async function isScheduledFollowup(followupCampaignId: string): Promise<boolean> {
  if (!followupCampaignId) return false;
  const { data: schedule, error: scheduleError } = await supabase
    .from('campaign_schedules')
    .select('id')
    .eq('campaign_id', followupCampaignId)
    .limit(1);
  if (scheduleError) return false;
  if (!schedule || schedule.length === 0) return false;

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('status')
    .eq('id', followupCampaignId)
    .maybeSingle();
  if (campaignError) return false;
  return campaign && String(campaign.status).toLowerCase() === 'scheduled';
}

// ─── Attachments (mirrors send-campaign) ───────────────────────────────────
interface MimeAttachment {
  file_name: string;
  file_type: string;
  data: Uint8Array;
}

/** Load the follow-up campaign's attachment metadata rows from Supabase. */
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
 * Load every attachment record for the follow-up campaign and download all the
 * files from Storage, ready to embed in the MIME message. If any file cannot be
 * downloaded the send aborts with a clear error instead of mailing the
 * follow-up without the attachment.
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
  log(`[Campaign Attachment] Sending ${mime.length} attachment(s) with every follow-up email`);
  return mime;
}

async function getContactById(contactId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch contact: ${error.message}`);
  return data || null;
}

async function fetchContacts(): Promise<any[]> {
  const { data, error } = await supabase.from('contacts').select('*');
  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
  return data || [];
}

async function getFollowupLog(
  campaignId: string,
  contactId: string,
  followupCampaignId: string
): Promise<any | null> {
  const { data, error } = await supabase
    .from('campaign_followup_logs')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId)
    .eq('followup_campaign_id', followupCampaignId)
    .maybeSingle();
  if (error) throw new Error(`Failed to check for an existing follow-up: ${error.message}`);
  return data || null;
}

async function insertFollowupLog(fields: {
  campaignId: string;
  contactId: string;
  email: string;
  followupCampaignId: string;
  openedAt: string | null;
}): Promise<any | null> {
  const { data, error } = await supabase
    .from('campaign_followup_logs')
    .insert({
      campaign_id: fields.campaignId,
      contact_id: fields.contactId,
      email: fields.email,
      followup_campaign_id: fields.followupCampaignId,
      opened_at: fields.openedAt,
      status: 'pending',
    })
    .select('*')
    .maybeSingle();
  if (error) {
    // 23505 = unique_violation on (campaign_id, contact_id, followup_campaign_id)
    // → the follow-up is already queued/sent; treat as a no-op.
    if (error.code === '23505') return null;
    throw new Error(`Failed to record follow-up: ${error.message}`);
  }
  return data || null;
}

async function updateFollowupLog(id: string, updates: Record<string, unknown>): Promise<any | null> {
  const { data, error } = await supabase
    .from('campaign_followup_logs')
    .update(updates)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Failed to update follow-up record: ${error.message}`);
  return data || null;
}

async function getOrCreateEmailLog(
  campaignId: string,
  contactId: string,
  email: string
): Promise<any> {
  const base = {
    campaign_id: campaignId,
    contact_id: contactId,
    email,
    status: 'pending',
    retry_count: 0,
    tracking_id: crypto.randomUUID(),
  };

  const { data: existing, error: existingError } = await supabase
    .from('email_logs')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (!existingError && existing) return existing;

  const { data, error } = await supabase
    .from('email_logs')
    .insert(base)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      const { data: again, error: againError } = await supabase
        .from('email_logs')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('contact_id', contactId)
        .maybeSingle();
      if (!againError && again) return again;
      throw new Error(`Failed to queue the follow-up email: ${error.message}`);
    }
    // email_logs may predate the tracking columns → retry without tracking_id.
    if (error.code === '42703') {
      const { tracking_id: _t, ...rest } = base;
      const { data: fallback, error: fallbackError } = await supabase
        .from('email_logs')
        .insert(rest)
        .select('*')
        .maybeSingle();
      if (!fallbackError && fallback) return fallback;
      throw new Error(`Failed to queue the follow-up email: ${error.message}`);
    }
    throw new Error(`Failed to queue the follow-up email: ${error.message}`);
  }
  return data;
}

async function updateEmailLog(id: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('email_logs').update(updates).eq('id', id);
  if (error) throw new Error(`Failed to update email log ${id}: ${error.message}`);
}

async function linkContactToCampaign(campaignId: string, contactId: string): Promise<void> {
  const { error } = await supabase
    .from('campaign_contacts')
    .insert({ campaign_id: campaignId, contact_id: contactId });
  if (error && error.code !== '42P01' && error.code !== '23505') {
    throw new Error(`Failed to link follow-up recipient to campaign_contacts: ${error.message}`);
  }
}

async function recordFollowupHistory(fields: {
  campaignId: string;
  contactId: string;
  followupCampaignId: string;
  followupMode: string;
  status: string;
  openedAt: string | null;
  sentAt: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from('followup_history')
    .insert({
      campaign_id: fields.campaignId,
      followup_campaign_id: fields.followupCampaignId,
      contact_id: fields.contactId,
      trigger_type: TRIGGER_TYPE,
      followup_mode: fields.followupMode,
      status: fields.status,
      opened_at: fields.openedAt || null,
      followup_sent_at: fields.sentAt || null,
    });
  if (error && error.code !== '42P01') {
    log(`followup_history insert failed (non-fatal): ${error.message}`);
  }
}

async function syncCampaignAnalytics(campaignId: string): Promise<void> {
  const { data: logs, error: logsError } = await supabase
    .from('email_logs')
    .select('status, opened, clicked')
    .eq('campaign_id', campaignId);
  if (logsError) throw new Error(`Failed to fetch email logs: ${logsError.message}`);

  const delivered = (logs || []).filter((l) => l.status === 'sent').length;
  const opened = (logs || []).filter((l) => l.opened === true).length;
  const clicked = (logs || []).filter((l) => l.clicked === true).length;

  const { error } = await supabase
    .from('campaign_analytics')
    .upsert(
      {
        campaign_id: campaignId,
        total_recipients: (logs || []).length,
        delivered,
        opened,
        clicked,
        open_rate: delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0,
        click_rate: delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0,
      },
      { onConflict: 'campaign_id' }
    );
  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (
      message.includes('cannot insert into view') ||
      message.includes('cannot update view') ||
      message.includes('55000')
    ) {
      log('campaign_analytics is a view; skipping analytics sync.');
      return;
    }
    throw new Error(`Failed to sync analytics: ${error.message}`);
  }
}

async function finalizeFollowupCampaign(followupCampaignId: string): Promise<void> {
  try {
    await syncCampaignAnalytics(followupCampaignId);
    const { data: logs, error } = await supabase
      .from('email_logs')
      .select('id')
      .eq('campaign_id', followupCampaignId);
    if (error) throw new Error(error.message);
    await supabase.from('campaigns').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      recipient_count: (logs || []).length,
      updated_at: new Date().toISOString(),
    }).eq('id', followupCampaignId);
  } catch (error) {
    logErr(`Finalize follow-up campaign ${followupCampaignId} failed (non-fatal): ${(error as Error).message}`);
  }
}

// ─── Opened-recipient verification (mirrors followupService) ───────────────
async function getOpenedByContact(
  campaignId: string,
  isAll: boolean,
  contactIds: string[]
): Promise<Map<string, { email: string; opened_at: string | null; campaign_id: string | null }>> {
  const byContact = new Map<string, { email: string; opened_at: string | null; campaign_id: string | null }>();
  if (contactIds.length === 0) return byContact;

  let query = supabase
    .from('email_logs')
    .select('contact_id, email, opened_at, campaign_id')
    .eq('opened', true)
    .in('contact_id', contactIds);

  if (!isAll) {
    query = query.eq('campaign_id', campaignId);
  }

  const { data: openedLogs, error } = await query;
  if (error) throw new Error(`Failed to verify opened contacts: ${error.message}`);

  for (const log of openedLogs || []) {
    const key = String(log.contact_id);
    const existing = byContact.get(key);
    if (!existing || new Date(log.opened_at || 0) > new Date(existing.opened_at || 0)) {
      byContact.set(key, {
        email: log.email || '',
        opened_at: log.opened_at || null,
        campaign_id: log.campaign_id || null,
      });
    }
  }
  return byContact;
}

// ─── Core email send (mirrors followupService.sendFollowupEmail) ───────────
async function sendFollowupEmail(
  followupCampaignId: string,
  contactId: string,
  email: string,
  attachments: MimeAttachment[] = []
): Promise<any> {
  const followupCampaign = await getCampaign(followupCampaignId);
  if (!followupCampaign) {
    throw new Error('Follow-up campaign not found');
  }

  let contact: any = null;
  try {
    contact = await getContactById(contactId);
  } catch (error) {
    log(`Contact ${contactId} not found — using email from the open event: ${(error as Error).message}`);
  }
  contact = contact || {};

  // Log the message under the follow-up campaign with a unique tracking_id.
  const emailLog = await getOrCreateEmailLog(followupCampaignId, contactId, contact.email || email);
  if (!emailLog || !emailLog.id) {
    throw new Error('Failed to queue the follow-up email');
  }

  // campaign_contacts for the follow-up campaign must contain ONLY the
  // recipients that actually receive the follow-up — never the full audience.
  // Best-effort: a failure must not fail the send.
  try {
    await linkContactToCampaign(followupCampaignId, contactId);
  } catch (error) {
    log(`Could not link follow-up recipient to campaign_contacts: ${(error as Error).message}`);
  }

  const decoded = decodeHtmlEntities(
    personalizeTemplate(followupCampaign.html_content || '', contact, email)
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
  // which records the click on THIS follow-up email_log (clicked/clicked_at)
  // and 302-redirects. Always applied — the edge function is reachable even
  // when the local backend is off, unlike the legacy TRACKING_BASE_URL path.
  let html = rewriteLinksForTracking(personalizedHtml, trackingId, EDGE_FUNCTION_BASE);
  // Always embed the Supabase Edge Function open pixel so this follow-up's
  // email_log is marked opened (not the original campaign's).
  html = appendEdgeTrackingPixel(html, followupCampaign.id, emailLog.email || email, trackingId);
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(html));
  const subject = personalizeTemplate(followupCampaign.subject_line, contact, email);

  // Development-only diagnostics — proves THIS recipient's contact row is the
  // ONLY source of personalization for this email. No credentials are logged.
  log(`[Personalization] recipient=${emailLog.email || email}`);
  log(`[Personalization] contact_id=${contact.id || emailLog.contact_id || '(none)'}`);
  log(`[Personalization] full_name=${contact.full_name || ''}`);
  log(`[Personalization] company=${contact.company || ''}`);
  log(`[Personalization] designation=${contact.designation || ''}`);
  log(`[Personalization] rendered_subject=${String(subject || '').slice(0, 200)}`);
  log(`[Personalization] rendered_body=${stripHtml(personalizedHtml).slice(0, 300)}`);

  log(`Sending follow-up → ${emailLog.email || email}`);
  log(`[FollowUp] attachment_count=${attachments.length}`);
  for (const att of attachments) {
    log(`[FollowUp] attachment filename=${att.file_name}`);
    log(`[FollowUp] attachment disposition=attachment`);
  }
  log(`[FollowUp] multipart type=${attachments.length > 0 ? 'mixed' : 'alternative'}`);
  const result = await sendSmtp({ to: emailLog.email || email, subject, html: docHtml, text: plainText, attachments });
  log(`SMTP accepted ${emailLog.email || email} messageId=${result.messageId}`);
  if (attachments.length > 0) {
    log(`[Campaign Attachment] Follow-up sent with ${attachments.length} attachment(s) → ${emailLog.email || email}`);
  }

  // Mark the follow-up email_log delivered — this is what makes the follow-up
  // campaign's OWN analytics (delivered/open rate) correct.
  await updateEmailLog(emailLog.id, { status: 'sent', sent_at: new Date().toISOString() });

  return emailLog;
}

// ─── Action handlers ───────────────────────────────────────────────────────
async function handleSendSelected(payload: any): Promise<any[]> {
  const campaignId = payload.campaign_id ? String(payload.campaign_id) : '';
  if (!campaignId) throw new Error('campaign_id is required');

  const isAll = String(campaignId) === 'all';
  const contactIds = Array.isArray(payload.contact_ids)
    ? payload.contact_ids.map((id: unknown) => String(id))
    : [];
  if (contactIds.length === 0) {
    throw new Error('Select at least one opened contact');
  }

  const followupCampaignId = payload.followup_campaign_id
    ? String(payload.followup_campaign_id)
    : '';
  if (!followupCampaignId) throw new Error('Follow-up campaign is required');
  if (!isAll && followupCampaignId === campaignId) {
    throw new Error('A campaign cannot be its own follow-up campaign');
  }

  // A scheduled follow-up is delivered by the campaign scheduler at its
  // scheduled times — it cannot be sent on-demand via the manual panel.
  if (await isScheduledFollowup(followupCampaignId)) {
    throw new Error('This follow-up is scheduled — it will be sent automatically at its scheduled time');
  }

  const openedByContact = await getOpenedByContact(campaignId, isAll, contactIds);

  let contacts: any[] = [];
  try {
    contacts = await fetchContacts();
  } catch (error) {
    log(`Could not resolve contact names: ${(error as Error).message}`);
  }
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  // Load + download the follow-up campaign's attachments once so every
  // recipient gets the same files without re-reading Storage per email. A file
  // that cannot be downloaded aborts the send with a clear error — never
  // silently send a follow-up without its attachment.
  const mimeAttachments: MimeAttachment[] = await loadAndDownloadAttachments(followupCampaignId);

  const results: Array<{ contact_id: string; name: string; email: string; status: string; reason?: string }> = [];
  let sentCount = 0;

  for (const contactId of contactIds) {
    const openedLog = openedByContact.get(String(contactId));
    const contact = contactById.get(String(contactId)) || {};
    const email = (openedLog && openedLog.email) || contact.email || '';
    const name = contact.full_name || contact.name || '';

    if (!openedLog || (isAll && !openedLog.campaign_id)) {
      results.push({ contact_id: contactId, name, email, status: 'skipped', reason: 'not_opened' });
      continue;
    }

    // For "all", the log row is anchored to the campaign where the contact
    // actually opened, preserving the (campaign_id, contact_id, follow-up) key.
    const logCampaignId = isAll ? String(openedLog.campaign_id) : campaignId;

    const existing = await getFollowupLog(logCampaignId, contactId, followupCampaignId);
    if (existing && ['sent', 'already_sent'].includes(existing.status)) {
      results.push({ contact_id: contactId, name, email, status: 'skipped', reason: 'already_sent' });
      continue;
    }

    try {
      const createdLog = await sendFollowupEmail(followupCampaignId, contactId, email, mimeAttachments);
      const sentAt = new Date().toISOString();
      let logRow = existing;
      if (!logRow) {
        logRow = await insertFollowupLog({
          campaignId: logCampaignId,
          contactId,
          email: createdLog.email || email,
          followupCampaignId,
          openedAt: openedLog.opened_at || null,
        });
      }
      if (logRow && logRow.id) {
        await updateFollowupLog(logRow.id, { status: 'sent', sent_at: sentAt });
      } else {
        const refetched = await getFollowupLog(logCampaignId, contactId, followupCampaignId);
        if (refetched && refetched.id) {
          await updateFollowupLog(refetched.id, { status: 'sent', sent_at: sentAt });
        }
      }
      await recordFollowupHistory({
        campaignId: logCampaignId,
        contactId,
        followupCampaignId,
        followupMode: 'manual',
        status: 'sent',
        openedAt: openedLog.opened_at || null,
        sentAt,
      });
      sentCount++;
      results.push({ contact_id: contactId, name, email: createdLog.email || email, status: 'sent' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logErr(`Follow-up send FAILED for ${email}: ${message}`);
      results.push({ contact_id: contactId, name, email, status: 'failed', reason: message });
    }
  }

  if (sentCount > 0) {
    await finalizeFollowupCampaign(followupCampaignId);
  }

  return results;
}

async function handleSendPending(pendingId: string): Promise<{ id: string; status: string }> {
  const { data: pending, error } = await supabase
    .from('campaign_followup_logs')
    .select('*')
    .eq('id', pendingId)
    .maybeSingle();
  if (error) throw new Error(`Failed to fetch follow-up record: ${error.message}`);
  if (!pending) throw new Error('Follow-up record not found');
  if (pending.status === 'sent' || pending.status === 'already_sent') {
    throw new Error('This follow-up has already been sent');
  }

  // A scheduled follow-up is delivered by the campaign scheduler — a queued
  // pending row cannot be force-sent on-demand.
  if (await isScheduledFollowup(String(pending.followup_campaign_id))) {
    throw new Error('This follow-up is scheduled — it will be sent automatically at its scheduled time');
  }

  // Re-verify the recipient genuinely opened the original campaign before
  // sending. A follow-up must NEVER go to a non-opener — even via a queued row.
  const { data: openedCheck, error: openedCheckError } = await supabase
    .from('email_logs')
    .select('contact_id')
    .eq('campaign_id', pending.campaign_id)
    .eq('contact_id', pending.contact_id)
    .eq('opened', true)
    .limit(1);
  if (openedCheckError) {
    throw new Error(`Failed to verify the recipient opened the original campaign: ${openedCheckError.message}`);
  }
  if (!openedCheck || openedCheck.length === 0) {
    throw new Error('Recipient did not open the original campaign — follow-up not sent');
  }

  // Load the follow-up campaign's attachments once and send them with this
  // follow-up. A file that cannot be downloaded fails this send with a clear
  // error — never silently send a follow-up without its attachment.
  const mimeAttachments: MimeAttachment[] = await loadAndDownloadAttachments(pending.followup_campaign_id);

  try {
    await sendFollowupEmail(pending.followup_campaign_id, pending.contact_id, pending.email, mimeAttachments);
    const sentAt = new Date().toISOString();
    await updateFollowupLog(pending.id, { status: 'sent', sent_at: sentAt });
    await recordFollowupHistory({
      campaignId: pending.campaign_id,
      contactId: pending.contact_id,
      followupCampaignId: pending.followup_campaign_id,
      followupMode: 'manual',
      status: 'sent',
      openedAt: pending.opened_at || null,
      sentAt,
    });
    await finalizeFollowupCampaign(pending.followup_campaign_id);
    return { id: pending.id, status: 'sent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await updateFollowupLog(pending.id, { status: 'failed', error_message: message });
    } catch (innerError) {
      logErr(`Could not mark pending follow-up failed: ${(innerError as Error).message}`);
    }
    throw error;
  }
}

// ─── Pending-row reconciliation (manual mode) ──────────────────────────────
// A manual-mode pending entry (campaign_followup_logs status='pending') used to
// be created by the Node backend when a contact opened the original campaign.
// In the cloud-only world the campaign-tracker Edge Function (unchanged) marks
// email_logs opened=true, and this reconciliation turns those opens into
// pending follow-up rows. Idempotent: the UNIQUE constraint on
// (campaign_id, contact_id, followup_campaign_id) plus the status gate means a
// contact is never queued twice. Runs before the Pending Follow-ups list loads.
async function handleSyncPending(): Promise<{ created: number; total_configs: number }> {
  const { data: configs, error } = await supabase
    .from('campaign_followups')
    .select('*')
    .eq('is_active', true);
  if (error) throw new Error(`Failed to fetch follow-up configs: ${error.message}`);

  let created = 0;

  for (const config of configs || []) {
    if (!config.campaign_id || !config.followup_campaign_id) continue;
    const originalCampaignId = String(config.campaign_id);
    const followupCampaignId = String(config.followup_campaign_id);

    // Scheduled follow-ups are delivered by the campaign scheduler at their
    // scheduled times — do not queue them as on-open pending rows here.
    if (await isScheduledFollowup(followupCampaignId)) continue;

    const { data: openedLogs, error: openedError } = await supabase
      .from('email_logs')
      .select('contact_id, email, opened_at')
      .eq('campaign_id', originalCampaignId)
      .eq('opened', true);
    if (openedError) {
      logErr(`sync_pending: could not read openers for ${originalCampaignId}: ${openedError.message}`);
      continue;
    }

    for (const openedLog of openedLogs || []) {
      const contactId = String(openedLog.contact_id || '');
      if (!contactId) continue;
      try {
        const existing = await getFollowupLog(originalCampaignId, contactId, followupCampaignId);
        if (existing && ['sent', 'already_sent', 'pending'].includes(existing.status)) continue;
        const logRow = await insertFollowupLog({
          campaignId: originalCampaignId,
          contactId,
          email: openedLog.email || '',
          followupCampaignId,
          openedAt: openedLog.opened_at || null,
        });
        if (logRow) created += 1;
      } catch (error) {
        // Per-opener failures are non-fatal — a bad row must not block the rest.
        logErr(`sync_pending: failed for ${contactId}: ${(error as Error).message}`);
      }
    }
  }

  return { created, total_configs: (configs || []).length };
}

// ─── Main entry ────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
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

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return respond(400, { success: false, error: 'Invalid JSON body' });
  }

  const action = payload && payload.action;
  try {
    if (action === 'send_selected') {
      const results = await handleSendSelected(payload);
      return respond(200, { success: true, data: results });
    }
    if (action === 'send_pending') {
      const pendingId = payload.pending_id ? String(payload.pending_id) : '';
      if (!pendingId) throw new Error('pending_id is required');
      const data = await handleSendPending(pendingId);
      return respond(200, { success: true, data });
    }
    if (action === 'sync_pending') {
      const data = await handleSyncPending();
      return respond(200, { success: true, data });
    }
    throw new Error(`Unknown action: ${String(action || '')}`);
  } catch (error) {
    logErr(`Send follow-up failed: ${(error as Error).message}`);
    return respond(400, { success: false, error: (error as Error).message });
  }
});
