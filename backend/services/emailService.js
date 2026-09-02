/**
 * Nodemailer email service.
 *
 * Provides sendEmail() for single messages and sendBulkEmail() for a list
 * of recipients. A shared transporter is created lazily on first use.
 */
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import emailConfig from '../config/email.js';
import trackingConfig from '../config/tracking.js';
import { stripHtml, wrapHtmlDocument, toEmailSafeHtml } from '../utils/emailTemplate.js';

let _transporter = null;

/**
 * Builds a unique Message-ID whose domain matches the From address, e.g.
 * <3f7a…@gmail.com>. A per-message random UUID guarantees uniqueness.
 *
 * @returns {string}
 */
function buildMessageId() {
  const source = String(emailConfig.from || '');
  const match =
    source.match(/<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/) ||
    source.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  const address = match ? match[1] : '';
  const domain = (address.split('@')[1] || 'localhost').toLowerCase();
  return `<${randomUUID()}@${domain}>`;
}

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: emailConfig.auth,
    });
  }
  return _transporter;
}

/**
 * Verify that the SMTP connection is reachable.
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function verifyConnection() {
  try {
    await getTransporter().verify();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Send a single email.
 *
 * @param {object} options
 * @param {string} options.to      - Recipient email address.
 * @param {string} options.subject - Email subject line.
 * @param {string} options.html    - HTML body.
 * @param {string} [options.text]  - Optional plain-text body (auto-generated if omitted).
 * @param {Array}  [options.attachments] - Optional nodemailer attachment list
 *   ([{ filename, content }]) embedded in the outgoing message. Defaults to none,
 *   so existing callers keep the exact current message structure.
 * @returns {Promise<{success: boolean, messageId: string, response: string}>}
 */
