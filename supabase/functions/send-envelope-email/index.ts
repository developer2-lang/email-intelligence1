// supabase/functions/send-envelope-email/index.ts
// -----------------------------------------------------------------------------
// Server-side email dispatch for IUOVA SIGN.
//
// The React browser NEVER touches SMTP credentials. It only calls this function
// with an `envelopeId`. This function (running on the Supabase platform with the
// SERVICE ROLE key) reads the envelope + signer from the database, builds a
// clean HTML email containing a one-click signing link, sends it over SMTP, and
// only then marks the envelope as `sent`.
//
// Required secrets (set with `supabase secrets set`):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, APP_URL
//   ALLOWED_ORIGINS   (comma separated; e.g. http://localhost:5174,https://app.iuovasign.com)
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the runtime)
// -----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
/**
 * Production-safe CORS.
 *
 * Reads ALLOWED_ORIGINS (comma separated). If the request's `Origin` is in
 * that list the response reflects it exactly; otherwise it falls back to the
 * first allowed origin (so unknown origins are still rejected by the browser
 * rather than being opened up with `*`).
 *
 * Defaults to http://localhost:5174 so local development works out of the box.
 * Example production value:
 *   ALLOWED_ORIGINS=http://localhost:5174,https://app.iuovasign.com
 */ function corsHeadersFor(req) {
  // Always allow common local dev origins, plus any production origins
  // supplied via ALLOWED_ORIGINS (comma separated).
  const envOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o)=>o.trim()).filter(Boolean);
  const allowed = [
    'http://localhost:5174',
    'http://localhost:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5173',
    ...envOrigins
  ];
  const origin = req.headers.get('origin') ?? '';
  const allowOrigin = allowed.includes(origin) ? origin : envOrigins[0] ?? 'http://localhost:5174';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}
