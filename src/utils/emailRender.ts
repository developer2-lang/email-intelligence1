/**
 * Frontend mirror of the shared email-rendering pipeline used by every send
 * path (`supabase/functions/_shared/email-render.ts` and the backend's
 * `backend/utils/emailTemplate.js`). It exists so template PREVIEWS show the
 * exact same layout that the actual sent email gets:
 *
 *   OUTER EMAIL TABLE (EMAIL BACKGROUND COLOR)
 *     └─ centered cell
 *        └─ CONTAINER (the white email card, authored width)
 *           └─ logo / image / paragraphs / buttons / every other block
 *
 * Templates that contain an explicit user-created Container (marked with the
 * persistent `data-te-role="container"` attribute) are preserved VERBATIM:
 * the container→children hierarchy is kept, and content the user deliberately
 * placed outside the Container stays outside — nothing is folded or moved.
 *
 * Legacy templates without an explicit Container still get the old behaviour:
 * content the editor saved outside the content table is folded back into the
 * SAME content card — never into a second white box and never directly onto the
 * email background — and a degenerate empty/tiny card is widened to a usable
 * email width. Images are constrained to the container and camelCase CSS
 * (GrapesJS `maxWidth` etc.) is normalized to kebab-case so Gmail does not
 * drop it.
 *
 * KEEP THIS FILE IN SYNC with the shared renderer when changing container
 * behaviour.
 */

export const EMAIL_SAFE_WIDTH = 520;

// A degenerate content card (an EMPTY stub, or a card narrower than a usable
// email column) must be widened before folded content is injected, so the final
// email always has ONE properly-sized white card instead of a tiny 100px box.
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_DEFAULT = 600;

const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i;

function getTagStyle(tag: string): string {
  const m = tag.match(STYLE_ATTR_RE);
  return m ? m[2] : '';
}

function setTagStyle(tag: string, newStyle: string): string {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  if (styleMatch) {
    const pre = tag.slice(0, styleMatch.index ?? 0);
    const post = tag.slice((styleMatch.index ?? 0) + styleMatch[0].length);
    return `${pre} style="${newStyle}"${post}`;
  }
  return tag.replace(/\s*>$/, (end: string) => ` style="${newStyle}"${end}`);
}

function hasStyleRule(style: string, name: string): boolean {
  return new RegExp(`(?:^|;)\\s*${name}\\s*:`).test(style);
}

// ─── CSS normalization ─────────────────────────────────────────────────────
// Gmail drops camelCase CSS (e.g. GrapesJS `maxWidth:100%`); only kebab-case
// survives. Normalize every inline style AND every <style> block.

const CSS_KEBAB_RE = /([a-z0-9])([A-Z])/g;

function kebabCaseCssProp(prop: string): string {
  return String(prop || '').replace(CSS_KEBAB_RE, '$1-$2').toLowerCase();
}

function normalizeCssDeclaration(css: string): string {
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

function normalizeCssInHtml(html: string): string {
  let out = String(html || '').replace(
    /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi,
    (_m: string, quote: string, css: string) =>
      ` style=${quote}${normalizeCssDeclaration(css)}${quote}`,
  );
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m: string, css: string) => {
    const normalized = css.replace(
      /(\{)([\s\S]*?)(\})/g,
      (_r: string, open: string, body: string, close: string) =>
        `${open}${normalizeCssDeclaration(body)}${close}`,
    );
    return `<style>${normalized}</style>`;
  });
  return out;
}

// ─── Email background extraction ───────────────────────────────────────────

