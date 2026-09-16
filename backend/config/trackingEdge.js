/**
 * EDGE open-tracking configuration (test-only).
 *
 * TRACKING_MODE selects which open-tracking implementation emails carry:
 *   - "legacy" (default): existing Express tracking ONLY — behaviour is
 *     identical to before this file existed.
 *   - "edge": the backend ALSO appends the Supabase Edge Function pixel
 *     (supabase/functions/campaign-tracker) to every email, so both methods
 *     run side by side for comparison.
 *
 * Legacy tracking (trackingService.js, trackingRoutes.js, emailWorker.js,
 * emailLogService.js) is never removed or altered — edge mode is purely
 * additive.
 */
const MODE = (process.env.TRACKING_MODE || 'legacy').trim().toLowerCase();

export const isLegacy = MODE !== 'edge';
export const isEdge = MODE === 'edge';

const configuredBaseUrl = (process.env.R_SUPABASE_EDGE_FUNCTION_URL || '').trim().replace(/\/+$/, '');
const derivedBaseUrl = `${(process.env.R_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1`;

export const edgeFunctionBaseUrl = configuredBaseUrl || derivedBaseUrl;

if (isEdge && !edgeFunctionBaseUrl) {
  console.warn('═══════════════════════════════════════════════════════════════════');
  console.warn('  ⚠ TRACKING_MODE=edge but SUPABASE_EDGE_FUNCTION_URL is not set');
  console.warn('  The edge tracking pixel in sent emails will be broken.');
  console.warn('  Set SUPABASE_EDGE_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1');
  console.warn('═══════════════════════════════════════════════════════════════════');
} else {
  console.log(`[TrackingEdge] Mode: ${isEdge ? 'edge' : 'legacy'}`);
  if (isEdge) console.log(`[TrackingEdge] Edge function base URL: ${edgeFunctionBaseUrl}`);
}

/**
 * Build the edge tracking pixel URL for one recipient.
 *
 * The pixel carries this email_log's unique `tracking_id` (when available) so
 * the Edge Function can mark EXACTLY that one log row opened — never every row
 * for a (campaign, email) pair. Falls back to campaign_id + contact_email only
 * for logs created before tracking columns existed.
 *
 * @param {string} campaignId
 * @param {string} contactEmail
 * @param {string|null} trackingId - Unique UUID of this recipient's email_log.
 * @returns {string}
 */
export function buildEdgePixelUrl(campaignId, contactEmail, trackingId = null) {
  const params = new URLSearchParams({
    action: 'track',
    campaign_id: campaignId,
    contact_email: contactEmail,
  });
  if (trackingId) params.set('tracking_id', String(trackingId));
  return `${edgeFunctionBaseUrl}/campaign-tracker?${params.toString()}`;
}

/**
 * Append the edge tracking pixel to email HTML (before </body>, else appended).
 *
 * A normal 1x1 pixel with display:block — NOT display:none / opacity:0, so spam
 * filters and image loaders are less likely to strip or skip it.
 *
 * @param {string} html
 * @param {string} campaignId
 * @param {string} contactEmail
 * @param {string|null} trackingId - Unique UUID of this recipient's email_log.
 * @returns {{ html: string, pixelUrl: string }}
 */
export function appendEdgeTrackingPixel(html, campaignId, contactEmail, trackingId = null) {
  const pixelUrl = buildEdgePixelUrl(campaignId, contactEmail, trackingId);
  const pixel =
    `<img src="${pixelUrl}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;
  const result = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${pixel}</body>`)
    : `${html}${pixel}`;
  return { html: result, pixelUrl };
}

export default {
  mode: MODE,
  isLegacy,
  isEdge,
  edgeFunctionBaseUrl,
  buildEdgePixelUrl,
  appendEdgeTrackingPixel,
};
