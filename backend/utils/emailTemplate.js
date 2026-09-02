/**
 * Template utilities for email personalization.
 */

/**
 * Replaces {{variable}} placeholders in a template string.
 *
 * @param {string} template - The HTML template containing {{var}} placeholders.
 * @param {object} vars - Key/value pairs to substitute.
 * @returns {string} The personalized template.
 */
function replaceTemplateVars(template, vars) {
  let result = String(template || '');
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
    result = result.replace(pattern, value != null ? String(value) : '');
  }
  return result;
}

/**
 * Escapes HTML special characters to prevent injection.
 *
 * @param {*} text - The value to escape.
 * @returns {string} The escaped string safe for HTML embedding.
 */
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Strips HTML tags to produce a plain-text version.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decodes the standard HTML character references back to their literal
 * characters.
 *
 * Content typed into the composer's contenteditable editor is stored with
 * escaped markup: a text node containing `<h2>Hello!</h2>` is serialized by
 * `innerHTML` as `&lt;h2&gt;Hello!&lt;/h2&gt;`. Sent as-is in the HTML part,
 * Gmail renders those references as literal text (`<h2>`), which is why
 * recipients saw tags instead of formatted output. Decoding the common
 * entities restores the real markup so it renders. `&amp;` is decoded last so
 * an already-escaped literal like `&amp;lt;` becomes `&lt;` and is not
 * re-decoded.
 *
 * @param {string} html
 * @returns {string}
 */