function extractBackgroundColor(bodyAttrs: string, styleBlock: string): string {
  const colors: string[] = [];
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
// Gmail strips inline <svg>. Each social icon is an <a> containing an
// <svg><path fill=".."/></svg>; only the <svg> is swapped for an <img> pointing
// at a PNG (Gmail's image proxy blocks SVG images).

interface SocialIconItem {
  id: string;
  url: string;
  size: number;
  color: string;
  bg: string;
  shape: string;
  radius: string;
}

function decodeAttrEntities(value: string): string {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseSocialIcons(rawJson: string): SocialIconItem[] | null {
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed && Array.isArray(parsed.icons)) {
      return parsed.icons.map((ic: any) => ({
        id: String((ic && ic.id) || ''),
        url: String((ic && ic.url) || ''),
        size: Number(ic && ic.size) || 40,
        color: String((ic && ic.color) || '#FFFFFF'),
        bg: String((ic && ic.bg) || ''),
        shape: String((ic && ic.shape) || 'circle'),
        radius: String((ic && ic.radius) || ''),
      }));
    }
  } catch {
    // unparseable config → leave the block untouched
  }
  return null;
}

const ICONS8_ICON_NAMES: Record<string, string> = {
  instagram: 'instagram-new',
  linkedin: 'linkedin',
  facebook: 'facebook',
  youtube: 'youtube-play',
  google: 'google',
  website: 'globe',
  email: 'mail',
};

