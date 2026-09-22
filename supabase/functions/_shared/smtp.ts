/**
 * Shared Gmail-SMTP sender for Supabase Edge Functions.
 *
 * A minimal, self-contained SMTP client (Deno.connectTls → implicit TLS on
 * port 465 — the ONLY outbound SMTP port Edge Functions allow). Extracted from
 * send-campaign so every function that emails a recipient shares one codebase
 * and one secret set. Accepts either the `R_EMAIL_*` secrets (used by
 * send-campaign / scheduled-campaign-runner) or the `SMTP_*` secrets
 * documented by scheduled-campaign-setup.sql, with R_* taking precedence.
 *
 * Sends a simple multipart/alternative (text + HTML) message. No attachments.
 * Credentials come from runtime env only — never hard-coded, never logged.
 */

export interface SmtpEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SmtpSendResult {
  messageId: string;
}

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
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** RFC 2047 encoded-word for non-ASCII headers (Subject / display name). */
function encodeHeader(value: string): string {
  if (!/[\u0080-\uFFFF]/.test(value)) return value;
  return `=?UTF-8?B?${b64EncodeUtf8(value)}?=`;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
  from: string;
  replyTo: string;
}

function loadSmtpConfig(): SmtpConfig {
  const user = (Deno.env.get('R_EMAIL_USER') || Deno.env.get('SMTP_USER') || '').trim();
  const fromRaw = (Deno.env.get('R_EMAIL_FROM') || Deno.env.get('SMTP_FROM') || '').trim();
  return {
    host: (Deno.env.get('R_EMAIL_HOST') || Deno.env.get('SMTP_HOST') || 'smtp.gmail.com').trim(),
    port: Math.max(1, parseInt(Deno.env.get('R_EMAIL_PORT') || Deno.env.get('SMTP_PORT') || '465', 10) || 465),
    user,
    password: Deno.env.get('R_EMAIL_PASSWORD') || Deno.env.get('SMTP_PASSWORD') || '',
    fromName: (Deno.env.get('R_EMAIL_FROM_NAME') || Deno.env.get('SMTP_FROM_NAME') || '').trim(),
    from: fromRaw || user,
    replyTo: (Deno.env.get('R_EMAIL_REPLY_TO') || Deno.env.get('SMTP_REPLY_TO') || '').trim() || fromRaw || user,
  };
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
    try {
      await this.cmd('QUIT');
    } catch {
      /* ignore */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      this.conn.close();
    } catch {
      /* ignore */
    }
  }
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
}): string[] {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  lines.push(`Reply-To: ${encodeHeader(opts.replyTo)}`);
  lines.push(`Message-ID: ${opts.messageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`List-Unsubscribe: ${opts.listUnsubscribe}`);

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

export async function sendSmtpEmail(opts: SmtpEmailOptions): Promise<SmtpSendResult> {
  const config = loadSmtpConfig();
  if (!config.user || !config.password) {
    throw new Error('SMTP_USER / SMTP_PASSWORD secrets are not configured (set R_EMAIL_* or SMTP_*)');
  }
  if (config.port !== 465) {
    throw new Error('Supabase Edge Functions only allow outbound SMTP on port 465 (implicit TLS)');
  }

  const fromName = config.fromName ? `${encodeHeader(config.fromName)} ` : '';
  const from = fromName ? `${fromName}<${config.from}>` : config.from;
  const messageId = `<${crypto.randomUUID()}@gmail.com>`;
  const listUnsubscribe = `mailto:${config.from}?subject=Unsubscribe`;

  const session = new SmtpSession(30000);
  try {
    await session.connect(config.host, config.port);
    await session.ehlo('supabase.co');
    await session.authPlain(config.user, config.password);
    await session.mailFrom(config.from);
    await session.rcptTo(opts.to);
    const lines = buildMimeMessage({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: config.replyTo,
      listUnsubscribe,
      messageId,
    });
    await session.data(lines);
    await session.quit();
    return { messageId };
  } catch (error) {
    try {
      session.quit();
    } catch {
      /* ignore */
    }
    throw error;
  }
}