function rewriteHtmlForTracking(html, { campaignId, recipientId, baseUrl = trackingConfig.baseUrl } = {}) {
  if (!html || typeof html !== 'string') return html;

  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalizedBaseUrl) return html;

  let rewritten = html.replace(
    /(<a\b[^>]*\bhref\s*=\s*)(["']?)(https?:\/\/[^"'\s>]+)(["']?)/gi,
    (match, prefix, quote, url) => {
      if (url.includes('/api/tracking/click/')) {
        return match;
      }

      const encoded = encodeURIComponent(url);
      const trackingPath = campaignId && recipientId
        ? `${normalizedBaseUrl}/api/tracking/click/${campaignId}/${recipientId}?url=${encoded}`
        : `${normalizedBaseUrl}/api/tracking/click/${campaignId || recipientId || 'unknown'}?url=${encoded}`;

      const closingQuote = quote || '';
      return `${prefix}${quote}${trackingPath}${closingQuote}`;
    }
  );

  rewritten = rewritten.replace(
    /(^|[^"'=])\b(https?:\/\/[^\s<>"']+)\b/gi,
    (match, prefix, url) => {
      if (url.includes('/api/tracking/click/')) return match;
      const encoded = encodeURIComponent(url);
      const trackingPath = campaignId && recipientId
        ? `${normalizedBaseUrl}/api/tracking/click/${campaignId}/${recipientId}?url=${encoded}`
        : `${normalizedBaseUrl}/api/tracking/click/${campaignId || recipientId || 'unknown'}?url=${encoded}`;
      return `${prefix}<a href="${trackingPath}">${url}</a>`;
    }
  );

  return rewritten;
}

/**
 * Guarantee exactly one open-tracking pixel in the FINAL email HTML, bound to
 * THIS recipient's email_log tracking_id.
 *
 * The pixel is injected into the final, already-wrapped document (which always
 * contains exactly one <body>) so it survives every template structure —
 * custom HTML, plain-text, image-heavy, full-document, or a bare fragment.
 * Injecting it before the safe-html/wrap transform used to leave the pixel
 * inside a NESTED <body> for templates that already contained a <body> tag but
 * no <!DOCTYPE>/<html>/<head>, which mail clients strip — so those templates
 * silently lost their open pixel.
 *
 * Any open pixel already present (added upstream by buildTrackedHtml, or
 * leftover from a reused draft) is stripped first so we never emit a duplicate
 * or a pixel bound to the wrong email_log / recipient. The click-tracking
 * links are left completely untouched.
 *
 * @param {string} html - Final HTML document (already wrapped, single <body>).
 * @param {object} [opts]
 * @param {string} [opts.trackingId] - Unique UUID of this recipient's email_log.
 * @param {string} [opts.baseUrl] - Public origin of the backend.
 * @returns {string}
 */
function appendTrackingPixel(html, { trackingId, baseUrl = trackingConfig.baseUrl } = {}) {
  if (!html || typeof html !== 'string') return html;

  // Strip any existing open-tracking pixel so there is never a duplicate or a
  // pixel pointing at another log/recipient.
  let clean = html.replace(
    /<img[^>]*\bsrc\s*=\s*["']?[^"'\s>]*\/api\/tracking\/open\/[^"'\s>]*["']?[^>]*>/gi,
    ''
  );

  if (!trackingId) return clean;

  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  if (!normalizedBaseUrl) return clean;

  const pixelUrl = `${normalizedBaseUrl}/api/tracking/open/${trackingId}`;
  console.log('[EmailService] open pixel URL:', pixelUrl);

  // A normal 1x1 pixel with display:block — NOT display:none / opacity:0. Hidden
  // or zero-opacity images are more likely to be stripped by spam filters or
  // skipped by image loaders, which is exactly the Inbox-vs-Spam difference we
  // want to remove from our side.
  const pixel =
    `<img src="${pixelUrl}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;

  if (/<\/body>/i.test(clean)) {
    return clean.replace(/<\/body>/i, `${pixel}\n</body>`);
  }

  return `${clean}\n${pixel}`;
}

/**
 * Build the final email HTML that is actually handed to SMTP.
 *
 * This is the SINGLE place where the open-tracking pixel is injected. The order
 * is deliberate and load-bearing:
 *
 *   1. rewrite click links (only when the caller hasn't already done so)
 *   2. toEmailSafeHtml()  — normalise camelCase CSS, scaffold, etc.
 *   3. wrapHtmlDocument() — produce EXACTLY ONE <body> (completing a body-only
 *                          fragment, wrapping a bare fragment, or passing a full
 *                          document through untouched)
 *   4. appendTrackingPixel() — inject the 1x1 pixel into that single <body>,
 *                          bound to THIS recipient's email_log.tracking_id.
 *
 * Injecting the pixel AFTER the wrap step is what guarantees it survives every
 * mail client: any earlier injection would land the pixel inside a <body> that
 * toEmailSafeHtml/wrapHtmlDocument then nests or rebuilds, and mail clients
 * strip the inner <body>'s content — so the pixel would silently never fire.
 *
 * @param {object} opts
 * @param {string} opts.html
 * @param {string} [opts.campaignId]
 * @param {string} [opts.recipientId]
 * @param {string} [opts.trackingId] - This recipient's email_log.tracking_id.
 * @param {string} [opts.baseUrl] - Public origin (defaults to trackingConfig.baseUrl).
 * @returns {string} Final HTML document that will be sent.
 */
function renderTrackedEmailHtml({ html, campaignId, recipientId, trackingId, baseUrl = trackingConfig.baseUrl } = {}) {
  const inputHtml = String(html || '');
  const hasClickLinks = /\/api\/tracking\/click\//i.test(inputHtml);

  const rewrittenHtml = hasClickLinks
    ? inputHtml
    : rewriteHtmlForTracking(inputHtml, { campaignId, recipientId });

  // Normalize the body into a single, standards-compliant HTML document with
  // exactly one <body>. The open-tracking pixel is injected AFTER this step (see
  // appendTrackingPixel below) so it always lands inside that single <body>,
  // regardless of how the source template was authored (custom HTML, plain-text,
  // image-heavy, full-document, or fragment). Click-tracking links (already in
  // the body) are preserved untouched.
  const docHtml = wrapHtmlDocument(toEmailSafeHtml(rewrittenHtml));

  // Guarantee exactly one open-tracking pixel pointing at THIS email_log's
  // tracking_id in the final HTML that is actually sent via SMTP. Any pixel
  // already present (added upstream by buildTrackedHtml, or a stale draft) is
  // stripped first so we never emit a duplicate or a pixel bound to the wrong
  // log/recipient.
  const finalHtml = appendTrackingPixel(docHtml, { trackingId, baseUrl });

  return finalHtml;
}

async function sendEmail({ to, subject, html, text, campaignId, recipientId, trackingId, attachments }) {
  const inputHtml = String(html || '');
  const hasClickLinks = /\/api\/tracking\/click\//i.test(inputHtml);

  console.log('[EmailService] hasClickLinks:', hasClickLinks);

  // Centralised pixel injection. See renderTrackedEmailHtml for the ordering
  // rationale (pixel must land AFTER the document wrap, inside the one <body>).
  const finalHtml = renderTrackedEmailHtml({
    html: inputHtml,
    campaignId,
    recipientId,
    trackingId,
    baseUrl: trackingConfig.baseUrl,
  });

  console.log('[EmailService] hasOpenPixel:', finalHtml.includes('/api/tracking/open/'));
  // Always include a plain-text part so the MIME structure is a proper
  // multipart/alternative (text/plain + text/html) — required by major
  // providers for good deliverability.
  const textPart = text && String(text).trim() ? String(text) : stripHtml(finalHtml);

  const info = await getTransporter().sendMail({
    from: emailConfig.from,
    to,
    replyTo: emailConfig.replyTo || undefined,
    subject,
    html: finalHtml,
    text: textPart,
    messageId: buildMessageId(),
    list: emailConfig.listUnsubscribe ? { unsubscribe: emailConfig.listUnsubscribe } : undefined,
    attachments,
  });
  return { success: true, messageId: info.messageId, response: info.response };
}

/**
 * Send the same email to multiple recipients individually.
 *
 * Each address receives its own message so recipients cannot see each other.
 * Failures are collected — one bad address does not abort the rest.
 *
 * @param {object} options
 * @param {string[]} options.recipients - Array of email addresses.
 * @param {string}   options.subject    - Email subject line.
 * @param {string}   options.html       - HTML body.
 * @param {string}   [options.text]     - Optional plain-text body.
 * @returns {Promise<Array<{email: string, success: boolean, messageId?: string, error?: string}>>}
 */
async function sendBulkEmail({ recipients, subject, html, text }) {
  const results = [];
  for (const email of recipients) {
    try {
      const result = await sendEmail({ to: email, subject, html, text });
      results.push({ email, ...result });
    } catch (error) {
      results.push({ email, success: false, error: error.message });
    }
  }
  return results;
}

export { sendEmail, sendBulkEmail, verifyConnection, getTransporter, rewriteHtmlForTracking, renderTrackedEmailHtml };