function decodeHtmlEntities(html) {
  return String(html || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Detects whether a string already contains real HTML markup (a tag such as
 * <p>, <strong>, <br>, ...). Used to keep backward compatibility: older
 * rich-text campaigns store HTML and are sent verbatim, while new plain-text
 * bodies (no tags) are converted to HTML before sending.
 *
 * @param {string} str
 * @returns {boolean}
 */
function hasHtmlTags(str) {
  return /<\s*(\/)?\s*[a-zA-Z][^>]*>/.test(String(str || ''));
}

/**
 * Converts plain text (as typed into the plain-text composer) into clean HTML
 * for the email body:
 *  - HTML special characters are escaped, so typed `<`/`>`/`&` never render as
 *    markup.
 *  - Blank lines separate paragraphs (`<p>`).
 *  - Single line breaks inside a paragraph become `<br>`.
 *  - Bullet lines (`- `, `* `, `+ `) and numbered lines (`1. `) become
 *    `<ul>`/`<ol>` lists where possible.
 *
 * Merge-tag placeholders must be replaced BEFORE this runs; the injected
 * recipient values are escaped here as well.
 *
 * @param {string} text - Plain-text email body.
 * @returns {string} Clean HTML email body.
 */
function plainTextToHtml(text) {
  const escaped = escapeHtml(text);

  const lines = escaped.split(/\r?\n/);
  const out = [];
  let openList = null;
  let paragraph = [];

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
      out.push(`<li>${(bullet ? bullet[2] : number[2]).trim()}</li>`);
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  emitParagraph();
  closeList();

  return out.join('\n');
}

/**
 * Rewrites every external http(s) link in the HTML to the click-tracking
 * endpoint so the backend can record clicks and redirect to the destination.
 *
 * @param {string} html - Personalized email HTML.
 * @param {string} trackingId - Unique UUID for this recipient/email_log.
 * @param {string} baseUrl - Public origin of the backend.
 * @returns {string}
 */
function rewriteLinks(html, trackingId, baseUrl, campaignId = null, recipientId = null) {
  return String(html || '').replace(
    /(<a\b[^>]*\bhref\s*=\s*)(["'])(https?:\/\/[^"'\s>]+)(["'])/gi,
    (match, prefix, openQuote, url, closeQuote) => {
      if (url.includes('/api/tracking/click/')) {
        return match;
      }

      const encoded = encodeURIComponent(url);
      const trackingPath = campaignId && recipientId
        ? `${baseUrl}/api/tracking/click/${campaignId}/${recipientId}?url=${encoded}`
        : `${baseUrl}/api/tracking/click/${trackingId}?url=${encoded}`;
      return `${prefix}${openQuote}${trackingPath}${closeQuote}`;
    }
  );
}

/**
 * Appends a hidden 1x1 tracking pixel that fires the open-tracking endpoint.
 *
 * NOTE: no `.png` suffix — the route is /api/tracking/open/:trackingId. Adding
 * `.png` used to make Express capture `trackingId.png` as the param, so the
 * UUID never matched and opens were silently dropped.
 *
 * The pixel is a normal visible 1x1 (display:block), NOT display:none or
 * opacity:0 — hidden/zero-opacity images are more likely to be stripped by
 * spam filters or skipped by image loaders.
 *
 * @param {string} html - Email HTML.
 * @param {string} trackingId - Unique UUID for this recipient/email_log.
 * @param {string} baseUrl - Public origin of the backend.
 * @returns {string}
 */
function appendTrackingPixel(html, trackingId, baseUrl) {
  const pixel =
    `<img src="${baseUrl}/api/tracking/open/${trackingId}" ` +
    `width="1" height="1" border="0" alt="" style="display:block;border:0;width:1px;height:1px;max-width:1px;max-height:1px;" />`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}\n</body>`);
  }
  return `${html}\n${pixel}`;
}

/**
 * Builds the final per-recipient HTML: click-tracked links plus an
 * open-tracking pixel.
 *
 * @param {string} html - Personalized email HTML (merge tags already replaced).
 * @param {string} trackingId - Unique UUID for this recipient/email_log.
 * @param {string} baseUrl - Public origin of the backend.
 * @returns {string}
 */
function buildTrackedHtml(html, trackingId, baseUrl, campaignId = null, recipientId = null) {
  let tracked = rewriteLinks(String(html || ''), trackingId, baseUrl, campaignId, recipientId);
  tracked = appendTrackingPixel(tracked, trackingId, baseUrl);

  console.log(`[Template] buildTrackedHtml — tracking_id: ${trackingId}`);
  console.log(`[Template] buildTrackedHtml — base_url: ${baseUrl}`);
  console.log(`[Template] buildTrackedHtml — open pixel: ${baseUrl}/api/tracking/open/${trackingId}`);
  const clickMatch = tracked.match(/api\/tracking\/click\/[^"?]+/);
  console.log(`[Template] buildTrackedHtml — first click link: ${clickMatch ? clickMatch[0] : '(none present)'}`);

  return tracked;
}

/**
 * Wraps an email body fragment in a full, standards-compliant HTML document so
 * email clients render it consistently. If the fragment is already a complete
 * document (contains <!DOCTYPE>, <html> or <head>), it is returned unchanged.
 *
 * The wrapper uses only benign, mobile-friendly email CSS — no hidden text, no
 * invisible elements, nothing designed to trick filters.
 *
 * @param {string} html - Email body fragment.
 * @returns {string} A full HTML document.
 */
function wrapHtmlDocument(html) {
  const value = String(html || '');
  if (!value.trim()) return value;
  if (/<!doctype\b|<\s*html\b|<\s*head\b/i.test(value)) return value;

  // A document that already contains a <body> (but no outer <html>/<head>) must
  // be COMPLETED into a single, well-formed document — NOT re-wrapped. Re-wrapping
  // nests a second <body>, and mail clients strip the inner <body>'s content,
  // which is exactly where the open-tracking pixel lives. So those templates
  // silently lost their open pixel. Completing keeps exactly one <body>.
  if (/<body\b/i.test(value)) {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<style>img{border:0;max-width:100%;}a{color:#1a73e8;}table{border-collapse:collapse;}</style>',
      '</head>',
      value,
      '</html>',
    ].join('\n');
  }

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

// ─── Email-safe rendering (centered, fixed-width container) ────────────────
// Convert the saved template HTML into Gmail-safe markup before wrapping it in
// a document: a wrapper table (email background) that is centered in the
// message area, containing the centered content container. All template
// content — sections, columns, buttons, social-icon tables (inline-SVG
// anchors), links, styles, merge placeholders — is preserved verbatim; only
// the outer container, <img> rules, camelCase CSS and inline-SVG social icons
// are touched.
//
// Templates that contain an explicit user-created Container (marked with the
// persistent `data-te-role="container"` attribute) are preserved VERBATIM: the
// container→children hierarchy is kept, and content the user deliberately
// placed outside the Container stays outside — nothing is folded or moved.
//
// Legacy templates without an explicit Container still get the old behaviour:
// a full-width wrapper + content card is normalized in place, content pasted
// OUTSIDE the scaffold table is folded back into the SAME centered content
// container (nothing can escape the resolved-width container), and a degenerate
// empty/tiny content card is widened to a usable email width instead of
// rendering as a tiny 100px box. Any other HTML is wrapped in the same safe
// scaffold.

const EMAIL_SAFE_WIDTH = 520;
// A degenerate content card (an EMPTY stub, or a card narrower than a usable
// email column) must be widened before folded content is injected, so the final
// email always has ONE properly-sized white card instead of a tiny 100px box.
const CONTENT_WIDTH_MIN = 480;
const CONTENT_WIDTH_DEFAULT = 600;
const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i;
const SOCIAL_ATTR_RE = /\bdata-te-social\b/i;

function getTagStyle(tag) {
  const m = tag.match(STYLE_ATTR_RE);
  return m ? m[2] : '';
}

function setTagStyle(tag, newStyle) {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  if (styleMatch) {
    const pre = tag.slice(0, styleMatch.index);
    const post = tag.slice(styleMatch.index + styleMatch[0].length);
    return `${pre} style="${newStyle}"${post}`;
  }
  return tag.replace(/\s*>$/, (end) => ` style="${newStyle}"${end}`);
}

function hasStyleRule(style, name) {
  return new RegExp(`(?:^|;)\\s*${name}\\s*:`).test(style);
}

// ─── CSS normalization ─────────────────────────────────────────────────────
// GrapeJS (the Template Editor) emits camelCase properties such as
// `maxWidth:100%`. Gmail only understands kebab-case (`max-width:100%`) and
// silently drops camelCase rules, which is why images overflowed the container.
// Every inline `style` attribute AND every rule inside a <style> block is
// normalized to kebab-case before sending.

const CSS_KEBAB_RE = /([a-z0-9])([A-Z])/g;

function kebabCaseCssProp(prop) {
  return String(prop || '').replace(CSS_KEBAB_RE, '$1-$2').toLowerCase();
}

function normalizeCssDeclaration(css) {
  return String(css || '')
    .split(';')
    .map((part) => {
      const p = part.trim();
      if (!p) return '';
      const colon = p.indexOf(':');
      if (colon < 0) return p;
      const prop = p.slice(0, colon).trim();
      const value = p.slice(colon + 1).trim();
      return `${kebabCaseCssProp(prop)}:${value}`;
    })
    .filter((p) => p !== '')
    .join(';');
}

/**
 * Rewrite camelCase CSS properties to kebab-case everywhere in the HTML:
 * inline `style="..."` attributes and every rule inside `<style>` blocks.
 */
function normalizeCssInHtml(html) {
  let out = String(html || '').replace(
    /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_m, quote, css) => ` style=${quote}${normalizeCssDeclaration(css)}${quote}`
  );
  out = out.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_m, css) => {
      const normalized = css.replace(/(\{)([\s\S]*?)(\})/g, (_r, open, body, close) => `${open}${normalizeCssDeclaration(body)}${close}`);
      return `<style>${normalized}</style>`;
    }
  );
  return out;
}

// ─── Email background extraction ───────────────────────────────────────────
// The template body usually carries a page background (inline on <body> or in
// a <style> rule). That colour is applied to the outer wrapper table so the
// email still shows its authored background once Gmail ignores <body> margins
// and the scaffold adds its own full-width table.

function extractBackgroundColor(bodyAttrs, styleBlock) {
  const colors = [];
  const bodyStyle = (String(bodyAttrs || '').match(/style\s*=\s*["']([\s\S]*?)["']/i) || [])[1] || '';
  const styleColor = (bodyStyle.match(/background-color\s*:\s*([^;]+)/i) || [])[1];
  if (styleColor) colors.push(styleColor.trim());
  const bgShorthand = (bodyStyle.match(/background\s*:\s*([^;]+)/i) || [])[1];
  if (bgShorthand) colors.push(bgShorthand.trim());

  const block = String(styleBlock || '');
  const bodyRule = block.match(/body\s*\{([^}]*)\}/i);
  const htmlRule = block.match(/\bhtml\s*\{([^}]*)\}/i);
  const rule = bodyRule || htmlRule;
  if (rule) {
    const ruleColor = (rule[1].match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1];
    if (ruleColor) colors.push(ruleColor.trim());
  }

  for (const color of colors) {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return color;
  }
  return '';
}

// ─── Social icons (inline SVG → <img>) ─────────────────────────────────────
// Gmail strips inline <svg>. Social blocks keep their full config in the
// `data-te-social` attribute (brand ids, urls, colours, sizes), and each icon
// is an <a> containing an <svg><path fill=".." d=".."/></svg>. The anchor's
// authored styles (background, radius, size) are preserved; only the <svg> is
// swapped for an <img>. cdn.simpleicons.org serves SVG (which Gmail's image
// proxy blocks), so the <img> must reference a PNG: the five standard brands
// (plus website/email) use Icons8's `ios` white-glyph PNGs, and any other
// simple-icons slug falls back to the same glyphs rendered as PNG
// (simple-icons-png on jsDelivr).

function decodeAttrEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseSocialIcons(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && Array.isArray(parsed.icons)) {
      return parsed.icons.map((ic) => ({
        id: String((ic && ic.id) || ''),
        url: String((ic && ic.url) || ''),
        size: Number(ic && ic.size) || 40,
        color: String((ic && ic.color) || '#FFFFFF'),
        bg: String((ic && ic.bg) || ''),
        shape: String((ic && ic.shape) || 'circle'),
        radius: String((ic && ic.radius) || ''),
      }));
    }
  } catch (e) {
    // unparseable config → leave the block untouched
  }
  return null;
}

const ICONS8_ICON_NAMES = {
  instagram: 'instagram-new',
  linkedin: 'linkedin',
  facebook: 'facebook',
  youtube: 'youtube-play',
  x: 'x',
  whatsapp: 'whatsapp',
  telegram: 'telegram-app',
  pinterest: 'pinterest',
  tiktok: 'tiktok',
  snapchat: 'snapchat',
  reddit: 'reddit',
  discord: 'discord',
  github: 'github',
  medium: 'medium',
  threads: 'threads',
  google: 'google',
  website: 'globe',
  email: 'mail',
};

function socialIconImageUrl(brand, fill) {
  const hex = String(fill || '#FFFFFF').replace(/^#/, '') || 'FFFFFF';
  const key = String(brand || 'website').toLowerCase();
  const iconName = ICONS8_ICON_NAMES[key] || 'globe';
  return `https://img.icons8.com/ios/48/${hex}/${iconName}.png`;
}

/**
 * Guess the brand of a social icon from its anchor href. Used only when the
 * block's `data-te-social` config cannot be parsed — which happens when the
 * send pipeline already ran `decodeHtmlEntities()` over the whole body and the
 * double-quoted JSON inside the attribute lost its `&quot;` escaping. The
 * anchor itself (href + svg + fill) is untouched, so the brand is recovered
 * from the URL. Click-tracked links are unwrapped first (the original URL is
 * preserved in the `?url=` parameter).
 */
function socialBrandFromHref(href) {
  let value = String(href || '');
  const urlParam = (value.match(/[?&]url=([^&#]+)/i) || [])[1];
  if (urlParam) {
    try {
      value = decodeURIComponent(urlParam);
    } catch (e) {
      value = urlParam;
    }
  }
  value = value.toLowerCase();
  if (/^mailto:/i.test(value)) return 'email';
  const table = [
    ['instagram.com', 'instagram'],
    ['linkedin.com', 'linkedin'],
    ['facebook.com', 'facebook'],
    ['youtube.com', 'youtube'],
    ['wa.me', 'whatsapp'],
    ['whatsapp.com', 'whatsapp'],
    ['t.me', 'telegram'],
    ['telegram.org', 'telegram'],
    ['pinterest', 'pinterest'],
    ['tiktok.com', 'tiktok'],
    ['snapchat.com', 'snapchat'],
    ['reddit.com', 'reddit'],
    ['discord', 'discord'],
    ['github.com', 'github'],
    ['medium.com', 'medium'],
    ['threads.net', 'threads'],
    ['google.com', 'google'],
    ['x.com', 'x'],
    ['twitter.com', 'x'],
  ];
  for (const [needle, brand] of table) {
    if (value.includes(needle)) return brand;
  }
  return '';
}

function socialAnchorToImg(anchor, item) {
  const openTag = (anchor.match(/<a\b[^>]*>/i) || [])[0];
  if (!openTag) return anchor;
  const href = (openTag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
  const fillMatch = anchor.match(/<path\b[^>]*\bfill\s*=\s*["']([^"']*)["']/i);
  const fill = fillMatch ? fillMatch[1] : String((item && item.color) || '#FFFFFF');
  // When the block config is missing/unparseable (see socialBrandFromHref),
  // derive the brand from the anchor's own URL so the icon still renders.
  const brand = (item && item.id) || socialBrandFromHref(href);
  if (!brand) return anchor;
  const svgTag = (anchor.match(/<svg\b[^>]*>/i) || [])[0] || '';
  const sizeMatch = (svgTag.match(/\b(?:width|height)\s*=\s*["']?(\d+(?:\.\d+)?)["']?/i) || [])[1];
  const size = sizeMatch ? Number(sizeMatch) : 24;
  const svgStyle = getTagStyle(svgTag);
  const marginMatch = svgStyle.match(/margin\s*:\s*([^;]+)/i);
  const margin = marginMatch ? marginMatch[1].trim() : '';
  const style = `display:block;background:transparent;border:0;${margin ? `margin:${margin};` : ''}`;
  const img =
    `<img src="${socialIconImageUrl(brand, fill)}" width="${size}" height="${size}" ` +
    `alt="${brand || 'social'}" style="${style}" />`;
  return anchor.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, img);
}

/**
 * Convert every social block's inline-SVG icons into <img> tags. Blocks are
 * identified by their `data-te-social` attribute; each icon's brand is read
 * from the block's config (icons are rendered in config order, so anchors
 * pair up 1:1 with config.icons). When the config cannot be parsed (the send
 * pipeline's `decodeHtmlEntities()` corrupts the JSON inside the attribute),
 * each icon's brand falls back to its anchor href — so the icons always reach
 * the final email as real <a>+<img> markup that Gmail can render.
 */
function convertSocialSvgToImgs(content) {
  return String(content || '').replace(
    /<table\b[^>]*\bdata-te-social\b[^>]*>([\s\S]*?)<\/table>/gi,
    (whole, inner) => {
      const attrMatch = whole.match(/\bdata-te-social\s*=\s*["']([^"']*)["']/i);
      const raw = attrMatch ? attrMatch[1] : '';
      const icons = raw ? parseSocialIcons(decodeAttrEntities(raw)) : null;
      if (icons && icons.length === 0) return whole;
      let idx = 0;
      const newInner = inner.replace(
        /<a\b[^>]*>[\s\S]*?<svg\b[^>]*>[\s\S]*?<\/svg>[\s\S]*?<\/a>/gi,
        (anchor) => {
          const item = icons ? icons[idx % icons.length] : null;
          idx += 1;
          return socialAnchorToImg(anchor, item);
        }
      );
      return whole.replace(inner, newInner);
    }
  );
}

function constrainEmailImages(content) {
  return String(content || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const style = getTagStyle(tag);
    const adds = [];
    if (!hasStyleRule(style, 'display')) adds.push('display:block');
    if (!hasStyleRule(style, 'max-width')) adds.push('max-width:100%');
    const hasExplicitHeight =
      /\sheight\s*=\s*["']?[^"'\s>]+/i.test(tag) ||
      /(?:^|;)\s*height\s*:\s*(?!auto\b)[^;]+/i.test(style);
    if (!hasExplicitHeight && !hasStyleRule(style, 'height')) {
      adds.push('height:auto');
    }
    if (adds.length === 0) return tag;
    const merged = adds.join(';') + (style ? `;${style}` : '');
    return setTagStyle(tag, merged);
  });
}

function isFullWidthTable(tag) {
  if (/\swidth\s*=\s*["']?100%["']?/i.test(tag)) return true;
  return /(?:^|;)\s*width\s*:\s*100%/i.test(getTagStyle(tag));
}

function scanTable(content, from) {
  let depth = 1;
  let i = from;
  while (i < content.length) {
    const rest = content.slice(i);
    const comment = rest.match(/^<!--[\s\S]*?-->/);
    if (comment) {
      i += comment[0].length;
      continue;
    }
    const close = rest.match(/^<\/table\s*>/i);
    if (close) {
      depth -= 1;
      if (depth === 0) {
        return { inner: content.slice(from, i), end: i + close[0].length, closeTag: close[0] };
      }
      i += close[0].length;
      continue;
    }
    const open = rest.match(/^<table\b/i);
    if (open) {
      depth += 1;
      i += open[0].length;
      continue;
    }
    i += 1;
  }
  return null;
}

function extractFirstTable(content) {
  const m = String(content || '').match(
    /^((?:\s|<!--[\s\S]*?-->)*)(<table\b[^>]*>)/i
  );
  if (!m || m.index == null) return null;
  const found = scanTable(content, m.index + m[0].length);
  if (!found) return null;
  return { prefix: m[1], openTag: m[2], inner: found.inner, suffix: content.slice(found.end) };
}

/**
 * True when the template contains an explicit user-created Container block
 * (identified by its persistent `data-te-role="container"` marker).
 */
function hasExplicitContainer(content) {
  return /<table\b[^>]*\bdata-te-role\s*=\s*["']container["']/i.test(String(content || ''));
}

function ensureWrapperAttrs(openTag) {
  let tag = openTag;
  const style = getTagStyle(tag);
  const keep = [];
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (/^(width|max-width|margin(-left|-right)?)\s*:/i.test(p)) continue;
    keep.push(p);
  }
  // The wrapper spans the full message width so the EMAIL BACKGROUND COLOR
  // fills the whole area around the single centered content container.
  tag = setTagStyle(tag, `width:100%;${keep.join(';')}`);
  const setAttr = (name, value) => {
    const attrRe = new RegExp(`\\s${name}\\s*=\\s*["'][^"']*["']`, 'i');
    if (attrRe.test(tag)) {
      tag = tag.replace(attrRe, ` ${name}="${value}"`);
    } else {
      tag = tag.replace(/>$/, ` ${name}="${value}">`);
    }
  };
  setAttr('width', '100%');
  setAttr('align', 'center');
  setAttr('cellpadding', '0');
  setAttr('cellspacing', '0');
  setAttr('role', 'presentation');
  return tag;
}

function ensureCenteredCell(inner) {
  const m = inner.match(/<td\b[^>]*>/i);
  if (!m) return inner;
  const td = m[0];
  if (/\balign\s*=\s*["']?center["']?/i.test(td)) return inner;
  if (hasStyleRule(getTagStyle(td), 'text-align')) return inner;
  return inner.replace(td, td.replace(/>$/, ' align="center">'));
}

/**
 * Resolve the email width for a content table: authored px width, then authored
 * px max-width, then the default fallback (EMAIL_SAFE_WIDTH).
 */
function resolveContentWidth(tag) {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  let widthPx = null;
  let maxPx = null;
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const lower = p.toLowerCase();
    const wm = lower.match(/^width\s*:\s*(\d+(?:\.\d+)?)px$/);
    const mm = lower.match(/^max-width\s*:\s*(\d+(?:\.\d+)?)px$/);
    if (wm) widthPx = Number(wm[1]);
    else if (mm) maxPx = Number(mm[1]);
  }

  const attrMatch = tag.match(/\swidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i);
  const attrWidth = attrMatch ? Number(attrMatch[1]) : null;
  if (widthPx == null && attrWidth != null) widthPx = attrWidth;

  if (widthPx != null && widthPx > 0) return widthPx;
  if (maxPx != null && maxPx > 0) return maxPx;
  return EMAIL_SAFE_WIDTH;
}

function capContentTable(tag, opts = {}) {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  const keep = [];
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (/^(width|max-width|margin(-left|-right)?)\s*:/i.test(p)) continue;
    keep.push(p);
  }

  // The authored width (px width, then px max-width) is preserved; EMAIL_SAFE_WIDTH
  // is used only as the fallback default when no width was authored. A degenerate
  // empty/tiny card is widened via `forceWidth` (see normalizeScaffold).
  let target = opts.forceWidth != null ? opts.forceWidth : resolveContentWidth(tag);
  if (opts.clamp) target = Math.max(target, CONTENT_WIDTH_MIN);

  const newStyle = `width:100%;max-width:${target}px;margin:0 auto;${keep.join(';')}`;
  let out = setTagStyle(tag, newStyle);

  if (/\swidth\s*=/i.test(out)) {
    out = out.replace(
      /(\swidth\s*=\s*["'])\d+(?:\.\d+)?(?:px)?(["'])/i,
      (_m, p, q) => `${p}${target}${q}`
    );
  } else {
    out = out.replace(/>$/, ` width="${target}">`);
  }
  return out;
}

/** True when a table's inner markup contains no real content (empty cells/rows only). */
function isEmptyCardInner(inner) {
  const s = String(inner || '').replace(/\s+/g, '');
  if (!s) return true;
  const stripped = s
    .replace(/<tbody\b[^>]*>/gi, '')
    .replace(/<\/tbody\s*>/gi, '')
    .replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/tr\s*>/gi, '')
    .replace(/<td\b[^>]*>/gi, '')
    .replace(/<\/td\s*>/gi, '');
  return stripped === '';
}

/** Locate the first nested table (the content card) inside a wrapper's inner HTML. */
function findContentCard(inner) {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open) return null;
  const region = scanTable(inner, open.index + open[0].length);
  if (!region) return null;
  return { tag: open[0], inner: region.inner };
}

/**
 * True when the first (wrapper) table holds a nested content card that is an
 * EMPTY or undersized styled card — the shape a broken editor produces when the
 * real content was saved OUTSIDE the scaffold. Such templates must still be
 * normalized/folded even when the wrapper is not full-width (e.g. width="50%").
 */
function isBrokenEmptyCardScaffold(first) {
  const card = findContentCard(first.inner);
  if (!card) return false;
  if (!/(?:background(?:-color)?\s*:|bgcolor\s*=|border-radius\s*:)/i.test(card.tag)) return false;
  return isEmptyCardInner(card.inner) || resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN;
}

/**
 * Find the first `<td ...>` starting at/after `from` together with its matching
 * `</td>`. Nested `<td>` depth is tracked so tables living inside a cell never
 * break the scan. Returns `{ openStart, openEnd, closeStart, closeTag, end,
 * inner }` or null when no cell exists in the region.
 */
function findTableCell(content, from) {
  const rest = content.slice(from);
  const open = rest.match(/<td\b[^>]*>/i);
  if (!open) return null;
  const openStart = from + open.index;
  const openEnd = openStart + open[0].length;
  let depth = 1;
  let i = openEnd;
  while (i < content.length) {
    const tail = content.slice(i);
    const comment = tail.match(/^<!--[\s\S]*?-->/);
    if (comment) {
      i += comment[0].length;
      continue;
    }
    const close = tail.match(/^<\/td\s*>/i);
    if (close) {
      depth -= 1;
      if (depth === 0) {
        return {
          openStart,
          openEnd,
          inner: content.slice(openEnd, i),
          closeStart: i,
          closeTag: close[0],
          end: i + close[0].length,
        };
      }
      i += close[0].length;
      continue;
    }
    const nested = tail.match(/^<td\b/i);
    if (nested) {
      depth += 1;
      i += nested[0].length;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Fold every block that the editor saved OUTSIDE the content table back into the
 * single centered content container, so the final email has exactly ONE content
 * box (plus the full-width email-background wrapper):
 *
 *   OUTER EMAIL TABLE (EMAIL BACKGROUND COLOR)
 *     └─ centered cell
 *        └─ CONTENT TABLE (CONTENT BACKGROUND COLOR, resolved width)
 *           └─ logo / image / text / all other template blocks
 *
 * Stray content is anything not already inside the content table: blocks the
 * editor placed in the wrapper cell before it, blocks placed after it (still in
 * the wrapper cell), and content that follows the wrapper table entirely (the
 * suffix). Blocks are injected inside the content table's first cell (the cell
 * is created when a template saved an empty content table), preserving authored
 * order: cell-before + existing cell content + cell-after + suffix.
 */
function foldStrayBlocks(inner, suffix) {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open) return inner;
  const openEnd = open.index + open[0].length;
  const region = scanTable(inner, openEnd);
  if (!region) return inner;
  const tableCloseStart = region.end - region.closeTag.length;
  const tableCloseEnd = region.end;

  // The wrapper's first cell wraps the content table; locate it so stray blocks
  // can be separated from the wrapper's structural <tbody>/<tr>/<td> markup.
  const cell = findTableCell(inner, 0);
  if (!cell) return inner;

  const straySuffix = String(suffix || '').trim();
  const pre = inner.slice(cell.openEnd, open.index).trim();
  const post = inner.slice(tableCloseEnd, cell.closeStart).trim();
  if (!pre && !post && !straySuffix) return inner;

  // Remove the stray blocks from their original location (the wrapper cell),
  // keeping only the structural markup and the content table.
  const preLen = open.index - cell.openEnd;
  const s1 = inner.slice(0, cell.openEnd) + inner.slice(open.index);
  const s1TableCloseEnd = tableCloseEnd - preLen;
  const s1CellCloseStart = cell.closeStart - preLen;
  const s2 = s1.slice(0, s1TableCloseEnd) + s1.slice(s1CellCloseStart);

  // Inject the stray blocks into the content table's first cell, preserving
  // authored order: cell-before + existing cell content + cell-after + suffix.
  const cellContent = findTableCell(s2, cell.openEnd);
  if (cellContent) {
    return (
      s2.slice(0, cellContent.openEnd) +
      pre +
      s2.slice(cellContent.openEnd, cellContent.closeStart) +
      [post, straySuffix].filter(Boolean).join('\n') +
      s2.slice(cellContent.closeStart)
    );
  }

  // The content table has no cell (e.g. an empty <tr>) — create one. Prefer
  // injecting the cell into the first row, otherwise add a fresh row.
  const tableInner = s2.slice(cell.openEnd, s1TableCloseEnd);
  const tr = tableInner.match(/<tr\b[^>]*>/i);
  const injected = `<td align="left" valign="top">${pre}${[post, straySuffix].filter(Boolean).join('\n')}</td>`;
  if (tr) {
    const trOpenEnd = cell.openEnd + tr.index + tr[0].length;
    return s2.slice(0, trOpenEnd) + injected + s2.slice(trOpenEnd);
  }
  const s2TableCloseStart = s1TableCloseEnd - region.closeTag.length;
  return (
    s2.slice(0, s2TableCloseStart) +
    `<tr>${injected}</tr>` +
    s2.slice(s2TableCloseStart)
  );
}

function normalizeScaffold(first, bg = '') {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  // A degenerate content card (an EMPTY stub, or one narrower than a usable
  // column) must be widened so everything folded into it forms ONE properly
  // sized card instead of a tiny 100px box.
  const card = findContentCard(inner);
  let forceWidth = null;
  if (card) {
    if (isEmptyCardInner(card.inner)) forceWidth = CONTENT_WIDTH_DEFAULT;
    else if (resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN) forceWidth = CONTENT_WIDTH_MIN;
  }
  inner = inner.replace(/<table\b[^>]*>/i, (tag) => capContentTable(tag, { forceWidth }));

  // Content that lives OUTSIDE the scaffold table (blocks the visual editor
  // saved before/after the content table or past the wrapper, as happens with
  // edited templates) must still render inside the SAME centered content
  // container — otherwise it would form a second white box or sit directly on
  // the email background. Fold it in; never append a second scaffold.
  inner = foldStrayBlocks(inner, String(first.suffix || '').trim());

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  return `${first.prefix}${wrapper}${inner}</table>`;
}

/**
 * Preserve a template that contains an explicit user-created Container. The
 * email-background wrapper stays full-width (with the extracted background
 * colour), and the Container — with EVERY block inside it — is preserved
 * verbatim. Content the user deliberately placed OUTSIDE the Container is left
 * exactly where they put it: nothing is folded or moved, because the user
 * explicitly chose where it belongs. Also used for a full-width wrapper that
 * holds no content card yet (a fresh Blank Template before the Container is
 * added) so the background-only email is not double-wrapped.
 */
function normalizeContainerScaffold(first, bg = '') {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  return `${first.prefix}${wrapper}${inner}</table>`;
}

function buildEmailScaffold(content, bg = '', width = EMAIL_SAFE_WIDTH) {
  const bgStyle = bg ? `background-color:${bg};` : '';
  const bgAttr = bg ? ` bgcolor="${bg}"` : '';
  const widthStyle = `width:100%;max-width:${width}px;margin:0 auto;`;
  return [
    `<table width="100%" align="center" cellpadding="0" cellspacing="0" border="0" role="presentation"${bgAttr} style="width:100%;${bgStyle}">`,
    '<tr><td align="center" valign="top">',
    `<table width="${width}" cellpadding="0" cellspacing="0" border="0" role="presentation" style="${widthStyle}">`,
    '<tr><td align="left" valign="top" style="padding:24px 16px;">',
    content,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
  ].join('');
}

/**
 * Convert saved template HTML (already personalized) into Gmail-safe, centered
 * email markup. Applied right before wrapHtmlDocument() in every send path.
 *
 * @param {string} html - Personalized template HTML (full document or fragment).
 * @returns {string} The same HTML wrapped in / normalized to a centered resolved-width layout.
 */
function toEmailSafeHtml(html) {
  const sourceRaw = String(html || '');
  if (!sourceRaw.trim()) return sourceRaw;

  // Normalize camelCase CSS (Gmail ignores it) across inline styles AND
  // <style> blocks FIRST, so max-width etc. survive Gmail's parser.
  const source = normalizeCssInHtml(sourceRaw);

  const bodyMatch = source.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  const isFullDocument = !!bodyMatch;
  const bodyAttrs = bodyMatch ? bodyMatch[1] : '';
  const styleBlock = (source.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const bg = extractBackgroundColor(bodyAttrs, styleBlock);

  const bodyContent = bodyMatch
    ? bodyMatch[2]
    : source
        .replace(/<!doctype[^>]*>/i, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<\/?(?:html|body)[^>]*>/gi, '')
        .trim();

  let safeBody = constrainEmailImages(bodyContent);
  safeBody = convertSocialSvgToImgs(safeBody);

  const first = extractFirstTable(safeBody);
  // Treat the first table as an editor scaffold (normalize/fold in place) when
  // it is a full-width wrapper OR a wrapper holding a broken empty/tiny content
  // card — even when the wrapper is not full-width (e.g. width="50%").
  const isScaffold =
    first &&
    /<table\b/i.test(first.inner) &&
    (isFullWidthTable(first.openTag) || isBrokenEmptyCardScaffold(first));

  if (first && hasExplicitContainer(safeBody)) {
    // Templates with an explicit Container are preserved VERBATIM — the
    // container→children hierarchy stays intact and nothing is folded/moved.
    safeBody = normalizeContainerScaffold(first, bg);
  } else if (isScaffold) {
    // Legacy/uploaded scaffolds: fold stray blocks into the content card.
    safeBody = normalizeScaffold(first, bg);
  } else if (first && isFullWidthTable(first.openTag)) {
    // Full-width wrapper with no content card yet (a fresh Blank Template
    // before the user adds a Container): keep the background only.
    safeBody = normalizeContainerScaffold(first, bg);
  } else {
    safeBody = buildEmailScaffold(safeBody, bg);
  }

  if (isFullDocument) {
    return source.replace(
      /(<body[^>]*>)([\s\S]*?)(<\/body>)/i,
      (_m, open, _inner, close) => `${open}\n${safeBody}\n${close}`
    );
  }
  return safeBody;
}

// ─── Dynamic per-recipient personalization ─────────────────────────────────
// Merge tags are resolved against the ACTUAL recipient row from
// `public.contacts`, so any column in that table can be used as a tag
// ({{full_name}}, {{email}}, {{company}}, {{designation}}, {{industry}},
// {{city}}, {{contact_type}}, {{company_category}}, {{notes}}, {{score}}, ...).
// The contact object is the source of truth — no hard-coded placeholder list.

const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+(?:\s+[^{}\s]+)*)\s*\}\}/g;

/**
 * Normalizes a placeholder name so lookup is safe and case/whitespace
 * insensitive: trims, lowercases and collapses runs of whitespace to `_`
 * (so `{{First Name}}` resolves the `full_name` column, and `{{ first_name }}`
 * resolves `first_name`).
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizePlaceholderName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Safely converts any contact value to text. Null/undefined map to null (the
 * caller treats them as "known but empty"); arrays/objects become JSON.
 *
 * @param {*} value
 * @returns {string|null}
 */
function valueToText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return String(value);
  }
}

function firstWord(value) {
  const parts = String(value || '').trim().split(/\s+/);
  return parts.length > 0 ? parts[0] : '';
}

// Data-driven aliases derived from actual contact columns. Not a per-content
// switch — it only maps synonymous tag names onto the column that already
// provides the value (the contacts table stores full_name, not first_name).
const CONTACT_ALIASES = [
  { name: 'name', source: 'full_name' },
  { name: 'first_name', source: 'full_name', transform: firstWord },
];

/**
 * Builds the placeholder→value lookup map for ONE contact row. Every column of
 * the row is registered under its normalized name; NULL/empty columns resolve
 * to '' (existing missing-value behaviour); unknown tags stay unresolved.
 *
 * @param {object|null} contact - The recipient's `public.contacts` row.
 * @param {string} [fallbackEmail] - Email from the send log for `{{email}}`.
 * @returns {Map<string, string>}
 */
function buildContactLookup(contact, fallbackEmail) {
  const row = contact || {};
  const lookup = new Map();

  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizePlaceholderName(key);
    const text = valueToText(value);
    lookup.set(normalized, text === null ? '' : text);
  }

  // `{{email}}` still resolves when the contact row has no email address.
  if (!lookup.has('email')) {
    const fallback = valueToText(fallbackEmail);
    if (fallback) lookup.set('email', fallback);
  }

  for (const alias of CONTACT_ALIASES) {
    const source = lookup.get(normalizePlaceholderName(alias.source));
    if (source === undefined) continue;
    lookup.set(alias.name, alias.transform ? alias.transform(source) : source);
  }

  return lookup;
}

function collectPlaceholders(template) {
  const names = [];
  const seen = new Set();
  String(template || '').replace(PLACEHOLDER_RE, (_match, name) => {
    const normalized = normalizePlaceholderName(name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
    return _match;
  });
  return names;
}

const DEBUG_PERSONALIZATION =
  (typeof process !== 'undefined' &&
    process.env &&
    (process.env.PERSONALIZATION_DEBUG === '1' || process.env.NODE_ENV !== 'production')) ||
  false;

/**
 * Personalize a subject/body template for ONE recipient.
 *
 * Every tag matching a `public.contacts` column (or a supported derived alias
 * such as {{first_name}} / {{name}}) is replaced with THAT contact's value.
 * Tags with no matching column are preserved verbatim. Never throws on
 * null/empty values or missing contact rows. Debug logs (dev only, off by
 * default in production) never include credentials.
 *
 * @param {string} template - Subject or body containing {{field}} tags.
 * @param {object|null} contact - The recipient's `public.contacts` row.
 * @param {string} [fallbackEmail] - Email from the send log for `{{email}}`.
 * @param {object} [options]
 * @param {boolean} [options.debug] - Force debug logging (default: dev only).
 * @returns {string} The personalized template.
 */
function personalizeTemplate(template, contact, fallbackEmail, options = {}) {
  const lookup = buildContactLookup(contact, fallbackEmail);
  const resolved = [];

  const result = String(template || '').replace(PLACEHOLDER_RE, (match, name) => {
    const key = normalizePlaceholderName(name);
    const value = lookup.get(key);
    if (value === undefined) return match; // unknown tag → preserved
    resolved.push(key);
    return value;
  });

  if (options.debug || DEBUG_PERSONALIZATION) {
    const placeholders = collectPlaceholders(template);
    if (placeholders.length > 0) {
      const email =
        valueToText(contact && contact.email) || valueToText(fallbackEmail) || '';
      console.log(`[Personalization] recipient=${email}`);
      console.log(`[Personalization] placeholders=[${placeholders.join(', ')}]`);
      console.log(`[Personalization] resolved=${resolved.length}`);
    }
  }

  return result;
}

export {
  replaceTemplateVars,
  personalizeTemplate,
  buildContactLookup,
  normalizePlaceholderName,
  escapeHtml,
  stripHtml,
  decodeHtmlEntities,
  hasHtmlTags,
  plainTextToHtml,
  buildTrackedHtml,
  wrapHtmlDocument,
  toEmailSafeHtml,
};