function socialIconImageUrl(brand: string, fill: string): string {
  const hex = String(fill || '#FFFFFF').replace(/^#/, '');
  const key = String(brand || 'website').toLowerCase();
  const iconName = ICONS8_ICON_NAMES[key];
  if (iconName) {
    return `https://img.icons8.com/ios/48/${hex}/${iconName}.png`;
  }
  return `https://cdn.jsdelivr.net/npm/simple-icons-png@latest/icons/${encodeURIComponent(key)}.png`;
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
function socialBrandFromHref(href: string): string {
  let value = String(href || '');
  const urlParam = (value.match(/[?&]url=([^&#]+)/i) || [])[1];
  if (urlParam) {
    try {
      value = decodeURIComponent(urlParam);
    } catch {
      value = urlParam;
    }
  }
  value = value.toLowerCase();
  if (/^mailto:/i.test(value)) return 'email';
  const table: Array<[string, string]> = [
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

function socialAnchorToImg(anchor: string, item: SocialIconItem | null): string {
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

function convertSocialSvgToImgs(content: string): string {
  return String(content || '').replace(
    /<table\b[^>]*\bdata-te-social\b[^>]*>([\s\S]*?)<\/table>/gi,
    (whole: string, inner: string) => {
      const attrMatch = whole.match(/\bdata-te-social\s*=\s*["']([^"']*)["']/i);
      const raw = attrMatch ? attrMatch[1] : '';
      const icons = raw ? parseSocialIcons(decodeAttrEntities(raw)) : null;
      if (icons && icons.length === 0) return whole;
      let idx = 0;
      const newInner = inner.replace(
        /<a\b[^>]*>[\s\S]*?<svg\b[^>]*>[\s\S]*?<\/svg>[\s\S]*?<\/a>/gi,
        (anchor: string) => {
          const item = icons ? icons[idx % icons.length] : null;
          idx += 1;
          return socialAnchorToImg(anchor, item);
        },
      );
      return whole.replace(inner, newInner);
    },
  );
}

/** Keep template images from overflowing the content container. */
function constrainEmailImages(content: string): string {
  return String(content || '').replace(/<img\b[^>]*>/gi, (tag: string) => {
    const style = getTagStyle(tag);
    const adds: string[] = [];
    if (!hasStyleRule(style, 'display')) adds.push('display:block');
    if (!hasStyleRule(style, 'max-width')) adds.push('max-width:100%');
    const hasExplicitHeight =
      /\sheight\s*=\s*["']?[^"'\s>]+/i.test(tag) ||
      /(?:^|;)\s*height\s*:\s*(?!auto\b)[^;]+/i.test(style);
    if (!hasExplicitHeight && !hasStyleRule(style, 'height')) {
      adds.push('height:auto');
    }
    if (adds.length === 0) return tag;
    const merged = adds.join(';') + (style ? ';' + style : '');
    return setTagStyle(tag, merged);
  });
}

// ─── Scaffold detection / normalization ────────────────────────────────────

function isFullWidthTable(tag: string): boolean {
  if (/\swidth\s*=\s*["']?100%["']?/i.test(tag)) return true;
  return /(?:^|;)\s*width\s*:\s*100%/i.test(getTagStyle(tag));
}

/** Scan forward and return the inner HTML of the table opened at `from`. */
function scanTable(
  content: string,
  from: number,
): { inner: string; end: number; closeTag: string } | null {
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

interface FirstTable {
  prefix: string;
  openTag: string;
  inner: string;
  suffix: string;
}

/** Extract the first top-level <table> (if any) that opens the content. */
function extractFirstTable(content: string): FirstTable | null {
  const m = String(content || '').match(/^((?:\s|<!--[\s\S]*?-->)*)(<table\b[^>]*>)/i);
  if (!m || m.index == null) return null;
  const found = scanTable(content, m.index + m[0].length);
  if (!found) return null;
  return { prefix: m[1], openTag: m[2], inner: found.inner, suffix: content.slice(found.end) };
}

/** True when the template contains an explicit user-created Container block. */
function hasExplicitContainer(content: string): boolean {
  return /<table\b[^>]*\bdata-te-role\s*=\s*["']container["']/i.test(String(content || ''));
}

function ensureWrapperAttrs(openTag: string): string {
  let tag = openTag;
  const style = getTagStyle(tag);
  const keep: string[] = [];
  for (const part of style.split(';')) {
    const p = part.trim();
    if (!p) continue;
    if (/^(width|max-width|margin(-left|-right)?)\s*:/i.test(p)) continue;
    keep.push(p);
  }
  // The wrapper spans the full message width so the EMAIL BACKGROUND COLOR
  // fills the whole area around the single centered content container.
  tag = setTagStyle(tag, `width:100%;${keep.join(';')}`);
  const setAttr = (name: string, value: string) => {
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

function ensureCenteredCell(inner: string): string {
  const m = inner.match(/<td\b[^>]*>/i);
  if (!m) return inner;
  const td = m[0];
  if (/\balign\s*=\s*["']?center["']?/i.test(td)) return inner;
  if (hasStyleRule(getTagStyle(td), 'text-align')) return inner;
  return inner.replace(td, td.replace(/>$/, ' align="center">'));
}

/** Resolve the email width for a content table: authored px width, then px max-width, then default. */
function resolveContentWidth(tag: string): number {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  let widthPx: number | null = null;
  let maxPx: number | null = null;
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

/** Cap the first nested table (the content container) to the resolved width. */
function capContentTable(tag: string, opts: { forceWidth?: number; clamp?: boolean } = {}): string {
  const styleMatch = tag.match(STYLE_ATTR_RE);
  const style = styleMatch ? styleMatch[2] : '';

  const keep: string[] = [];
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
      (_m: string, p: string, q: string) => `${p}${target}${q}`,
    );
  } else {
    out = out.replace(/>$/, ` width="${target}">`);
  }
  return out;
}

/** True when a table's inner markup contains no real content (empty cells/rows only). */
function isEmptyCardInner(inner: string): boolean {
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
function findContentCard(inner: string): { tag: string; inner: string } | null {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open || open.index == null) return null;
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
function isBrokenEmptyCardScaffold(first: FirstTable): boolean {
  const card = findContentCard(first.inner);
  if (!card) return false;
  if (!/(?:background(?:-color)?\s*:|bgcolor\s*=|border-radius\s*:)/i.test(card.tag)) return false;
  return isEmptyCardInner(card.inner) || resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN;
}

interface TableCell {
  openStart: number;
  openEnd: number;
  inner: string;
  closeStart: number;
  closeTag: string;
  end: number;
}

/** Find the first `<td ...>` starting at/after `from` together with its matching `</td>`. */
function findTableCell(content: string, from: number): TableCell | null {
  const rest = content.slice(from);
  const open = rest.match(/<td\b[^>]*>/i);
  if (!open || open.index == null) return null;
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
 * Fold every block saved OUTSIDE the content table back into the single
 * centered content container so the final email has exactly ONE content box.
 */
function foldStrayBlocks(inner: string, suffix: string): string {
  const open = inner.match(/<table\b[^>]*>/i);
  if (!open || open.index == null) return inner;
  const openEnd = open.index + open[0].length;
  const region = scanTable(inner, openEnd);
  if (!region) return inner;
  const tableCloseEnd = region.end;

  const cell = findTableCell(inner, 0);
  if (!cell) return inner;

  const straySuffix = String(suffix || '').trim();
  const pre = inner.slice(cell.openEnd, open.index).trim();
  const post = inner.slice(tableCloseEnd, cell.closeStart).trim();
  if (!pre && !post && !straySuffix) return inner;

  const preLen = open.index - cell.openEnd;
  const s1 = inner.slice(0, cell.openEnd) + inner.slice(open.index);
  const s1TableCloseEnd = tableCloseEnd - preLen;
  const s1CellCloseStart = cell.closeStart - preLen;
  const s2 = s1.slice(0, s1TableCloseEnd) + s1.slice(s1CellCloseStart);

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

  const tableInner = s2.slice(cell.openEnd, s1TableCloseEnd);
  const tr = tableInner.match(/<tr\b[^>]*>/i);
  const injected = `<td align="left" valign="top">${pre}${[post, straySuffix].filter(Boolean).join('\n')}</td>`;
  if (tr && tr.index != null) {
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

function normalizeScaffold(first: FirstTable, bg = ''): string {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  // A degenerate content card (an EMPTY stub, or one narrower than a usable
  // column) must be widened so everything folded into it forms ONE properly
  // sized card instead of a tiny 100px box.
  const card = findContentCard(inner);
  let forceWidth: number | null = null;
  if (card) {
    if (isEmptyCardInner(card.inner)) forceWidth = CONTENT_WIDTH_DEFAULT;
    else if (resolveContentWidth(card.tag) < CONTENT_WIDTH_MIN) forceWidth = CONTENT_WIDTH_MIN;
  }
  inner = inner.replace(/<table\b[^>]*>/i, (tag: string) => capContentTable(tag, { forceWidth: forceWidth ?? undefined }));

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end: string) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  // Fold stray blocks into the SAME content container — never a second scaffold.
  inner = foldStrayBlocks(inner, String(first.suffix || '').trim());

  return first.prefix + wrapper + inner + '</table>';
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
function normalizeContainerScaffold(first: FirstTable, bg = ''): string {
  let inner = first.inner;
  inner = ensureCenteredCell(inner);

  let wrapper = ensureWrapperAttrs(first.openTag);
  if (bg && !/\bbgcolor\s*=/i.test(wrapper)) {
    wrapper = wrapper.replace(/>\s*$/, (end: string) => ` bgcolor="${bg}"${end}`);
    const wStyle = getTagStyle(wrapper);
    if (!hasStyleRule(wStyle, 'background-color')) {
      wrapper = setTagStyle(wrapper, `background-color:${bg};${wStyle}`);
    }
  }

  return first.prefix + wrapper + inner + '</table>';
}

function buildEmailScaffold(content: string, bg = '', width = EMAIL_SAFE_WIDTH): string {
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
 * Convert saved template HTML into Gmail-safe, centered email markup with ONE
 * content container. Mirrors the shared send-time renderer exactly.
 *
 * @param html - Template HTML (full document or fragment).
 * @returns The same HTML wrapped in / normalized to a single centered container.
 */
export function toEmailSafeHtml(html: string): string {
  const sourceRaw = String(html || '');
  if (!sourceRaw.trim()) return sourceRaw;

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
      (_m: string, open: string, _inner: string, close: string) => `${open}\n${safeBody}\n${close}`,
    );
  }
  return safeBody;
}

/** Wrap a body fragment in a full HTML document (for iframe previews). */
export function wrapHtmlDocument(html: string): string {
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

const CANONICAL_LINK_STYLE = 'color:#0066cc !important;text-decoration:underline !important;overflow-wrap:anywhere;word-break:break-word;';

function isButtonAnchor(anchor: string): boolean {
  return /data-te-button/.test(anchor);
}

function isSocialAnchor(anchor: string): boolean {
  return /<img\b[^>]*>/i.test(anchor) && !/<svg\b/i.test(anchor);
}

function getAnchorHref(anchor: string): string {
  const match = anchor.match(/\bhref\s*=\s*["']([^"']*)["']/i);
  return match ? match[1] : '';
}

function getAnchorContent(anchor: string): string {
  const openEnd = anchor.indexOf('>');
  const closeStart = anchor.lastIndexOf('</a>');
  if (openEnd === -1 || closeStart === -1 || closeStart < openEnd) return '';
  return anchor.slice(openEnd + 1, closeStart);
}

function setAnchorStyle(anchor: string, style: string): string {
  const styleRe = /\sstyle\s*=\s*["']([^"']*)["']/i;
  if (styleRe.test(anchor)) {
    return anchor.replace(styleRe, ` style="${style}"`);
  }
  return anchor.replace(/>\s*$/, ` style="${style}">`);
}

function setAnchorContent(anchor: string, content: string): string {
  const openEnd = anchor.indexOf('>');
  const closeStart = anchor.lastIndexOf('</a>');
  if (openEnd === -1 || closeStart === -1 || closeStart < openEnd) return anchor;
  return anchor.slice(0, openEnd + 1) + content + anchor.slice(closeStart);
}

function extractOriginalUrlFromTracking(href: string): string {
  const urlParam = href.match(/[?&]url=([^&#]+)/i);
  if (urlParam) {
    try {
      return decodeURIComponent(urlParam[1]);
    } catch {
      return urlParam[1];
    }
  }
  return href;
}

function normalizeAnchorContent(content: string, href: string): string {
  let normalized = content;
  
  // Remove nested spans that override color
  normalized = normalized.replace(/<span\b[^>]*style\s*=\s*["'][^"']*color\s*:\s*#[0-9a-fA-F]{3,6}[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi, '$1');
  
  // If content contains the full URL, keep it; otherwise use href
  if (normalized.includes(href)) {
    return normalized;
  }
  
  // Check if content is a truncated version of href
  const hrefLower = href.toLowerCase();
  const contentLower = normalized.toLowerCase();
  if (hrefLower.startsWith(contentLower.replace(/\s+/g, ''))) {
    return href;
  }
  
  return normalized;
}

export function normalizeEmailLinks(html: string): string {
  if (!html) return html;
  
  const anchors: Array<{ full: string; href: string; content: string; index: number }> = [];
  let match;
  const anchorRegex = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  
  while ((match = anchorRegex.exec(html)) !== null) {
    const full = match[0];
    const href = getAnchorHref(full);
    const content = getAnchorContent(full);
    anchors.push({ full, href, content, index: match.index });
  }
  
  if (anchors.length === 0) return html;
  
  let result = html;
  let offset = 0;
  
  for (const anchor of anchors) {
    if (isButtonAnchor(anchor.full) || isSocialAnchor(anchor.full)) {
      continue;
    }
    
    const originalUrl = extractOriginalUrlFromTracking(anchor.href);
    const normalizedContent = normalizeAnchorContent(anchor.content, originalUrl);
    
    let newAnchor = anchor.full;
    newAnchor = setAnchorStyle(newAnchor, CANONICAL_LINK_STYLE);
    newAnchor = setAnchorContent(newAnchor, normalizedContent);
    
    const start = anchor.index + offset;
    const end = start + anchor.full.length;
    result = result.slice(0, start) + newAnchor + result.slice(end);
    offset += newAnchor.length - anchor.full.length;
  }
  
  // Handle split URLs (text after </a> that continues the URL)
  // This is a simplified version - looks for text immediately after </a> that looks like a URL continuation
  result = result.replace(
    /<\/a>\s*([a-zA-Z0-9\/\-_\.?=&%#]+)/gi,
    (match, continuation) => {
      // Check if the preceding anchor's href contains this continuation
      const beforeMatch = result.slice(0, result.indexOf(match)).match(/<a\b[^>]*href\s*=\s*["']([^"']*)["']/i);
      if (beforeMatch) {
        const href = beforeMatch[1];
        const originalUrl = extractOriginalUrlFromTracking(href);
        if (originalUrl.includes(continuation)) {
          return ''; // Remove the continuation as it's already in the anchor
        }
      }
      return match;
    }
  );
  
  return result;
}