function smtpConfig() {
  const host = Deno.env.get('SMTP_HOST');
  const port = Number(Deno.env.get('SMTP_PORT') ?? '465');
  const user = Deno.env.get('SMTP_USER');
  const pass = Deno.env.get('SMTP_PASSWORD');
  const from = Deno.env.get('SMTP_FROM');
  if (!host || !user || !pass || !from) {
    throw new Error('Missing SMTP configuration. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM.');
  }
  return {
    host,
    port,
    user,
    pass,
    from
  };
}
function b64(s) {
  // UTF-8 safe base64 for SMTP AUTH LOGIN
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b)=>bin += String.fromCharCode(b));
  return btoa(bin);
}
/** Minimal, correct SMTP client over implicit TLS (port 465). */ async function sendSmtpMail(cfg, to, subject, html, text) {
  const conn = await Deno.connectTls({
    hostname: cfg.host,
    port: cfg.port
  });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const buf = new Uint8Array(8192);
  const readResponse = async ()=>{
    let full = '';
    for(;;){
      const n = await conn.read(buf);
      if (n === null) break;
      full += dec.decode(buf.subarray(0, n));
      const lines = full.split('\r\n');
      const consider = full.endsWith('\r\n') ? lines : lines.slice(0, -1);
      if (consider.some((l)=>/^\d{3} /.test(l))) break;
    }
    if (!/^\d{3} /.test(full.trim().split('\r\n').pop() ?? '')) {
      throw new Error('SMTP handshake failed: ' + full.trim());
    }
    return full;
  };
  const send = async (cmd, expect)=>{
    await conn.write(enc.encode(cmd + '\r\n'));
    const res = await readResponse();
    if (expect && !res.startsWith(expect)) {
      throw new Error(`SMTP expected ${expect} but got: ${res.trim()}`);
    }
    return res;
  };
  try {
    await readResponse(); // greeting
    await send('EHLO iuova-sign', '250');
    await send('AUTH LOGIN', '334');
    await send(b64(cfg.user), '334');
    await send(b64(cfg.pass), '235');
    await send(`MAIL FROM:<${cfg.from}>`, '250');
    await send(`RCPT TO:<${to}>`, '250');
    await send('DATA', '354');
    const date = new Date().toUTCString();
    const msgId = `<${crypto.randomUUID()}@iuova-sign>`;
    const headers = [
      `Date: ${date}`,
      `Message-ID: ${msgId}`,
      `From: IUOVA SIGN <${cfg.from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      ''
    ].join('\r\n');
    const body = headers + html + '\r\n.\r\n';
    await conn.write(enc.encode(body));
    await readResponse();
    await send('QUIT', '221');
  } finally{
    try {
      conn.close();
    } catch  {
    /* ignore */ }
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function buildEmail(p) {
  const subject = 'Action Required: Please Sign Your Document';
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b2330;">
    <div style="max-width:560px;margin:0 auto;padding:28px 20px;">
      <div style="background:#ffffff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden;">
        <div style="background:#0b3fb8;color:#fff;padding:20px 24px;">
          <div style="font-weight:700;font-size:18px;letter-spacing:.04em;">IUOVA SIGN</div>
          <div style="font-size:12px;opacity:.85;">Digital Execution Desk</div>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 14px;font-size:15px;">Hello ${escapeHtml(p.name)},</p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:#3a4250;">Your document is ready for your signature.</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.5;">
            <strong>Document:</strong> ${escapeHtml(p.documentName)}
          </p>
          <div style="text-align:center;margin:22px 0;">
            <a href="${p.signingUrl}"
               style="display:inline-block;background:#0b3fb8;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 26px;border-radius:8px;">
              Open &amp; Sign
            </a>
          </div>
          <div style="background:#f4f6fb;border:1px dashed #c7cede;border-radius:8px;padding:14px 16px;margin:18px 0;text-align:center;">
            <div style="font-size:12px;color:#5a6678;margin-bottom:6px;">Your access code</div>
            <div style="font-size:20px;font-weight:700;letter-spacing:.18em;color:#0b3fb8;">${escapeHtml(p.accessCode)}</div>
          </div>
          <p style="margin:0;font-size:12px;color:#7a8597;">
            This link is unique to you. If the button does not work, copy the access code above and open the
            signer portal in IUOVA SIGN.
          </p>
        </div>
        <div style="background:#f4f5f7;padding:16px 24px;font-size:11px;color:#8a93a3;border-top:1px solid #e6e8ee;">
          Regards,<br/>IUOVA SIGN · Digital Execution Desk
        </div>
      </div>
    </div>
  </body>
</html>`;
  const text = `Hello ${p.name},\n\n` + `Your document is ready for your signature.\n\n` + `Document: ${p.documentName}\n\n` + `Please click the link below to open and sign the document:\n${p.signingUrl}\n\n` + `Your access code: ${p.accessCode}\n\n` + `Regards,\nIUOVA SIGN\nDigital Execution Desk`;
  return {
    subject,
    html,
    text
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeadersFor(req)
    });
  }
  try {
    const body = await req.json().catch(()=>({}));
    const envelopeId = body?.envelopeId;
    if (!envelopeId) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'envelopeId is required'
      }), {
        status: 400,
        headers: {
          ...corsHeadersFor(req),
          'Content-Type': 'application/json'
        }
      });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: env, error: envErr } = await supabase.from('envelopes').select('id, title, template_name, signer_name, signer_email, signing_token, access_code, status').eq('id', envelopeId).maybeSingle();
    if (envErr || !env) {
      return new Response(JSON.stringify({
        ok: false,
        error: 'envelope not found'
      }), {
        status: 404,
        headers: {
          ...corsHeadersFor(req),
          'Content-Type': 'application/json'
        }
      });
    }
    const appUrl = (Deno.env.get('APP_URL') ?? '').replace(/\/$/, '');
    const signingUrl = `${appUrl}/sign/${env.signing_token}`;
    const mail = buildEmail({
      name: env.signer_name ?? 'Signer',
      documentName: env.title ?? env.template_name ?? 'Document',
      signingUrl,
      accessCode: env.access_code ?? ''
    });
    await sendSmtpMail(smtpConfig(), env.signer_email, mail.subject, mail.html, mail.text);
    // Only mark as sent AFTER the email actually went out.
    const { error: updErr } = await supabase.rpc('mark_envelope_sent', {
      p_id: env.id
    });
    if (updErr) {
      console.error('mark_envelope_sent failed', updErr);
      return new Response(JSON.stringify({
        ok: false,
        error: 'email sent but status update failed'
      }), {
        status: 500,
        headers: {
          ...corsHeadersFor(req),
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      envelopeId: env.id
    }), {
      headers: {
        ...corsHeadersFor(req),
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('send-envelope-email error', message);
    return new Response(JSON.stringify({
      ok: false,
      error: message
    }), {
      status: 500,
      headers: {
        ...corsHeadersFor(req),
        'Content-Type': 'application/json'
      }
    });
  }
});
