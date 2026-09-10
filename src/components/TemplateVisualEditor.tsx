import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import grapesjs, { type Component, type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import { uploadEmailImage } from '../services/campaignService';
import {
  SOCIAL_DATA_ATTR,
  SOCIAL_PLATFORMS,
  type SocialAlign,
  type SocialConfig,
  type SocialIconItem,
  buildSocialBlockHtml,
  buildSocialIconsHtml,
  buildSocialRowHtml,
  defaultSocialConfig,
  parseSocialConfig,
  platformById,
} from './socialIcons';

export interface TemplateVisualEditorHandle {
  /** Serialize the current canvas back to a full HTML document. */
  getHtml: () => string;
  /** Current selected component (or null). */
  getSelected: () => Component | null;
}

export interface TemplateVisualEditorProps {
  /** Full HTML document loaded into the editor. Read ONCE on mount — re-mount to reload. */
  initialHtml?: string;
  /** Fired (debounced) whenever the user changes the layout/content/styles. */
  onChange: (html: string) => void;
  /** Fired when an image upload fails so the caller can surface the error. */
  onError?: (message: string) => void;
  /** When true the editor is rendered in expanded/full-screen layout mode. */
  fullscreen?: boolean;
  /** Called when the user clicks the Full Screen / Minimize toolbar button. */
  onToggleFullscreen?: () => void;
}

const IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320"><rect width="100%" height="100%" fill="#EEF2F7"/><text x="50%" y="46%" fill="#94A3B8" font-family="Arial, sans-serif" font-size="20" text-anchor="middle">Double-click to add an image</text><text x="50%" y="62%" fill="#CBD5E1" font-family="Arial, sans-serif" font-size="14" text-anchor="middle">or select it and click Replace</text></svg>'
)}`;

const LOGO_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="100%" height="100%" fill="#1E3A8A"/><text x="50%" y="56%" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="28" font-weight="bold" text-anchor="middle" letter-spacing="6">IUOVA</text></svg>'
)}`;

const VIDEO_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="100%" height="100%" fill="#0F172A"/><circle cx="240" cy="135" r="48" fill="#FFFFFF" opacity="0.92"/><polygon points="222,112 222,158 264,135" fill="#2563EB"/></svg>'
)}`;

const FONT_FAMILIES = [
  'Arial',
  'Arial Black',
  'Georgia',
  'Helvetica',
  'Tahoma',
  'Trebuchet MS',
  'Times New Roman',
  'Verdana',
  'Courier New',
  'sans-serif',
  'serif',
  'monospace',
];

const FONT_WEIGHTS = [
  'normal',
  'bold',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
];

const TEXT_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
const IMAGE_ALIGNMENTS = ['left', 'center', 'right'] as const;

const EMAIL_BLOCK_BASE =
  'font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #374151;';

/**
 * Shared GrapesJS resize configuration. This is the single source of truth for
 * the "universal blue resize border + handles" behavior. Every editable email
 * element (Container, Section, Text, Heading, Paragraph, Image, Button,
 * Divider, Spacer, Video, Social, Logo, Columns, Footer, Table/Row/Cell, etc.)
 * reuses this exact object so they all behave like the built-in `image` type.
 *
 *  - all eight handles (corners + edge midpoints) are enabled
 *  - resizing writes real `width`/`height` (px) into the component style, which
 *    is then serialized into the saved email HTML (email-safe: no editor JS is
 *    emitted) and reflected by the Properties panel via `component:styleUpdate`
 *  - `minDim` enforces a sensible minimum so elements can never be dragged to an
 *    unusably small size (requirement #15)
 */
const UNIVERSAL_RESIZE = {
  tl: true,
  tc: true,
  tr: true,
  cl: true,
  cr: true,
  bl: true,
  bc: true,
  br: true,
  currentUnit: false,
  unitWidth: 'px',
  unitHeight: 'px',
  minDim: 20,
  step: 1,
};

/**
 * Re-apply a uniform `resizable` configuration to every registered GrapesJS
 * component type so newly created blocks and reloaded templates all gain the
 * same visual resize behavior. The document `wrapper`/`body` are intentionally
 * excluded (we never want to resize the whole email canvas), and the `image`
 * and `link` (Button) types keep their own already-correct resizable handling.
 */
function makeAllTypesResizable(editor: Editor): void {
  const dc = editor.DomComponents;
  const skip = new Set(['wrapper', 'body', 'image', 'link', 'p']);
  dc.getTypes().forEach((t: any) => {
    const id = (t && (t.id || t.name)) || t;
    if (!id || skip.has(id)) return;
    try {
      const cur = dc.getType(id);
      if (!cur || !cur.model) return;
      const baseDefaults =
        typeof (cur.model as any).getDefaults === 'function'
          ? (cur.model as any).getDefaults()
          : (cur.model.prototype as any)?.defaults || {};
      dc.addType(id, {
        model: {
          defaults: { ...(baseDefaults || {}), resizable: UNIVERSAL_RESIZE },
        },
      });
    } catch {
      /* best-effort: an unrecognized type should never block the others */
    }
  });
}

/**
 * True only for the *structural* email background scaffold: the
 * `email-wrapper` table itself and its immediate `<tr>`/`<td>` rows/cells.
 * Anything nested deeper (the Container, Section, Columns, user Table blocks
 * and their cells) is real editable content and must stay resizable.
 *
 * This is the key distinction that was previously missing: the old code
 * disabled resizing for *every* table/row/cell living anywhere inside the
 * `email-wrapper`, which also killed the Container's resize handles. The
 * wrapper's own single drop-zone `<td>` is depth 1; the Container table is
 * depth 2 (wrapper → td → container), so it is correctly excluded here.
 */
function isEmailScaffold(comp: Component | null): boolean {
  if (!comp) return false;
  const attrs = comp.getAttributes?.() || {};
  if (attrs['data-te-role'] === 'email-wrapper') return true;
  const parent = comp.parent();
  if (parent && (parent.getAttributes?.()?.['data-te-role'] === 'email-wrapper')) return true;
  return false;
}

/**
 * The email background scaffold (the outer `email-wrapper` table and its
 * immediate structural rows/cells) must never be resized by the user. Only
 * those immediate scaffold nodes are disabled here — every nested table
 * element (Container, Section, Columns, user Table blocks, …) keeps full
 * resizing so the user can actually change the email layout width.
 */
function disableWrapperResize(editor: Editor): void {
  const wrapper = editor.getWrapper();
  if (!wrapper) return;
  const walk = (comps: any[]) => {
    for (const c of comps) {
      const tag = String(c.get('tagName') || '').toLowerCase();
      if (['table', 'tbody', 'tr', 'td'].includes(tag)) {
        if (isEmailScaffold(c)) c.set('resizable', false);
      }
      const children = c.components ? c.components().models : [];
      if (children && children.length) walk(children);
    }
  };
  walk(wrapper.components().models);
}

/**
 * The empty "Blank Template" document used by the Template Editor. It contains
 * ONLY the email-background layer (a full-width #FAFAFA table). There is NO
 * automatic content card — the user explicitly adds the main "Container" block
 * from the content panel, and every other block is dropped INSIDE that
 * Container so the DOM stays `container → child blocks`. The
 * `data-te-role="container"` marker survives saving so the hierarchy is
 * reconstructed on reload and preserved verbatim on preview/send. Content the
 * user deliberately places outside the Container is left exactly where it was
 * placed.
 */
export const BLANK_TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title></title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAFAFA; font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #374151; line-height: 1.6;">
  <table data-te-role="email-wrapper" width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width: 100%; background-color: #FAFAFA; min-height: 600px;">
    <tr>
      <td align="center" style="background-color: #FAFAFA; padding: 32px 16px;"></td>
    </tr>
  </table>
</body>
</html>`;

// Drag-and-drop email-safe blocks shown in the left "CONTENT" panel. All
// structures favour tables + inline styles so the generated HTML survives
// email delivery (Outlook / Gmail / mobile).
const EMAIL_EDITOR_BLOCKS = [
  {
    id: 'te-container',
    label: 'Container',
    category: 'CONTENT',
    media: '<span class="te-blk">▤</span>',
    content:
      '<table data-te-role="container" width="600" cellpadding="0" cellspacing="0" role="presentation" style="width: 600px; max-width: 100%; margin: 0 auto; background-color: #FFFFFF; border-radius: 12px; overflow: hidden;">' +
      '<tr><td align="left" valign="top" style="padding: 32px;"></td></tr>' +
      '</table>',
  },
  {
    id: 'te-text',
    label: 'Text',
    category: 'CONTENT',
    media: '<span class="te-blk">T</span>',
    content:
      `<div style="${EMAIL_BLOCK_BASE} margin: 0 0 12px;">Rich text block — type anything here. Placeholders like {{first_name}} are preserved.</div>`,
  },
  {
    id: 'te-heading',
    label: 'Heading',
    category: 'CONTENT',
    media: '<span class="te-blk">H</span>',
    content:
      '<h2 style="font-family: Arial, Helvetica, sans-serif; font-size: 24px; color: #1F2937; margin: 0 0 12px;">Add a heading</h2>',
  },
  {
    id: 'te-paragraph',
    label: 'Paragraph',
    category: 'CONTENT',
    media: '<span class="te-blk">¶</span>',
    content:
      `<p style="${EMAIL_BLOCK_BASE} margin: 0 0 12px;">Write a paragraph of text. Dynamic placeholders like {{company}} stay intact while editing.</p>`,
  },
  {
    id: 'te-image',
    label: 'Image',
    category: 'CONTENT',
    media: '<span class="te-blk">▣</span>',
    content:
      '<div data-te-role="image-wrapper" style="width: 100%; text-align: center; margin: 0 0 16px;">' +
      '<img src="' +
      IMAGE_PLACEHOLDER +
      '" alt="Add an image" style="display: inline-block; max-width: 100%; height: auto; border: 0;" />' +
      '</div>',
  },
  {
    id: 'te-button',
    label: 'Button',
    category: 'CONTENT',
    media: '<span class="te-blk">▭</span>',
    content:
      '<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin: 0 auto 16px;"><tr><td align="center" style="border-radius: 6px; background-color: #2563EB; padding: 0;"><a data-te-button="" style="display: inline-block; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #FFFFFF; text-decoration: none; padding: 12px 24px; border-radius: 6px; line-height: 1.2; mso-padding-alt: 0;">Click here</a></td></tr></table>',
  },
  {
    id: 'te-divider',
    label: 'Divider',
    category: 'CONTENT',
    media: '<span class="te-blk">—</span>',
    content: '<hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;" />',
  },
  {
    id: 'te-spacer',
    label: 'Spacer',
    category: 'CONTENT',
    media: '<span class="te-blk">⇕</span>',
    content: '<div style="height: 32px; line-height: 32px; font-size: 0;">&nbsp;</div>',
  },
  {
    id: 'te-video',
    label: 'Video',
    category: 'CONTENT',
    media: '<span class="te-blk">▶</span>',
    content:
      '<a href="https://www.youtube.com/" style="display: block; text-decoration: none; margin: 0 auto 16px; max-width: 480px;"><img src="' +
      VIDEO_PLACEHOLDER +
      '" alt="Watch the video" width="480" style="display: block; width: 100%; height: auto; border-radius: 8px; border: 0;" /></a>',
  },
  {
    id: 'te-social',
    label: 'Social',
    category: 'CONTENT',
    media: '<span class="te-blk">◎</span>',
    content: buildSocialBlockHtml(defaultSocialConfig()),
  },
  {
    id: 'te-logo',
    label: 'Logo',
    category: 'CONTENT',
    media: '<span class="te-blk">◆</span>',
    content: {
      type: 'image',
      src: LOGO_PLACEHOLDER,
      alt: 'IUOVA Logo',
      width: '160',
      style: {
        display: 'block',
        width: '160px',
        height: 'auto',
        margin: '0 auto 16px',
        border: '0',
      },
    },
  },
  {
    id: 'te-section',
    label: 'Section',
    category: 'CONTENT',
    media: '<span class="te-blk">▧</span>',
    content:
      '<table data-te-role="section" role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width: 100%; margin: 0 0 16px; background-color: #F8FAFC; border-radius: 8px;"><tr><td style="padding: 16px;"></td></tr></table>',
  },
  {
    id: 'te-columns-1',
    label: '1 Column',
    category: 'CONTENT',
    media: '<span class="te-blk">▯</span>',
    content:
      '<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; margin: 0 0 16px;"><tr><td style="padding: 0;">' +
      `<p style="${EMAIL_BLOCK_BASE} margin: 0;">One column section — drop content here.</p>` +
      '</td></tr></table>',
  },
  {
    id: 'te-columns-2',
    label: '2 Columns',
    category: 'CONTENT',
    media: '<span class="te-blk">▮▯</span>',
    content:
      '<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; margin: 0 0 16px;"><tr>' +
      `<td width="50%" valign="top" style="width: 50%; vertical-align: top; padding: 0 8px;"><p style="${EMAIL_BLOCK_BASE} margin: 0;">Column 1</p></td>` +
      `<td width="50%" valign="top" style="width: 50%; vertical-align: top; padding: 0 8px;"><p style="${EMAIL_BLOCK_BASE} margin: 0;">Column 2</p></td>` +
      '</tr></table>',
  },
  {
    id: 'te-columns-3',
    label: '3 Columns',
    category: 'CONTENT',
    media: '<span class="te-blk">▮▮▯</span>',
    content:
      '<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; margin: 0 0 16px;"><tr>' +
      `<td width="33%" valign="top" style="width: 33.33%; vertical-align: top; padding: 0 6px;"><p style="${EMAIL_BLOCK_BASE} margin: 0;">Column 1</p></td>` +
      `<td width="33%" valign="top" style="width: 33.33%; vertical-align: top; padding: 0 6px;"><p style="${EMAIL_BLOCK_BASE} margin: 0;">Column 2</p></td>` +
      `<td width="33%" valign="top" style="width: 33.33%; vertical-align: top; padding: 0 6px;"><p style="${EMAIL_BLOCK_BASE} margin: 0;">Column 3</p></td>` +
      '</tr></table>',
  },
  {
    id: 'te-footer',
    label: 'Footer',
    category: 'CONTENT',
    media: '<span class="te-blk">☰</span>',
    content: buildFooterHtml(),
  },
];

/** Build the default email footer markup. The root `<div>` carries the
 * `data-te-footer` marker (which survives saving/reloading, like the Social
 * block's `data-te-social`) so the footer is re-identified after a round-trip.
 * The company name, address and the two links each carry a `data-footer-part`
 * marker so the Properties panel can target them independently. */
function buildFooterHtml(cfg: Partial<FooterConfig> = {}): string {
  const company = cfg.company ?? 'IUOVA Design Company';
  const address =
    cfg.address ??
    'IUOVA · 504 Felix Towers, Lbs Road · Off No, Bhandup West · Mumbai, Maharashtra 400078 · India';
  const prefsUrl = cfg.prefsUrl ?? '#';
  const unsubUrl = cfg.unsubUrl ?? '#';
  const esc = (v: string) =>
    String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    '<div data-te-footer="" role="contentinfo" style="margin: 0 0 16px; background-color: #F3F4F6; padding: 28px 24px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; line-height: 1.6; color: #6B7280; text-align: center;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%;">' +
    '<tr><td align="center" style="text-align: center;">' +
    `<div data-footer-part="company" style="font-weight: bold; color: #374151; margin: 0 0 6px;">${esc(company)}</div>` +
    `<div data-footer-part="address" style="margin: 0 0 10px;">${esc(address)}</div>` +
    '<div data-footer-part="links" style="font-size: 12px;">' +
    `<a href="${esc(prefsUrl)}" data-footer-part="prefs" style="color: #2563EB; text-decoration: underline;">Update your preferences</a>` +
    '<span style="color: #9CA3AF; padding: 0 6px;">·</span>' +
    `<a href="${esc(unsubUrl)}" data-footer-part="unsub" style="color: #2563EB; text-decoration: underline;">Unsubscribe</a>` +
    '</div>' +
    '</td></tr>' +
    '</table>' +
    '</div>'
  );
}

interface FooterConfig {
  company: string;
  address: string;
  prefsUrl: string;
  unsubUrl: string;
}

// Events that should mark the document as dirty and trigger a (debounced) sync.
const CHANGE_EVENTS = [
  'component:update',
  'component:add',
  'component:remove',
  'component:clone',
  'component:paste',
  'component:styleUpdate',
  'component:content',
  'block:drag:stop',
  'trait:update',
  'asset:update',
  'undo',
  'redo',
];

/**
 * Inject or remove the mobile responsive CSS into the GrapesJS editor frame.
 * When mobile mode is active, the CSS overrides inline fixed-width styles
 * so email content reflows to fit a 375px viewport.
 */
const MOBILE_CSS_ID = 'te-mobile-responsive';
function injectMobileCss(editor: Editor, mobile: boolean) {
  try {
    const frameDoc = editor.Canvas.getDocument();
    if (!frameDoc) return;
    const existing = frameDoc.getElementById(MOBILE_CSS_ID);
    if (mobile) {
      if (!existing) {
        const style = frameDoc.createElement('style');
        style.id = MOBILE_CSS_ID;
        style.textContent = MOBILE_RESPONSIVE_CSS;
        frameDoc.head.appendChild(style);
      }
    } else {
      if (existing) existing.remove();
    }
  } catch { /* frame may not be ready yet */ }
}

function getDocumentHtml(editor: Editor): string {
  const wrapper = editor.getWrapper();
  if (!wrapper) return '';
  let html = wrapper.toHTML({ asDocument: true, keepInlineStyle: true });
  const css = (editor.getCss() || '').trim();
  if (css) {
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (head) => `${head}\n<style>${css}</style>`);
    } else if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/<body[^>]*>/i, (body) => `<style>${css}</style>${body}`);
    }
  }
  // Strip internal editor scaffolding markers so the saved email HTML stays
  // clean — EXCEPT the explicit Container marker (`data-te-role="container"`),
  // which must survive so the container hierarchy is reconstructed on reload
  // and preserved verbatim on preview/send.
  html = html.replace(/\s+data-te-role=(?:"(?!container|image-wrapper")[^"]*"|'(?!container|image-wrapper')[^']*')/gi, '');
  return html;
}

/* ─── Shared style / attribute helpers ────────────────────────────────────── */

function getCompStyle(comp: Component | null, prop: string): string {
  return String(comp?.getStyle()?.[prop] ?? '');
}

function setCompStyle(comp: Component | null, prop: string, value: string): void {
  if (!comp) return;
  const style = { ...(comp.getStyle() || {}) };
  if (value === '' || value == null) {
    delete style[prop];
  } else {
    style[prop] = String(value);
  }
  comp.setStyle(style);
}

function setCompAttr(comp: Component, name: string, value: string): void {
  if (value === '' || value == null) {
    comp.removeAttributes([name]);
  } else {
    comp.addAttributes({ [name]: value });
  }
}

/** Extract a plain number string from a CSS value like '400px', '100%' or 400. */
function pxToNum(value: unknown): string {
  const n = parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
}

/** Validate a CSS color value before applying it to a component. */
function isValidColorValue(value: string): boolean {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return true;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('background-color', s);
  }
  return /^(rgb|rgba|hsl|hsla)\([^)]*\)$/i.test(s);
}

/**
 * Normalize a button/link URL so it is safe to emit inside an `<a href="…">`.
 *
 *  - strips a leading `#` (and any repeats) users sometimes paste by accident
 *    so `#https://…` becomes `https://…` (never `href="#https://…"`)
 *  - leaves `http://` and `https://` URLs untouched
 *  - optionally upgrades a bare `www.example.com` (or `example.com`) domain to
 *    `https://www.example.com`
 *  - an empty value stays empty so the button remains non-navigating
 *  - placeholder/template tokens like `{{url}}` and protocol-relative `//…`
 *    are left as-is
 */
function normalizeButtonUrl(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let url = s.replace(/^#+/, '').trim();
  if (!url) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
  if (!hasScheme && !url.startsWith('//') && !url.startsWith('{{')) {
    if (url.startsWith('www.')) {
      url = 'https://' + url;
    } else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(url)) {
      url = 'https://' + url;
    }
  }
  return url;
}

/* ─── Email scaffold helpers ──────────────────────────────────────────────── */

interface Scaffold {
  body: Component | null;
  wrapperTable: Component | null;
  wrapperTd: Component | null;
  containerTable: Component | null;
  containerTd: Component | null;
  dropTarget: Component | null;
}

/** Pre-order search for the first descendant component matching the predicate. */
function deepFind(comps: Component[], predicate: (c: Component) => boolean): Component | null {
  for (const c of comps) {
    if (predicate(c)) return c;
    const found = deepFind(c.components().models, predicate);
    if (found) return found;
  }
  return null;
}

const tagIs = (tag: string) => (c: Component): boolean =>
  String(c.get('tagName') || '').toLowerCase() === tag;

/** First `<td>` component inside the first `<tr>` of the given table. */
function firstCellOfTable(table: Component | null): Component | null {
  if (!table) return null;
  const tr = deepFind(table.components().models, tagIs('tr'));
  if (!tr) return null;
  return (
    tr
      .components()
      .models.find((c) => String(c.get('tagName') || '').toLowerCase() === 'td') || null
  );
}

/**
 * Locate the structural email scaffold inside the document. The scaffold is the
 * optional outer wrapper table (email background) plus the explicit Container
 * (the white email card the user added). Elements are found by their
 * `data-te-role` marker first, then structurally (first table in body / first
 * nested table in its first cell) so saved templates whose markers were
 * stripped still work. Traversal is done on the component model tree (not the
 * rendered DOM) so the lookup is deterministic and independent of canvas
 * rendering.
 */
function findScaffold(editor: Editor): Scaffold {
  const wrapper = editor.getWrapper();
  const body = wrapper || null; // the wrapper IS the canvas <body> element
  const bodyComps = wrapper ? wrapper.components().models : [];

  let wrapperTable =
    bodyComps.find(
      (c) => c.getAttributes()?.['data-te-role'] === 'email-wrapper'
    ) || null;
  if (!wrapperTable) {
    wrapperTable = bodyComps.find(tagIs('table')) || null;
  }

  const wrapperTd = wrapperTable
    ? deepFind(wrapperTable.components().models, tagIs('td')) || null
    : null;

  let containerTable = null;
  if (wrapperTable) {
    containerTable =
      deepFind(
        wrapperTable.components().models,
        (c) => c.getAttributes()?.['data-te-role'] === 'container'
      ) || null;
  }
  if (!containerTable && wrapperTable) {
    containerTable =
      deepFind(
        wrapperTable.components().models,
        (c) => c.getAttributes()?.['data-te-role'] === 'email-content'
      ) || null;
  }
  if (!containerTable && wrapperTd) {
    containerTable = deepFind(wrapperTd.components().models, tagIs('table')) || null;
  }

  const containerTd = containerTable ? firstCellOfTable(containerTable) : null;
  const dropTarget = containerTd;

  return { body, wrapperTable, wrapperTd, containerTable, containerTd, dropTarget };
}

/** True when the document currently contains zero email-content blocks. */
function isContentEmpty(editor: Editor): boolean {
  const scaffold = findScaffold(editor);
  if (!scaffold?.body) return true;
  let count = 0;
  scaffold.body.components().models.forEach((c) => {
    if (c !== scaffold.wrapperTable) count += 1;
  });
  const dropTarget = scaffold.dropTarget;
  if (dropTarget) count += dropTarget.components().length;
  else if (scaffold.containerTable) count += scaffold.containerTable.components().length;
  return count === 0;
}

function setTableWidth(comp: Component | null, value: string, pct: boolean): void {
  if (!comp) return;
  const style = { ...(comp.getStyle() || {}) };
  const trimmed = String(value || '').trim();
  const num = parseFloat(trimmed);
  if (Number.isFinite(num) && num > 0) {
    const css = pct ? `${Math.min(num, 100)}%` : `${Math.round(num)}px`;
    style.width = css;
    comp.addAttributes({ width: css });
  } else {
    delete style.width;
    comp.removeAttributes(['width']);
  }
  comp.setStyle(style);
}

/** Expand a CSS `padding` shorthand into its four longhand values. */
function expandPaddingShorthand(
  padding: string
): { top: string; right: string; bottom: string; left: string } {
  const parts = String(padding || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  }
  if (parts.length === 2) {
    return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  }
  if (parts.length === 3) {
    return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  }
  return { top: parts[0] || '', right: parts[1] || '', bottom: parts[2] || '', left: parts[3] || '' };
}

/** Read one padding side of a cell, resolving the `padding` shorthand first. */
function getTdPadding(td: Component | null, prop: string): string {
  const style = td?.getStyle() || {};
  const direct = style[prop];
  if (direct) return pxToNum(direct);
  if (style.padding) {
    const p = expandPaddingShorthand(String(style.padding));
    const map: Record<string, string> = {
      'padding-top': p.top,
      'padding-right': p.right,
      'padding-bottom': p.bottom,
      'padding-left': p.left,
    };
    return pxToNum(map[prop]);
  }
  return '';
}

function setTdPadding(td: Component | null, prop: string, value: string): void {
  if (!td) return;
  const style = { ...(td.getStyle() || {}) };
  // Expand any `padding` shorthand into longhands first so a later longhand
  // edit can never be shadowed by a stale shorthand.
  if (style.padding) {
    const p = expandPaddingShorthand(String(style.padding));
    delete style.padding;
    style['padding-top'] = p.top;
    style['padding-right'] = p.right;
    style['padding-bottom'] = p.bottom;
    style['padding-left'] = p.left;
  }
  if (value === '' || value == null) {
    delete style[prop];
  } else {
    style[prop] = `${parseFloat(value) || 0}px`;
  }
  td.setStyle(style);
}

/* ─── Small reusable property field controls ─────────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div
        style={{
          fontSize: '11px',
          fontWeight: 600,
          color: '#64748B',
          marginBottom: '4px',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 9px',
  border: '1px solid #CBD5E1',
  borderRadius: '7px',
  fontSize: '12.5px',
  color: '#0F172A',
  background: '#FFFFFF',
  outline: 'none',
  boxSizing: 'border-box',
};

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      style={inputStyle}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <select style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  suffix = 'px',
}: {
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <input
        type="number"
        style={inputStyle}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
      />
      <span style={{ fontSize: '11px', color: '#94A3B8', width: '22px', flexShrink: 0 }}>
        {suffix}
      </span>
    </div>
  );
}

const resetBtn: React.CSSProperties = {
  flexShrink: 0,
  width: '30px',
  height: '30px',
  border: '1px solid #CBD5E1',
  borderRadius: '7px',
  background: '#F8FAFC',
  color: '#64748B',
  fontSize: '13px',
  cursor: 'pointer',
  lineHeight: 1,
};

function ColorInput({
  value,
  onChange,
  onReset,
}: {
  value: string;
  onChange: (v: string) => void;
  onReset?: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <input
        type="color"
        style={{
          width: '34px',
          height: '30px',
          padding: '1px',
          border: '1px solid #CBD5E1',
          borderRadius: '7px',
          background: '#FFFFFF',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        value={/^#[0-9a-fA-F]{3,8}$/.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        style={inputStyle}
        value={value}
        placeholder="#RRGGBB"
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {onReset && (
        <button type="button" title="Reset to default" onClick={onReset} style={resetBtn}>
          ↺
        </button>
      )}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        flex: 1,
        padding: '6px 0',
        border: active ? '1px solid #2563EB' : '1px solid #CBD5E1',
        borderRadius: '7px',
        background: active ? '#EFF6FF' : '#FFFFFF',
        color: active ? '#1D4ED8' : '#475569',
        fontSize: '12px',
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function AlignmentButtons({
  value,
  onChange,
  options = TEXT_ALIGNMENTS,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: readonly string[];
}) {
  const labels: Record<string, string> = {
    left: 'Left',
    center: 'Center',
    right: 'Right',
    justify: 'Justify',
  };
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          title={labels[opt] || opt}
          onClick={() => onChange(opt)}
          style={{
            flex: 1,
            padding: '6px 0',
            border: value === opt ? '1px solid #2563EB' : '1px solid #CBD5E1',
            borderRadius: '7px',
            background: value === opt ? '#EFF6FF' : '#FFFFFF',
            color: value === opt ? '#1D4ED8' : '#475569',
            fontSize: '11px',
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {labels[opt] || opt}
        </button>
      ))}
    </div>
  );
}

function TextStyleToggles({
  getStyle,
  setStyle,
}: {
  getStyle: (prop: string) => string;
  setStyle: (prop: string, value: string) => void;
}) {
  const isBold = () => {
    const w = getStyle('font-weight').trim().toLowerCase();
    return w === 'bold' || (parseInt(w, 10) >= 600);
  };
  const isItalic = () =>
    ['italic', 'oblique'].includes(getStyle('font-style').trim().toLowerCase());
  const isUnderline = () =>
    getStyle('text-decoration').trim().toLowerCase().includes('underline');
  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
      <ToggleBtn active={isBold()} title="Bold" onClick={() => setStyle('font-weight', isBold() ? 'normal' : 'bold')}>
        B
      </ToggleBtn>
      <ToggleBtn active={isItalic()} title="Italic" onClick={() => setStyle('font-style', isItalic() ? 'normal' : 'italic')}>
        I
      </ToggleBtn>
      <ToggleBtn
        active={isUnderline()}
        title="Underline"
        onClick={() => setStyle('text-decoration', isUnderline() ? 'none' : 'underline')}
      >
        U
      </ToggleBtn>
    </div>
  );
}

function SpacingFields({
  getStyle,
  setStyle,
}: {
  getStyle: (prop: string) => string;
  setStyle: (prop: string, value: string) => void;
}) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        {(['top', 'right', 'bottom', 'left'] as const).map((p) => (
          <Field key={p} label={`Padding ${p}`}>
            <NumberInput
              value={pxToNum(getStyle(`padding-${p}`))}
              onChange={(v) => setStyle(`padding-${p}`, v ? `${parseFloat(v) || 0}px` : '')}
              min={0}
              max={200}
            />
          </Field>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Margin Top">
          <NumberInput
            value={pxToNum(getStyle('margin-top'))}
            onChange={(v) => setStyle('margin-top', v ? `${parseFloat(v) || 0}px` : '')}
            min={-60}
            max={200}
          />
        </Field>
        <Field label="Margin Bottom">
          <NumberInput
            value={pxToNum(getStyle('margin-bottom'))}
            onChange={(v) => setStyle('margin-bottom', v ? `${parseFloat(v) || 0}px` : '')}
            min={-60}
            max={200}
          />
        </Field>
      </div>
    </div>
  );
}

function BorderFields({
  getStyle,
  setStyle,
}: {
  getStyle: (prop: string) => string;
  setStyle: (prop: string, value: string) => void;
}) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Border Width">
          <NumberInput
            value={pxToNum(getStyle('border-width'))}
            onChange={(v) => {
              const n = parseFloat(v);
              const w = Number.isFinite(n) && n > 0 ? `${n}px` : '';
              setStyle('border-width', w);
              setStyle('border-style', w ? 'solid' : '');
            }}
            min={0}
            max={40}
          />
        </Field>
        <Field label="Border Radius">
          <NumberInput
            value={pxToNum(getStyle('border-radius'))}
            onChange={(v) => setStyle('border-radius', v ? `${parseFloat(v) || 0}px` : '')}
            min={0}
            max={100}
          />
        </Field>
      </div>
      <Field label="Border Color">
        <ColorInput
          value={getStyle('border-color')}
          onChange={(v) => setStyle('border-color', v)}
          onReset={() => setStyle('border-color', '')}
        />
      </Field>
    </div>
  );
}

/* ─── Properties (right sidebar) panel ───────────────────────────────────── */

const TEXT_TAGS = ['div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'li'];
const SECTION_TAGS = ['table', 'tbody', 'tr', 'td', 'th', 'section'];

function getTag(component: Component | null): string {
  return String(component?.get('tagName') || '').toLowerCase();
}

function isTextLike(component: Component | null): boolean {
  if (!component) return false;
  if (component.is('text')) return true;
  const tag = getTag(component);
  return TEXT_TAGS.includes(tag);
}

function isImageLike(component: Component | null): boolean {
  if (!component) return false;
  if (component.is('image')) return true;
  return getTag(component) === 'img';
}

function isSectionLike(component: Component | null): boolean {
  if (!component) return false;
  const tag = getTag(component);
  return SECTION_TAGS.includes(tag);
}

function isButtonLike(component: Component | null): boolean {
  return getTag(component) === 'a';
}

/** True when the component is (or wraps) the configurable "Social" block. */
function isSocialContainer(component: Component | null): boolean {
  return !!component?.getAttributes()?.[SOCIAL_DATA_ATTR];
}

/** Walk up the component tree to find the enclosing social block, if any. */
function findSocialContainer(component: Component | null): Component | null {
  let current: Component | null = component;
  while (current) {
    if (isSocialContainer(current)) return current;
    current = current.parent() as Component | null;
  }
  return null;
}

/** True when the component is (or wraps) the configurable "Footer" block. */
function isFooterContainer(component: Component | null): boolean {
  return !!component?.getAttributes()?.['data-te-footer'];
}

/** Walk up the component tree to find the enclosing footer block, if any. */
function findFooterContainer(component: Component | null): Component | null {
  let current: Component | null = component;
  while (current) {
    if (isFooterContainer(current)) return current;
    current = current.parent() as Component | null;
  }
  return null;
}

/** Recursively find the first descendant carrying `data-footer-part="name"`. */
function findFooterPart(root: Component | null, name: string): Component | null {
  if (!root) return null;
  const walk = (comps: Component[]): Component | null => {
    for (const c of comps) {
      if (c.getAttributes()?.['data-footer-part'] === name) return c;
      const found = walk(c.components().models);
      if (found) return found;
    }
    return null;
  };
  return walk(root.components().models);
}

/** Index of an icon anchor inside its social block (matches the icons array). */
function socialIconIndex(icon: Component): number {
  const wrapper = icon.parent();
  if (!wrapper) return -1;
  const td = wrapper.parent();
  if (!td) return -1;
  return td.components().models.indexOf(wrapper);
}

interface PropertiesPanelProps {
  editor: Editor | null;
  component: Component | null;
  tick: number;
  onError: (message: string) => void;
}

/* ─── Email Settings panel (shown when nothing is selected) ─────────────── */

function EmailSettingsPanel({ editor, tick }: { editor: Editor; tick: number }) {
  void tick;
  const scaffold = findScaffold(editor);
  const { body, wrapperTable, wrapperTd, containerTable, containerTd } = scaffold;
  const bodyStyle = body?.getStyle() || {};
  const wrapperStyle = wrapperTable?.getStyle() || {};
  const contentStyle = containerTable?.getStyle() || {};

  const setBody = (prop: string, v: string) => setCompStyle(body, prop, v);
  const setWrapper = (prop: string, v: string) => setCompStyle(wrapperTable, prop, v);
  const setContent = (prop: string, v: string) => setCompStyle(containerTable, prop, v);
  const setWrapperTd = (prop: string, v: string) => setCompStyle(wrapperTd, prop, v);

  const defaultBg = '#FAFAFA';
  const defaultContentBg = '#FFFFFF';
  const defaultTextColor = '#374151';

  return (
    <div style={{ padding: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0F172A' }}>Email Settings</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>Global settings for this email</div>
        </div>
      </div>

      <Field label="Email Background Color">
        <ColorInput
          value={getCompStyle(body, 'background-color') || defaultBg}
          onChange={(v) => {
            if (isValidColorValue(v)) {
              setBody('background-color', v);
              setWrapper('background-color', v);
              setWrapperTd('background-color', v);
            }
          }}
          onReset={() => {
            setBody('background-color', defaultBg);
            setWrapper('background-color', defaultBg);
            setWrapperTd('background-color', defaultBg);
          }}
        />
      </Field>
      <Field label="Content Background Color">
        <ColorInput
          value={getCompStyle(containerTable, 'background-color') || defaultContentBg}
          onChange={(v) => {
            if (isValidColorValue(v)) setContent('background-color', v);
          }}
          onReset={() => setContent('background-color', defaultContentBg)}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Email Width">
          <NumberInput
            value={pxToNum(wrapperStyle.width) || '100'}
            onChange={(v) => setTableWidth(wrapperTable, v, true)}
            min={50}
            max={100}
            suffix="%"
          />
        </Field>
        <Field label="Content Width">
          <NumberInput
            value={pxToNum(contentStyle.width) || '600'}
            onChange={(v) => setTableWidth(containerTable, v, false)}
            min={200}
            max={1200}
            suffix="px"
          />
        </Field>
      </div>

      <Field label="Default Font Family">
        <SelectInput
          value={getCompStyle(body, 'font-family') || FONT_FAMILIES[0]}
          onChange={(v) => setBody('font-family', v)}
          options={FONT_FAMILIES}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Default Text Color">
          <ColorInput
            value={getCompStyle(body, 'color') || defaultTextColor}
            onChange={(v) => {
              if (isValidColorValue(v)) setBody('color', v);
            }}
            onReset={() => setBody('color', defaultTextColor)}
          />
        </Field>
        <Field label="Default Font Size">
          <NumberInput
            value={pxToNum(bodyStyle['font-size']) || '15'}
            onChange={(v) => setBody('font-size', v ? `${parseFloat(v) || 0}px` : '')}
            min={8}
            max={40}
            suffix="px"
          />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Top Padding">
          <NumberInput
            value={getTdPadding(containerTd, 'padding-top')}
            onChange={(v) => setTdPadding(containerTd, 'padding-top', v)}
            min={0}
            max={200}
          />
        </Field>
        <Field label="Bottom Padding">
          <NumberInput
            value={getTdPadding(containerTd, 'padding-bottom')}
            onChange={(v) => setTdPadding(containerTd, 'padding-bottom', v)}
            min={0}
            max={200}
          />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Left Padding">
          <NumberInput
            value={getTdPadding(containerTd, 'padding-left')}
            onChange={(v) => setTdPadding(containerTd, 'padding-left', v)}
            min={0}
            max={200}
          />
        </Field>
        <Field label="Right Padding">
          <NumberInput
            value={getTdPadding(containerTd, 'padding-right')}
            onChange={(v) => setTdPadding(containerTd, 'padding-right', v)}
            min={0}
            max={200}
          />
        </Field>
      </div>

      <div
        style={{
          fontSize: '11px',
          color: '#94A3B8',
          lineHeight: 1.5,
          marginTop: '4px',
          padding: '8px 10px',
          background: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '8px',
        }}
      >
        Defaults apply to the overall email and to new content added to the canvas.
        Existing blocks keep their own styling. The Container (the white email card)
        owns the width and padding; block padding lives on each block.
      </div>
    </div>
  );
}

/* ─── Image property helpers ─────────────────────────────────────────────── */

/** True when a numeric dimension lives in the image's inline style. */
function hasStyleDim(component: Component, prop: 'width' | 'height'): boolean {
  return !!pxToNum(component.getStyle()[prop]);
}

/** Read an image dimension from inline style first, then from the HTML attribute. */
function getImageDim(component: Component, prop: 'width' | 'height'): string {
  const fromStyle = pxToNum(component.getStyle()[prop]);
  if (fromStyle) return fromStyle;
  return String(component.getAttributes()[prop] ?? '').trim();
}

/**
 * Apply a width/height value to the selected image. The value is written to
 * BOTH the inline CSS (e.g. `width: 400px`) and the HTML width/height
 * attribute so it survives email delivery and re-parsing. An empty value
 * removes the dimension. When only width changes and no explicit height has
 * been set, the image keeps its proportions (height -> auto).
 */
function setImageDim(component: Component, prop: 'width' | 'height', value: string): void {
  const style = { ...(component.getStyle() || {}) };
  const other = prop === 'width' ? 'height' : 'width';
  const num = parseFloat(value);
  const hasVal = Number.isFinite(num) && num > 0;

  if (hasVal) {
    style[prop] = `${num}px`;
  } else {
    delete style[prop];
  }

  // Single-dimension edits preserve proportions unless the other dimension was
  // explicitly set (dimension -> auto, and any stale attribute is dropped so it
  // cannot override the proportional scaling in email clients).
  if (!hasStyleDim(component, other)) {
    style[other] = 'auto';
    component.removeAttributes([other]);
  }

  // Override any existing max-width/max-height (e.g. `max-width: 600px` from a
  // template, or `maxWidth` camelCase from a block) so the size the user just
  // entered actually applies. `max-width: 100%` still keeps the image inside
  // its email container when the surrounding column is narrower than requested.
  style['max-width'] = '100%';
  delete style['max-height'];
  delete style.maxWidth;
  delete style.maxHeight;

  // When an explicit width is set, use display:block + margin:auto for proper
  // email-client centre alignment.  When the width is cleared (Auto), revert to
  // inline-block so the image keeps its intrinsic size and doesn't stretch.
  if (hasVal && prop === 'width') {
    style.display = 'block';
    style['margin-left'] = 'auto';
    style['margin-right'] = 'auto';
  } else if (!hasVal && prop === 'width') {
    style.display = 'inline-block';
    delete style['margin-left'];
    delete style['margin-right'];
  }

  component.setStyle(style);

  if (hasVal) {
    component.addAttributes({ [prop]: String(Math.round(num)) });
  } else {
    component.removeAttributes([prop]);
  }
}

/** Read the current alignment of an image from its inline styles. */
function getImageAlignment(component: Component): string {
  const style = component.getStyle();
  const ta = String(style['text-align'] ?? '').trim();
  if (ta === 'left' || ta === 'center' || ta === 'right') return ta;
  const ml = String(style['margin-left'] ?? '').trim();
  const mr = String(style['margin-right'] ?? '').trim();
  if (ml === 'auto' && mr === 'auto') return 'center';
  if (ml === 'auto') return 'right';
  const m = String(style.margin ?? '').trim();
  if (m) {
    const parts = m.split(/\s+/);
    if (parts.length === 2 && parts[1] === 'auto') return 'center';
    if (parts.length === 3 && parts[1] === 'auto' && parts[0] === '0') return 'center';
    if (parts.length === 4 && parts[1] === 'auto' && parts[3] === 'auto') return 'center';
    if (parts.length === 4 && parts[1] === 'auto') return 'right';
  }
  return 'left';
}

/** Apply an alignment to an image. */
function setImageAlignment(component: Component, value: string): void {
  const align = (IMAGE_ALIGNMENTS as readonly string[]).includes(value) ? value : 'left';

  // Set alignment on the IMAGE element itself (display: inline-block).
  const imgStyle = { ...(component.getStyle() || {}) };
  imgStyle.display = 'inline-block';
  const marginTop = imgStyle['margin-top'];
  const marginBottom = imgStyle['margin-bottom'];
  delete imgStyle.margin;
  delete imgStyle['margin-left'];
  delete imgStyle['margin-right'];
  if (marginTop) imgStyle['margin-top'] = marginTop;
  if (marginBottom) imgStyle['margin-bottom'] = marginBottom;
  component.setStyle(imgStyle);

  // Also set text-align on the image-wrapper parent so the wrapper centres
  // or left/right-aligns the inline-block <img>.
  const wrapper = (component as any).parent?.();
  if (wrapper && wrapper.getAttributes?.()?.['data-te-role'] === 'image-wrapper') {
    const ws = { ...(wrapper.getStyle() || {}) };
    ws['text-align'] = align;
    wrapper.setStyle(ws);
  }
}

/* ─── Paragraph block helpers ────────────────────────────────────────────── */

const PARAGRAPH_POSITIONS = ['left', 'center', 'right'] as const;

/** Expand a CSS `margin` shorthand into its four longhand values. */
function expandMarginShorthand(
  margin: string
): { top: string; right: string; bottom: string; left: string } {
  const parts = String(margin || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] };
  }
  if (parts.length === 2) {
    return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] };
  }
  if (parts.length === 3) {
    return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] };
  }
  return { top: parts[0] || '', right: parts[1] || '', bottom: parts[2] || '', left: parts[3] || '' };
}

/**
 * Read the current horizontal block position of a paragraph from its margins.
 * The paragraph block is positioned with left/right auto margins — this is
 * intentionally separate from `text-align` (which only aligns the text inside
 * the paragraph).
 */
function getParagraphBlockPosition(component: Component): string {
  const style = component.getStyle() || {};
  let ml = String(style['margin-left'] || '').trim();
  let mr = String(style['margin-right'] || '').trim();
  if (!ml && !mr && style.margin) {
    const m = expandMarginShorthand(String(style.margin));
    ml = m.left;
    mr = m.right;
  }
  if (ml === 'auto' && mr === 'auto') return 'center';
  if (ml === 'auto') return 'right';
  return 'left';
}

/**
 * Position the whole paragraph block (its box) inside the email content
 * container. Margin top/bottom are preserved (longhand first, then `margin`
 * shorthand); any `margin` shorthand is expanded into longhands so the
 * positioning rules can never be overridden by a stale shorthand.
 * `text-align` is left untouched.
 */
function setParagraphBlockPosition(component: Component, value: string): void {
  const style = { ...(component.getStyle() || {}) };
  const shorthand = expandMarginShorthand(String(style.margin || ''));
  const marginTop = style['margin-top'] || shorthand.top;
  const marginBottom = style['margin-bottom'] || shorthand.bottom;
  delete style.margin;
  delete style['margin-left'];
  delete style['margin-right'];
  style['margin-top'] = marginTop;
  style['margin-bottom'] = marginBottom;
  const pos = (PARAGRAPH_POSITIONS as readonly string[]).includes(value) ? value : 'left';
  if (pos === 'center') {
    style['margin-left'] = 'auto';
    style['margin-right'] = 'auto';
  } else if (pos === 'right') {
    style['margin-left'] = 'auto';
    style['margin-right'] = '0';
  } else {
    style['margin-left'] = '0';
    style['margin-right'] = '0';
  }
  component.setStyle(style);
}

/** Wrap an image inside an <a> link so it becomes clickable (no nested links). */
function wrapImageInLink(comp: any, href: string): void {
  const parent = comp.parent();
  if (!parent) return;
  const at = parent.components().indexOf(comp);
  const added = parent.components().add('<a></a>', { at });
  const link = Array.isArray(added) ? added[0] : added;
  if (!link) return;
  link.addAttributes({ href, style: 'display: block; text-decoration: none;' });
  link.append(comp);
}

/** Remove the surrounding <a> wrapper and keep the image in place. */
function unwrapImageFromLink(comp: any): void {
  const link = comp.parent();
  if (!link || !link.is('link')) return;
  const parent = link.parent();
  if (!parent) return;
  const at = parent.components().indexOf(link);
  const children = link.components().models.slice();
  for (const child of children) {
    const coll = child.collection;
    if (coll) coll.remove(child, { temporary: true });
  }
  if (children.length) parent.components().add(children, { at });
  link.remove();
}

/* ─── Social block (properties) panel ───────────────────────────────────── */

function SocialIconPreview({ id, size = 20, fill }: { id: string; size?: number; fill?: string }) {
  const platform = platformById(id);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: platform.svgInner(fill || platform.brandColor) }}
    />
  );
}

const socialSectionLabel: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: '#64748B',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  margin: '0 0 8px',
  paddingBottom: '5px',
  borderBottom: '1px solid #E2E8F0',
};

function SocialPropertiesPanel({
  editor,
  component,
  socialRoot,
  tick,
}: {
  editor: Editor;
  component: Component;
  socialRoot: Component;
  tick: number;
}) {
  void tick;
  const [libOpen, setLibOpen] = useState(false);
  const [localEditingIdx, setLocalEditingIdx] = useState(-1);
  const [dragIdx, setDragIdx] = useState(-1);
  const [overIdx, setOverIdx] = useState(-1);

  const getConfig = (): SocialConfig =>
    parseSocialConfig(socialRoot.getAttributes()[SOCIAL_DATA_ATTR]);

  const updateConfig = (next: SocialConfig) => {
    socialRoot.addAttributes({ [SOCIAL_DATA_ATTR]: JSON.stringify(next) });
    // Rebuild the cell content in place. GrapesJS's HTML parser drops a bare
    // `<tr>`/`<td>` fragment (they are invalid outside a full `<table>`), which
    // would strip the cell's `align` attribute and leave the icons stuck to the
    // left. Updating the existing `<td>` keeps the email-safe table structure
    // and lets the alignment actually take effect.
    const tr = deepFind(socialRoot.components().models, tagIs('tr'));
    const cell = tr
      ? tr.components().models.find(tagIs('td')) || null
      : null;
    if (cell) {
      cell.addAttributes({ align: next.align });
      cell.addStyle({ padding: '0', 'font-size': '0', 'line-height': '0' });
      cell.removeClass('cell');
      cell.components(buildSocialIconsHtml(next));
    } else {
      // The block's table structure was already malformed (e.g. saved before
      // this fix), so rebuild the entire block to restore the table/cell.
      const parent = socialRoot.parent();
      const at = parent ? socialRoot.index() : 0;
      const style = socialRoot.getStyle() || {};
      if (parent) {
        parent.components().remove(socialRoot);
        const added = parent.components().add(buildSocialBlockHtml(next), { at });
        const rebuilt = (Array.isArray(added) ? added[0] : added) as Component | null;
        if (rebuilt) {
          rebuilt.addStyle(style);
          editor.select(rebuilt);
          return;
        }
      }
      socialRoot.components(buildSocialRowHtml(next));
    }
    editor.select(socialRoot);
  };

  // Clicking an individual icon on the canvas expands its settings in the list.
  const selectedIconIdx =
    component !== socialRoot &&
    getTag(component) === 'a' &&
    findSocialContainer(component) === socialRoot
      ? socialIconIndex(component)
      : -1;
  const editingIdx = selectedIconIdx >= 0 ? selectedIconIdx : localEditingIdx;

  const config = getConfig();
  const icons = config.icons;

  const updateIcon = (idx: number, patch: Partial<SocialIconItem>) => {
    const cfg = getConfig();
    if (!cfg.icons[idx]) return;
    cfg.icons[idx] = { ...cfg.icons[idx], ...patch };
    updateConfig(cfg);
    setLocalEditingIdx(idx);
  };

  const removeIcon = (idx: number) => {
    const cfg = getConfig();
    cfg.icons = cfg.icons.filter((_, i) => i !== idx);
    updateConfig(cfg);
    setLocalEditingIdx(-1);
  };

  const addIcon = (id: string) => {
    const cfg = getConfig();
    if (cfg.icons.some((ic) => ic.id === id)) return;
    const platform = platformById(id);
    cfg.icons.push({
      id,
      url: platform.defaultUrl,
      size: cfg.size,
      color: cfg.color,
      bg: cfg.bg || platform.brandColor,
      shape: cfg.shape,
      radius: cfg.radius,
    });
    updateConfig(cfg);
    setLocalEditingIdx(cfg.icons.length - 1);
    setLibOpen(false);
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const cfg = getConfig();
    const [item] = cfg.icons.splice(from, 1);
    cfg.icons.splice(to, 0, item);
    updateConfig(cfg);
    if (localEditingIdx === from) setLocalEditingIdx(to);
    else if (localEditingIdx === to) setLocalEditingIdx(from);
  };

  const setBlock = (patch: Partial<SocialConfig>) => {
    updateConfig({ ...getConfig(), ...patch });
  };

  const applyIconStyleToAll = (
    key: 'size' | 'color' | 'bg' | 'shape' | 'radius',
    value: string | number
  ) => {
    const patch = { [key]: value } as Partial<SocialIconItem>;
    const cfg = getConfig();
    updateConfig({
      ...cfg,
      ...(patch as Partial<SocialConfig>),
      icons: cfg.icons.map((ic) => ({ ...ic, ...patch })),
    });
  };

  // Header actions always act on the whole social block.
  const block = socialRoot;
  const moveBlockUp = () => {
    if (block.parent() && block.index() > 0) block.move(block.parent() as Component, { at: block.index() - 1 });
  };
  const moveBlockDown = () => {
    if (block.parent()) block.move(block.parent() as Component, { at: block.index() + 1 });
  };
  const duplicateBlock = () => {
    if (!block.parent()) return;
    const clone = block.clone();
    block.parent()?.append(clone, { at: block.index() + 1 });
    editor.select(clone);
  };
  const removeBlock = () => {
    if (window.confirm('Delete this element from the email?')) block.remove();
  };

  const getStyle = (prop: string) => getCompStyle(block, prop);
  const setStyle = (prop: string, value: string) => setCompStyle(block, prop, value);

  return (
    <div style={{ padding: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0F172A' }}>Social Properties</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>Social block</div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" title="Move block up" onClick={moveBlockUp} style={iconBtn}>↑</button>
          <button type="button" title="Move block down" onClick={moveBlockDown} style={iconBtn}>↓</button>
          <button type="button" title="Duplicate block" onClick={duplicateBlock} style={iconBtn}>⧉</button>
          <button type="button" title="Delete social block" onClick={removeBlock} style={smallBtn('#FEF2F2', '#DC2626', '#FECACA')}>
            Delete
          </button>
        </div>
      </div>

      <div style={socialSectionLabel}>Social Icons</div>

      {icons.length === 0 && (
        <div
          style={{
            fontSize: '12px',
            color: '#64748B',
            lineHeight: 1.5,
            padding: '8px 10px',
            background: '#F8FAFC',
            border: '1px dashed #CBD5E1',
            borderRadius: '8px',
            marginBottom: '8px',
          }}
        >
          No icons yet — click “+ Add Social Icon” to add your first social link.
        </div>
      )}

      {icons.map((ic, idx) => {
        const platform = platformById(ic.id);
        const expanded = editingIdx === idx;
        const dragging = dragIdx === idx;
        const isOver = overIdx === idx && dragIdx >= 0 && dragIdx !== idx;
        return (
          <div key={`${ic.id}-${idx}`} style={{ marginBottom: '8px' }}>
            <div
              draggable
              onDragStart={(e) => {
                setDragIdx(idx);
                setOverIdx(-1);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIdx !== idx) setOverIdx(idx);
              }}
              onDragLeave={() => {
                if (overIdx === idx) setOverIdx(-1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx >= 0) reorder(dragIdx, idx);
                setDragIdx(-1);
                setOverIdx(-1);
              }}
              onDragEnd={() => {
                setDragIdx(-1);
                setOverIdx(-1);
              }}
              onClick={() => {
                editor.select(socialRoot);
                setLocalEditingIdx(expanded ? -1 : idx);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 8px',
                border: '1px solid #CBD5E1',
                borderRadius: '8px',
                background: isOver ? '#EFF6FF' : dragging ? '#DBEAFE' : expanded ? '#F8FAFC' : '#FFFFFF',
                cursor: 'pointer',
                opacity: dragging ? 0.6 : 1,
              }}
              title={expanded ? 'Click to collapse settings' : 'Click to edit icon settings — drag to reorder'}
            >
              <span style={{ cursor: 'grab', color: '#94A3B8', fontSize: '13px', userSelect: 'none', lineHeight: 1 }}>
                ⠿
              </span>
              <SocialIconPreview
                id={ic.id}
                size={20}
                fill={ic.shape === 'none' ? ic.color || platform.brandColor : ic.color || '#FFFFFF'}
              />
              <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {platform.label}
              </span>
              <input
                type="text"
                value={ic.url}
                onChange={(e) => updateIcon(idx, { url: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                placeholder={platform.defaultUrl}
                spellCheck={false}
                style={{ width: '42%', ...inputStyle, padding: '5px 7px' }}
              />
              <button
                type="button"
                title="Remove icon"
                onClick={(e) => {
                  e.stopPropagation();
                  removeIcon(idx);
                }}
                style={{ ...iconBtn, width: '26px', height: '26px', color: '#DC2626', borderColor: '#FECACA', background: '#FEF2F2' }}
              >
                ✕
              </button>
            </div>
            {expanded && (
              <div
                style={{
                  padding: '10px',
                  border: '1px solid #E2E8F0',
                  borderRadius: '8px',
                  background: '#FFFFFF',
                  marginTop: '6px',
                }}
              >
                <Field label="Platform">
                  <SelectInput
                    value={ic.id}
                    onChange={(v) => {
                      const next = platformById(v);
                      updateIcon(idx, { id: v, url: next.defaultUrl });
                    }}
                    options={SOCIAL_PLATFORMS.map((p) => p.id)}
                  />
                </Field>
                <Field label="URL">
                  <TextInput value={ic.url} onChange={(v) => updateIcon(idx, { url: v })} placeholder={platform.defaultUrl} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                  <Field label="Icon size">
                    <NumberInput
                      value={String(ic.size || '')}
                      onChange={(v) => updateIcon(idx, { size: parseFloat(v) || 0 })}
                      min={12}
                      max={96}
                    />
                  </Field>
                  <Field label="Icon color">
                    <ColorInput
                      value={ic.color}
                      onChange={(v) => {
                        if (isValidColorValue(v)) updateIcon(idx, { color: v });
                      }}
                      onReset={() => updateIcon(idx, { color: '#FFFFFF' })}
                    />
                  </Field>
                </div>
                <Field label="Background color">
                  <ColorInput
                    value={ic.bg}
                    onChange={(v) => {
                      if (isValidColorValue(v)) updateIcon(idx, { bg: v });
                    }}
                    onReset={() => updateIcon(idx, { bg: platform.brandColor })}
                  />
                </Field>
                <Field label="Shape">
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <ToggleBtn active={ic.shape === 'circle'} onClick={() => updateIcon(idx, { shape: 'circle' })}>Circle</ToggleBtn>
                    <ToggleBtn active={ic.shape === 'square'} onClick={() => updateIcon(idx, { shape: 'square' })}>Square</ToggleBtn>
                    <ToggleBtn active={ic.shape === 'none'} onClick={() => updateIcon(idx, { shape: 'none' })}>No background</ToggleBtn>
                  </div>
                </Field>
                {ic.shape === 'square' && (
                  <Field label="Border radius">
                    <NumberInput
                      value={ic.radius ? pxToNum(ic.radius) : ''}
                      onChange={(v) => updateIcon(idx, { radius: v ? `${parseFloat(v) || 0}px` : '' })}
                      min={0}
                      max={100}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => setLibOpen((o) => !o)}
        style={{ ...smallBtn('#2563EB', '#FFFFFF', '#2563EB'), width: '100%', marginBottom: libOpen ? '8px' : '12px' }}
      >
        {libOpen ? '− Hide Icon Library' : '+ Add Social Icon'}
      </button>

      {libOpen && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '6px',
            marginBottom: '12px',
            padding: '8px',
            border: '1px solid #E2E8F0',
            borderRadius: '10px',
            background: '#F8FAFC',
          }}
        >
          {SOCIAL_PLATFORMS.map((p) => {
            const used = icons.some((ic) => ic.id === p.id);
            return (
              <button
                key={p.id}
                type="button"
                disabled={used}
                onClick={() => addIcon(p.id)}
                title={used ? `${p.label} is already added` : `Add ${p.label}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '8px 4px',
                  border: used ? '1px dashed #CBD5E1' : '1px solid #CBD5E1',
                  borderRadius: '8px',
                  background: used ? '#EEF2F7' : '#FFFFFF',
                  color: used ? '#94A3B8' : '#0F172A',
                  fontSize: '10.5px',
                  fontWeight: 600,
                  cursor: used ? 'not-allowed' : 'pointer',
                }}
              >
                <SocialIconPreview id={p.id} size={18} fill={p.brandColor} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                  {p.label}
                </span>
                {used && <span style={{ fontSize: '9px', color: '#94A3B8' }}>added</span>}
              </button>
            );
          })}
        </div>
      )}

      <div style={socialSectionLabel}>Icon Styling</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Icon size">
          <NumberInput
            value={String(config.size || '')}
            onChange={(v) => applyIconStyleToAll('size', parseFloat(v) || 0)}
            min={12}
            max={96}
          />
        </Field>
        <Field label="Icon color">
          <ColorInput
            value={config.color}
            onChange={(v) => {
              if (isValidColorValue(v)) applyIconStyleToAll('color', v);
            }}
            onReset={() => applyIconStyleToAll('color', '#FFFFFF')}
          />
        </Field>
      </div>
      <Field label="Background color">
        <ColorInput
          value={config.bg}
          onChange={(v) => {
            if (isValidColorValue(v)) applyIconStyleToAll('bg', v);
          }}
          onReset={() => applyIconStyleToAll('bg', '')}
        />
      </Field>
      <Field label="Shape">
        <div style={{ display: 'flex', gap: '4px' }}>
          <ToggleBtn active={config.shape === 'circle'} onClick={() => applyIconStyleToAll('shape', 'circle')}>Circle</ToggleBtn>
          <ToggleBtn active={config.shape === 'square'} onClick={() => applyIconStyleToAll('shape', 'square')}>Square</ToggleBtn>
          <ToggleBtn active={config.shape === 'none'} onClick={() => applyIconStyleToAll('shape', 'none')}>No background</ToggleBtn>
        </div>
      </Field>
      {config.shape === 'square' && (
        <Field label="Border radius">
          <NumberInput
            value={config.radius ? pxToNum(config.radius) : ''}
            onChange={(v) => applyIconStyleToAll('radius', v ? `${parseFloat(v) || 0}px` : '')}
            min={0}
            max={100}
          />
        </Field>
      )}
      <Field label="Spacing">
        <NumberInput
          value={String(config.spacing || '')}
          onChange={(v) => setBlock({ spacing: parseFloat(v) || 0 })}
          min={0}
          max={60}
        />
      </Field>
      <Field label="Alignment">
        <AlignmentButtons
          value={config.align}
          onChange={(v) => setBlock({ align: v as SocialAlign })}
          options={IMAGE_ALIGNMENTS}
        />
      </Field>
      <Field label="Show labels">
        <div style={{ display: 'flex', gap: '4px' }}>
          <ToggleBtn active={!!config.showLabels} onClick={() => setBlock({ showLabels: !config.showLabels })}>
            {config.showLabels ? 'On' : 'Off'}
          </ToggleBtn>
        </div>
      </Field>

      <div style={socialSectionLabel}>Block Spacing</div>
      <SpacingFields getStyle={getStyle} setStyle={setStyle} />
    </div>
  );
}

/* ─── Footer block (properties) panel ───────────────────────────────────── */

function FooterPropertiesPanel({
  editor,
  footerRoot,
  tick,
}: {
  editor: Editor;
  component: Component;
  footerRoot: Component;
  tick: number;
}) {
  void tick;

  const companyComp = findFooterPart(footerRoot, 'company');
  const addressComp = findFooterPart(footerRoot, 'address');
  const prefsComp = findFooterPart(footerRoot, 'prefs');
  const unsubComp = findFooterPart(footerRoot, 'unsub');
  const cellComp = footerRoot.find('td').length ? footerRoot.find('td')[0] : null;

  const getStyle = (prop: string) => getCompStyle(footerRoot, prop);
  const setStyle = (prop: string, value: string) => setCompStyle(footerRoot, prop, value);

  const setCompanyName = (v: string) => {
    if (companyComp) companyComp.set('content', v);
  };
  const setAddress = (v: string) => {
    if (addressComp) addressComp.set('content', v);
  };
  const setLinkUrl = (comp: Component | null, v: string) => {
    if (comp) setCompAttr(comp, 'href', v);
  };

  const setAlignment = (value: string) => {
    setStyle('text-align', value);
    if (cellComp) cellComp.addAttributes({ align: value });
  };

  const getContent = (comp: Component | null): string => {
    if (!comp) return '';
    const content = comp.get('content');
    return typeof content === 'string' ? content : '';
  };

  // Move / duplicate / delete act on the whole footer block.
  const block = footerRoot;
  const moveBlockUp = () => {
    if (block.parent() && block.index() > 0) block.move(block.parent() as Component, { at: block.index() - 1 });
  };
  const moveBlockDown = () => {
    if (block.parent()) block.move(block.parent() as Component, { at: block.index() + 1 });
  };
  const duplicateBlock = () => {
    if (!block.parent()) return;
    const clone = block.clone();
    block.parent()?.append(clone, { at: block.index() + 1 });
    editor.select(clone);
  };
  const removeBlock = () => {
    if (window.confirm('Delete this element from the email?')) block.remove();
  };

  return (
    <div style={{ padding: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0F172A' }}>Footer Properties</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>Email footer block</div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" title="Move block up" onClick={moveBlockUp} style={iconBtn}>↑</button>
          <button type="button" title="Move block down" onClick={moveBlockDown} style={iconBtn}>↓</button>
          <button type="button" title="Duplicate block" onClick={duplicateBlock} style={iconBtn}>⧉</button>
          <button
            type="button"
            title="Delete footer block"
            onClick={removeBlock}
            style={smallBtn('#FEF2F2', '#DC2626', '#FECACA')}
          >
            Delete
          </button>
        </div>
      </div>

      <Field label="Background Color">
        <ColorInput
          value={getStyle('background-color') || '#F3F4F6'}
          onChange={(v) => {
            if (isValidColorValue(v)) setStyle('background-color', v);
          }}
          onReset={() => setStyle('background-color', '#F3F4F6')}
        />
      </Field>
      <Field label="Text Color">
        <ColorInput
          value={getStyle('color') || '#6B7280'}
          onChange={(v) => {
            if (isValidColorValue(v)) setStyle('color', v);
          }}
          onReset={() => setStyle('color', '#6B7280')}
        />
      </Field>
      <Field label="Font Family">
        <SelectInput
          value={getStyle('font-family') || 'Arial, Helvetica, sans-serif'}
          onChange={(v) => setStyle('font-family', v)}
          options={FONT_FAMILIES}
        />
      </Field>
      <Field label="Font Size">
        <NumberInput
          value={pxToNum(getStyle('font-size')) || '12'}
          onChange={(v) => setStyle('font-size', v ? `${parseFloat(v) || 0}px` : '')}
          min={8}
          max={40}
        />
      </Field>
      <Field label="Alignment">
        <AlignmentButtons value={getStyle('text-align') || 'center'} onChange={setAlignment} />
      </Field>

      <div style={socialSectionLabel}>Content</div>
      <Field label="Company Name">
        <TextInput value={getContent(companyComp)} onChange={setCompanyName} placeholder="IUOVA Design Company" />
      </Field>
      <Field label="Address">
        <TextInput
          value={getContent(addressComp)}
          onChange={setAddress}
          placeholder="IUOVA · 504 Felix Towers, Lbs Road …"
        />
      </Field>
      <Field label="Preferences URL">
        <TextInput
          value={String(prefsComp?.getAttributes().href || '')}
          onChange={(v) => setLinkUrl(prefsComp, v)}
          placeholder="https://…"
        />
      </Field>
      <Field label="Unsubscribe URL">
        <TextInput
          value={String(unsubComp?.getAttributes().href || '')}
          onChange={(v) => setLinkUrl(unsubComp, v)}
          placeholder="https://…"
        />
      </Field>

      <div style={socialSectionLabel}>Padding</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
        <Field label="Padding Top">
          <NumberInput value={getTdPadding(footerRoot, 'padding-top')} onChange={(v) => setTdPadding(footerRoot, 'padding-top', v)} min={0} max={200} />
        </Field>
        <Field label="Padding Bottom">
          <NumberInput value={getTdPadding(footerRoot, 'padding-bottom')} onChange={(v) => setTdPadding(footerRoot, 'padding-bottom', v)} min={0} max={200} />
        </Field>
        <Field label="Padding Left">
          <NumberInput value={getTdPadding(footerRoot, 'padding-left')} onChange={(v) => setTdPadding(footerRoot, 'padding-left', v)} min={0} max={200} />
        </Field>
        <Field label="Padding Right">
          <NumberInput value={getTdPadding(footerRoot, 'padding-right')} onChange={(v) => setTdPadding(footerRoot, 'padding-right', v)} min={0} max={200} />
        </Field>
      </div>

      <div style={socialSectionLabel}>Border</div>
      <BorderFields getStyle={getStyle} setStyle={setStyle} />
    </div>
  );
}

/* ─── Container properties panel ─────────────────────────────────────────── */

function ContainerPropertiesPanel({
  editor,
  scaffold,
  component,
  tick,
}: {
  editor: Editor;
  scaffold: Scaffold;
  component: Component;
  tick: number;
}) {
  void tick;
  const container = scaffold.containerTable || component;
  const cell = scaffold.containerTd;

  const getStyle = (prop: string) => getCompStyle(container, prop);
  const setStyle = (prop: string, value: string) => setCompStyle(container, prop, value);
  const getCellStyle = (prop: string) => getCompStyle(cell, prop);
  const setCellStyle = (prop: string, value: string) => setCompStyle(cell, prop, value);

  const setWidth = (value: string) => setTableWidth(container, value, false);

  const removeElement = () => {
    if (window.confirm('Delete this Container from the email?')) container.remove();
  };
  const duplicateElement = () => {
    const parent = container.parent();
    if (!parent) return;
    const clone = container.clone();
    parent.append(clone, { at: container.index() + 1 });
    editor.select(clone);
  };
  const moveUp = () => {
    if (container.parent() && container.index() > 0) {
      container.move(container.parent() as Component, { at: container.index() - 1 });
    }
  };
  const moveDown = () => {
    if (container.parent()) container.move(container.parent() as Component, { at: container.index() + 1 });
  };

  return (
    <div style={{ padding: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0F172A' }}>Container Properties</div>
          <div style={{ fontSize: '11px', color: '#94A3B8' }}>
            The main email card — blocks inside stay inside
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button type="button" title="Move container up" onClick={moveUp} style={iconBtn}>↑</button>
          <button type="button" title="Move container down" onClick={moveDown} style={iconBtn}>↓</button>
          <button type="button" title="Duplicate container" onClick={duplicateElement} style={iconBtn}>⧉</button>
          <button
            type="button"
            title="Delete container"
            onClick={removeElement}
            style={smallBtn('#FEF2F2', '#DC2626', '#FECACA')}
          >
            Delete
          </button>
        </div>
      </div>

      <Field label="Background Color">
        <ColorInput
          value={getStyle('background-color') || '#FFFFFF'}
          onChange={(v) => {
            if (isValidColorValue(v)) setStyle('background-color', v);
          }}
          onReset={() => setStyle('background-color', '#FFFFFF')}
        />
      </Field>
      <Field label="Width">
        <NumberInput
          value={pxToNum(getStyle('width')) || '600'}
          onChange={setWidth}
          min={240}
          max={1200}
        />
      </Field>
      <Field label="Border Radius">
        <NumberInput
          value={pxToNum(getStyle('border-radius')) || '12'}
          onChange={(v) => setStyle('border-radius', v ? `${parseFloat(v) || 0}px` : '')}
          min={0}
          max={100}
        />
      </Field>
      <Field label="Container Padding">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          {(['top', 'right', 'bottom', 'left'] as const).map((p) => {
            const prop = `padding-${p}`;
            return (
              <Field key={p} label={`Padding ${p}`}>
                <NumberInput
                  value={pxToNum(getCellStyle(prop)) || (p === 'top' || p === 'bottom' ? '32' : '0')}
                  onChange={(v) => setCellStyle(prop, v ? `${parseFloat(v) || 0}px` : '')}
                  min={0}
                  max={200}
                />
              </Field>
            );
          })}
        </div>
      </Field>
      <div
        style={{
          fontSize: '11px',
          color: '#94A3B8',
          lineHeight: 1.5,
          marginTop: '4px',
          padding: '8px 10px',
          background: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: '8px',
        }}
      >
        The Container is the white email card. Blocks dropped inside it stay children of the
        Container, and the sent email renders the Container exactly as built.
      </div>
    </div>
  );
}

/* ─── Main Properties panel ──────────────────────────────────────────────── */

function PropertiesPanel({ editor, component, tick, onError }: PropertiesPanelProps) {
  void tick;
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!editor || !component || component.get('type') === 'wrapper' || component.is?.('body')) {
    return editor ? <EmailSettingsPanel editor={editor} tick={tick} /> : null;
  }

  // The Social block (or any icon inside it) gets its own dedicated panel.
  const socialRoot = findSocialContainer(component);
  if (socialRoot) {
    return <SocialPropertiesPanel editor={editor} component={component} socialRoot={socialRoot} tick={tick} />;
  }

  // The Footer block (or any element inside it) gets its own dedicated panel so
  // the user can edit the company name, address and the two link URLs.
  const footerRoot = findFooterContainer(component);
  if (footerRoot) {
    return <FooterPropertiesPanel editor={editor} component={component} footerRoot={footerRoot} tick={tick} />;
  }

  // The explicit Container (its table or its inner cell) gets a dedicated panel
  // so the user can control the main email card: background, width, radius and
  // padding (padding lives on the container's cell for email-safe output).
  const scaffold = findScaffold(editor);
  if (
    scaffold.containerTable &&
    (component === scaffold.containerTable || component === scaffold.containerTd)
  ) {
    return <ContainerPropertiesPanel editor={editor} scaffold={scaffold} component={component} tick={tick} />;
  }

  const tag = getTag(component);
  const isParagraph = tag === 'p';
  const getStyle = (prop: string) => getCompStyle(component, prop);
  const setStyle = (prop: string, value: string) => setCompStyle(component, prop, value);
  const setAttr = (name: string, value: string) => setCompAttr(component, name, value);

  const setImageSrc = (value: string) => {
    (component as any).set('src', String(value || '').trim());
  };

  const handleImageUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const src = await uploadEmailImage(file);
      (component as any).set('src', src);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to upload image.');
    }
  };

  const setImageLink = (url: string) => {
    const value = String(url || '').trim();
    const parent = component.parent();
    const hasLink = !!parent && parent.is('link');

    if (value) {
      if (hasLink) {
        (parent as any).addAttributes({ href: value });
      } else {
        wrapImageInLink(component as any, value);
      }
    } else if (hasLink) {
      unwrapImageFromLink(component as any);
    }
  };

  const setElementWidth = (value: string) => {
    if (isImageLike(component)) {
      setImageDim(component, 'width', value);
    } else {
      const n = parseFloat(value);
      setStyle('width', Number.isFinite(n) ? `${n}px` : '');
    }
  };

  const getElementWidth = (): string => {
    if (isImageLike(component)) return getImageDim(component, 'width');
    return pxToNum(getStyle('width'));
  };

  const setElementHeight = (value: string) => {
    const n = parseFloat(value);
    setStyle('height', Number.isFinite(n) && n > 0 ? `${n}px` : '');
  };

  const getElementHeight = (): string => pxToNum(getStyle('height'));

  const setBackgroundColor = (value: string) => {
    if (!isValidColorValue(value)) return;
    setStyle('background-color', String(value || '').trim());
  };

  const setAlignment = (value: string) => {
    if (isImageLike(component)) {
      setImageAlignment(component, value);
    } else {
      setStyle('text-align', value);
      if (tag === 'table') {
        if (value === 'center') {
          setStyle('margin-left', 'auto');
          setStyle('margin-right', 'auto');
        } else {
          setStyle('margin-left', '');
          setStyle('margin-right', '');
        }
      }
    }
  };

  const removeElement = () => {
    if (window.confirm('Delete this element from the email?')) {
      const selected = editor.getSelected();
      if (selected) selected.remove();
    }
  };

  const duplicateElement = () => {
    const comp = editor.getSelected();
    if (!comp) return;
    const parent = comp.parent();
    if (!parent) return;
    const clone = comp.clone();
    parent.append(clone, { at: comp.index() + 1 });
    editor.select(clone);
  };

  const moveUp = () => {
    const comp = editor.getSelected();
    if (!comp || !comp.parent()) return;
    if (comp.index() > 0) comp.move(comp.parent() as Component, { at: comp.index() - 1 });
  };

  const moveDown = () => {
    const comp = editor.getSelected();
    if (!comp || !comp.parent()) return;
    comp.move(comp.parent() as Component, { at: comp.index() + 1 });
  };

  const parent = component.parent();
  const hasLinkWrapper = !!parent && parent.is('link');
  const linkedUrl =
    String(component.getAttributes().href || '') ||
    (hasLinkWrapper ? String(parent?.getAttributes().href || '') : '');

  // For buttons, the visual container is the parent <td>.
  const buttonTd = isButtonLike(component) && parent && parent.is('td') ? parent : null;
  const buttonTable = buttonTd ? (buttonTd.parent()?.parent() ?? null) : null;

  const setButtonStyle = (prop: string, value: string) => {
    const isColorProp = prop === 'background-color' || prop === 'border-color';
    if (isColorProp && !isValidColorValue(value)) return;
    const aHasOwnBg = !!getStyle('background-color');
    if (prop === 'background-color') {
      // Classic email buttons keep the visible background on the parent <td>
      // (the anchor only covers the text + padding). Social icons keep it on
      // the anchor itself. Detect which pattern is in use so the colour change
      // lands on the visible surface.
      setStyle(prop, value);
      if (!aHasOwnBg && buttonTd) setCompStyle(buttonTd, prop, value);
    } else if (prop === 'border-width') {
      // Border width only renders when a border-style is present. Mirror the
      // value onto both the <a> and the visible <td>, and toggle a solid
      // border-style so the width actually shows (width 0 removes the border).
      const n = parseFloat(value);
      const w = Number.isFinite(n) && n > 0 ? `${n}px` : '';
      setStyle('border-width', w);
      setStyle('border-style', w ? 'solid' : '');
      if (buttonTd) {
        setCompStyle(buttonTd, 'border-width', w);
        setCompStyle(buttonTd, 'border-style', w ? 'solid' : '');
      }
    } else if (['border-color', 'border-radius'].includes(prop)) {
      setStyle(prop, value);
      if (buttonTd) setCompStyle(buttonTd, prop, value);
    } else {
      setStyle(prop, value);
    }
  };

  const getButtonAlign = (): string => {
    const tdAlign = buttonTd?.getAttributes()?.align;
    if (tdAlign) return String(tdAlign);
    const tableAlign = buttonTable?.getAttributes()?.align;
    if (tableAlign) return String(tableAlign);
    return getStyle('text-align') || 'center';
  };

  const setButtonAlign = (value: string) => {
    if (buttonTd) buttonTd.addAttributes({ align: value });
    if (buttonTable) buttonTable.addAttributes({ align: value });
    setStyle('text-align', value);
  };

  const getButtonWidthMode = (): 'auto' | 'full' => {
    const aStyle = component.getStyle() || {};
    const tStyle = buttonTable?.getStyle() || {};
    if (
      String(tStyle.width || '').includes('100') ||
      String(aStyle.display || '') === 'block' ||
      String(aStyle.width || '').includes('100')
    ) {
      return 'full';
    }
    return 'auto';
  };

  const setButtonWidthMode = (mode: 'auto' | 'full') => {
    const s = { ...(component.getStyle() || {}) };
    if (mode === 'full') {
      s.display = 'block';
      s.width = '100%';
      s.boxSizing = 'border-box';
    } else {
      s.display = 'inline-block';
      delete s.width;
      delete s.boxSizing;
    }
    component.setStyle(s);
    if (buttonTable) {
      const tStyle = { ...(buttonTable.getStyle() || {}) };
      if (mode === 'full') {
        tStyle.width = '100%';
        buttonTable.addAttributes({ width: '100%' });
      } else {
        delete tStyle.width;
        buttonTable.removeAttributes(['width']);
      }
      buttonTable.setStyle(tStyle);
    }
  };

  const title =
    isImageLike(component)
      ? 'Image Properties'
      : isButtonLike(component)
        ? 'Button Properties'
        : isParagraph
          ? 'Paragraph Properties'
          : isTextLike(component)
            ? 'Text Properties'
            : isSectionLike(component)
              ? 'Section Properties'
              : 'Element Properties';

  const sections: React.ReactNode[] = [];

  const panelActions = (
    <div style={{ display: 'flex', gap: '4px' }}>
      <button type="button" title="Move block up" onClick={moveUp} style={iconBtn}>
        ↑
      </button>
      <button type="button" title="Move block down" onClick={moveDown} style={iconBtn}>
        ↓
      </button>
      <button type="button" title="Duplicate block" onClick={duplicateElement} style={iconBtn}>
        ⧉
      </button>
      <button
        type="button"
        title="Delete selected element"
        onClick={removeElement}
        style={smallBtn('#FEF2F2', '#DC2626', '#FECACA')}
      >
        Delete
      </button>
    </div>
  );

   // ── Text properties ──
   if (isTextLike(component) && !isButtonLike(component)) {
     const hasSimpleContent = (component.get('components')?.length ?? 0) <= 1;
     sections.push(
       <div key="text">
         <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
           <Field label="Width">
             <NumberInput
               value={getElementWidth()}
               onChange={setElementWidth}
               min={0}
               max={1200}
             />
           </Field>
           <Field label="Height">
             <NumberInput
               value={getElementHeight()}
               onChange={setElementHeight}
               min={0}
               max={1200}
             />
           </Field>
         </div>
        {hasSimpleContent && (
          <Field label={tag === 'a' ? 'Link / Button Text' : 'Text Content'}>
            <TextInput
              value={String(component.get('content') || '')}
              onChange={(v) => component.set('content', v)}
            />
          </Field>
        )}
        <Field label="Font Family">
          <SelectInput
            value={getStyle('font-family') || 'Arial, Helvetica, sans-serif'}
            onChange={(v) => setStyle('font-family', v)}
            options={FONT_FAMILIES}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Field label="Font Size">
            <NumberInput
              value={parseFloat(getStyle('font-size')) ? String(parseFloat(getStyle('font-size'))) : ''}
              onChange={(v) => setStyle('font-size', v ? `${parseFloat(v) || 0}px` : '')}
              min={6}
              max={96}
            />
          </Field>
          <Field label="Font Weight">
            <SelectInput
              value={getStyle('font-weight') || 'normal'}
              onChange={(v) => setStyle('font-weight', v)}
              options={FONT_WEIGHTS}
            />
          </Field>
        </div>
        <Field label="Style">
          <TextStyleToggles getStyle={getStyle} setStyle={setStyle} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Field label="Line Height">
            <NumberInput
              value={parseFloat(getStyle('line-height')) ? String(parseFloat(getStyle('line-height'))) : ''}
              onChange={(v) => setStyle('line-height', v)}
              min={0.8}
              max={4}
              step={0.1}
              suffix=""
            />
          </Field>
          <Field label="Letter Spacing">
            <NumberInput
              value={parseFloat(getStyle('letter-spacing')) ? String(parseFloat(getStyle('letter-spacing'))) : ''}
              onChange={(v) => setStyle('letter-spacing', v ? `${parseFloat(v) || 0}px` : '')}
              min={-5}
              max={20}
            />
          </Field>
        </div>
        <Field label="Text Color">
          <ColorInput
            value={getStyle('color')}
            onChange={(v) => {
              if (isValidColorValue(v)) setStyle('color', v);
            }}
            onReset={() => setStyle('color', '')}
          />
        </Field>
        <Field label="Background Color">
          <ColorInput
            value={getStyle('background-color')}
            onChange={setBackgroundColor}
            onReset={() => setStyle('background-color', '')}
          />
        </Field>
        <Field label="Alignment">
          <AlignmentButtons value={getStyle('text-align') || 'left'} onChange={setAlignment} />
        </Field>
        {isParagraph && (
          <Field label="Block Position">
            <AlignmentButtons
              value={getParagraphBlockPosition(component)}
              onChange={(v) => setParagraphBlockPosition(component, v)}
              options={PARAGRAPH_POSITIONS}
            />
          </Field>
        )}
        <Field label="Spacing">
          <SpacingFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
      </div>
    );
  }

  // ── Image properties ──
  if (isImageLike(component)) {
    sections.push(
      <div key="image">
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            void handleImageUpload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          <button
            type="button"
            style={smallBtn('#2563EB', '#FFFFFF', '#2563EB')}
            onClick={() => fileInputRef.current?.click()}
          >
            Upload Image
          </button>
          <button
            type="button"
            style={smallBtn('#FFFFFF', '#1D4ED8', '#BFDBFE')}
            onClick={() => fileInputRef.current?.click()}
          >
            Replace
          </button>
        </div>
        <Field label="Image URL">
          <TextInput
            value={String((component as any).get('src') || '')}
            onChange={setImageSrc}
          />
        </Field>
        <Field label="Alt Text">
          <TextInput
            value={String(component.getAttributes().alt || '')}
            onChange={(v) => setAttr('alt', v)}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Field label="Width">
            <NumberInput
              value={getImageDim(component, 'width')}
              onChange={(v) => setImageDim(component, 'width', v)}
              min={1}
              max={1200}
            />
          </Field>
          <Field label="Height">
            <NumberInput
              value={getImageDim(component, 'height')}
              onChange={(v) => setImageDim(component, 'height', v)}
              min={1}
              max={1200}
            />
          </Field>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <span style={{ fontSize: '11px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Auto Width
          </span>
          <button
            type="button"
            onClick={() => setImageDim(component, 'width', '')}
            style={smallBtn('#FFFFFF', '#1D4ED8', '#BFDBFE')}
          >
            Auto
          </button>
        </div>
        <Field label="Border Radius">
          <NumberInput
            value={pxToNum(getStyle('border-radius'))}
            onChange={(v) => setStyle('border-radius', v ? `${parseFloat(v) || 0}px` : '')}
            min={0}
            max={200}
          />
        </Field>
        <Field label="Alignment">
          <AlignmentButtons
            value={getImageAlignment(component)}
            onChange={setAlignment}
            options={IMAGE_ALIGNMENTS}
          />
        </Field>
        <Field label="Link URL">
          <TextInput value={linkedUrl} onChange={setImageLink} placeholder="https://…" />
        </Field>
        <Field label="Background Color">
          <ColorInput
            value={getStyle('background-color')}
            onChange={setBackgroundColor}
            onReset={() => setStyle('background-color', '')}
          />
        </Field>
        <Field label="Spacing">
          <SpacingFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
      </div>
    );
  }

  // ── Button / link properties ──
  if (isButtonLike(component)) {
    sections.push(
      <div key="button">
        <Field label="Button Text">
          <TextInput
            value={String(component.get('content') || '')}
            onChange={(v) => component.set('content', v)}
          />
        </Field>
        <Field label="Button URL">
          <TextInput
            value={String(component.getAttributes().href || '')}
            onChange={(v) => setAttr('href', normalizeButtonUrl(v))}
            placeholder="https://…"
          />
        </Field>
        <Field label="Font Family">
          <SelectInput
            value={getStyle('font-family') || 'Arial, Helvetica, sans-serif'}
            onChange={(v) => setStyle('font-family', v)}
            options={FONT_FAMILIES}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Field label="Font Size">
            <NumberInput
              value={parseFloat(getStyle('font-size')) ? String(parseFloat(getStyle('font-size'))) : ''}
              onChange={(v) => setStyle('font-size', v ? `${parseFloat(v) || 0}px` : '')}
              min={8}
              max={72}
            />
          </Field>
          <Field label="Font Weight">
            <SelectInput
              value={getStyle('font-weight') || 'normal'}
              onChange={(v) => setStyle('font-weight', v)}
              options={FONT_WEIGHTS}
            />
          </Field>
        </div>
        <Field label="Text Color">
          <ColorInput
            value={getStyle('color')}
            onChange={(v) => {
              if (isValidColorValue(v)) setStyle('color', v);
            }}
            onReset={() => setStyle('color', '#FFFFFF')}
          />
        </Field>
        <Field label="Button Background Color">
          <ColorInput
            value={getStyle('background-color') || (buttonTd ? getCompStyle(buttonTd, 'background-color') : '')}
            onChange={(v) => setButtonStyle('background-color', v)}
            onReset={() => {
              setStyle('background-color', '');
              if (buttonTd) setCompStyle(buttonTd, 'background-color', '#2563EB');
            }}
          />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Field label="Border Width">
            <NumberInput
              value={pxToNum(getStyle('border-width')) || (buttonTd ? pxToNum(getCompStyle(buttonTd, 'border-width')) : '')}
              onChange={(v) => setButtonStyle('border-width', v ? `${parseFloat(v) || 0}px` : '')}
              min={0}
              max={40}
            />
          </Field>
          <Field label="Border Radius">
            <NumberInput
              value={pxToNum(getStyle('border-radius')) || (buttonTd ? pxToNum(getCompStyle(buttonTd, 'border-radius')) : '')}
              onChange={(v) => setButtonStyle('border-radius', v ? `${parseFloat(v) || 0}px` : '')}
              min={0}
              max={100}
            />
          </Field>
        </div>
        <Field label="Border Color">
          <ColorInput
            value={getStyle('border-color') || (buttonTd ? getCompStyle(buttonTd, 'border-color') : '')}
            onChange={(v) => setButtonStyle('border-color', v)}
            onReset={() => {
              setStyle('border-color', '');
              if (buttonTd) setCompStyle(buttonTd, 'border-color', '');
            }}
          />
        </Field>
        <Field label="Button Width">
          <div style={{ display: 'flex', gap: '4px' }}>
            <ToggleBtn active={getButtonWidthMode() === 'auto'} onClick={() => setButtonWidthMode('auto')}>
              Auto
            </ToggleBtn>
            <ToggleBtn active={getButtonWidthMode() === 'full'} onClick={() => setButtonWidthMode('full')}>
              Full Width
            </ToggleBtn>
          </div>
        </Field>
        <Field label="Button Height">
          <NumberInput
            value={pxToNum(getStyle('height'))}
            onChange={(v) => setStyle('height', v ? `${parseFloat(v) || 0}px` : '')}
            min={0}
            max={400}
          />
        </Field>
        <Field label="Alignment">
          <AlignmentButtons value={getButtonAlign()} onChange={setButtonAlign} options={IMAGE_ALIGNMENTS} />
        </Field>
        <Field label="Spacing">
          <SpacingFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
      </div>
    );
  }

  // ── Section / container properties ──
  if (isSectionLike(component)) {
    sections.push(
      <div key="section">
        <Field label="Background Color">
          <ColorInput
            value={getStyle('background-color')}
            onChange={setBackgroundColor}
            onReset={() => setStyle('background-color', '')}
          />
        </Field>
        <Field label="Width">
          <NumberInput
            value={getElementWidth()}
            onChange={setElementWidth}
            min={0}
            max={1200}
          />
        </Field>
        <Field label="Height">
          <NumberInput
            value={getElementHeight()}
            onChange={setElementHeight}
            min={0}
            max={1200}
          />
        </Field>
        <Field label="Spacing">
          <SpacingFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
        <Field label="Border">
          <BorderFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
        <Field label="Alignment">
          <AlignmentButtons value={getStyle('text-align') || 'left'} onChange={setAlignment} />
        </Field>
      </div>
    );
  }

  // ── Generic element properties (divider, spacer, etc.) ──
  if (!isTextLike(component) && !isImageLike(component) && !isButtonLike(component) && !isSectionLike(component)) {
    sections.push(
      <div key="general">
        <Field label="Background Color">
          <ColorInput
            value={getStyle('background-color')}
            onChange={setBackgroundColor}
            onReset={() => setStyle('background-color', '')}
          />
        </Field>
        <Field label="Width">
          <NumberInput
            value={getElementWidth()}
            onChange={setElementWidth}
            min={0}
            max={1200}
          />
        </Field>
        <Field label="Height">
          <NumberInput
            value={getElementHeight()}
            onChange={setElementHeight}
            min={0}
            max={1200}
          />
        </Field>
        <Field label="Spacing">
          <SpacingFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
        <Field label="Border">
          <BorderFields getStyle={getStyle} setStyle={setStyle} />
        </Field>
        <Field label="Alignment">
          <AlignmentButtons value={getStyle('text-align') || 'left'} onChange={setAlignment} />
        </Field>
      </div>
    );
  }

  return (
    <div style={{ padding: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid #E2E8F0',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0F172A' }}>{title}</div>
          <div style={{ fontSize: '11px', color: '#94A3B8', textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tag || component.getName()}
          </div>
        </div>
        {panelActions}
      </div>
      {sections}
    </div>
  );
}

function smallBtn(bg: string, color: string, border: string): React.CSSProperties {
  return {
    flex: 1,
    padding: '7px 8px',
    borderRadius: '8px',
    border: `1px solid ${border}`,
    background: bg,
    color,
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

const iconBtn: React.CSSProperties = {
  width: '30px',
  height: '30px',
  padding: '0',
  borderRadius: '7px',
  border: '1px solid #E2E8F0',
  background: '#FFFFFF',
  color: '#475569',
  fontSize: '13px',
  fontWeight: 700,
  cursor: 'pointer',
  lineHeight: 1,
  flexShrink: 0,
};

export const MOBILE_RESPONSIVE_CSS = `
/* ── Mobile responsive overrides for email preview ─────────────────────── */
@charset "UTF-8";
@media only screen and (max-width: 600px) {
  html, body {
    width: 100% !important;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow-x: hidden !important;
  }
  /* Every table (including fixed-width content cards) is capped to the
     viewport. Both width and max-width are set so HTML width attributes
     (e.g. width="600") and inline style widths are fully overridden. */
  table { width: 100% !important; max-width: 100% !important; min-width: 0 !important; table-layout: auto !important; }
  td, th { width: auto !important; max-width: 100% !important; min-width: 0 !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  /* Images scale down to the viewport while keeping their aspect ratio */
  img { max-width: 100% !important; height: auto !important; }
  /* Text blocks wrap instead of overflowing */
  p, div, span, h1, h2, h3, h4, h5, h6, a { max-width: 100% !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
  /* Multi-column email blocks stack vertically on narrow screens so each
     column becomes a full-width section instead of squeezing side-by-side. */
  td[width$="%"], th[width$="%"] { display: block !important; width: 100% !important; }
  * { box-sizing: border-box !important; }
}
`;

const EDITOR_CSS = `
.te-editor { display: flex; flex-direction: column; border: 1px solid #E2E8F0; border-radius: 14px; overflow: hidden; background: #FFFFFF; box-shadow: 0 1px 3px rgba(15,23,42,0.06); }
.te-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid #E2E8F0; background: #F8FAFC; }
.te-devices { display: flex; align-items: center; gap: 6px; }
.te-hint { font-size: 11.5px; color: #94A3B8; }
.te-body { display: flex; min-height: 560px; height: calc(100vh - 360px); }
.te-blocks { width: 400px; flex-shrink: 0; border-right: 1px solid #E2E8F0; display: flex; flex-direction: column; background: #FFFFFF; }
.te-pane-head { padding: 11px 14px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; color: #64748B; border-bottom: 1px solid #E2E8F0; text-transform: uppercase; }
.te-blocks-head { padding: 16px 18px 12px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; color: #0F172A; text-transform: uppercase; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; }
.te-blocks-head .te-blocks-arrow { font-size: 8px; line-height: 1; color: #64748B; }
.te-blocks-scroll { flex: 1; overflow-y: auto; margin: 0 12px 12px; padding: 14px; background: #3A3A3A; border-radius: 14px; box-sizing: border-box; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.3) transparent; }
.te-blocks-scroll::-webkit-scrollbar { width: 8px; }
.te-blocks-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 8px; }
.te-blocks-scroll::-webkit-scrollbar-track { background: transparent; }
.te-canvas-wrap { flex: 1; min-width: 0; min-height: 0; position: relative; background: #F3F4F6; overflow: hidden; }
.te-canvas { position: absolute; inset: 0; display: flex; justify-content: center; align-items: flex-start; overflow: auto; }
.te-props { width: 320px; flex-shrink: 0; border-left: 1px solid #E2E8F0; overflow-y: auto; background: #FFFFFF; }
.te-blk { display: inline-flex; align-items: center; justify-content: center; width: 46px; height: 46px; background: #E4EDFF; color: #1D4ED8; border-radius: 13px; font-weight: 700; font-size: 18px; font-family: Arial, sans-serif; }
.te-empty-hint { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 5; pointer-events: none; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: rgba(15,23,42,0.72); color: #FFFFFF; font-size: 12.5px; font-weight: 600; box-shadow: 0 2px 10px rgba(15,23,42,0.25); white-space: nowrap; }
.te-empty-hint .te-empty-dot { width: 8px; height: 8px; border-radius: 50%; background: #60A5FA; animation: tePulse 1.6s ease-in-out infinite; }
@keyframes tePulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

/* Full-screen / expanded layout mode. The editor fills every available pixel;
   the center canvas expands between the side panels and scrolls when the email
   is wider than the space available (it is never clipped). */
.te-editor.te-fs { flex: 1 1 auto; height: auto; min-height: 0; border-radius: 0; }
.te-editor.te-fs .te-body { flex: 1 1 auto; height: auto; min-height: 0; }
.te-editor.te-fs .te-head { border-radius: 0; }

.te-blocks-scroll .gjs-block-categories { margin: 0; }
.te-blocks-scroll .gjs-block-category { margin: 0; background: transparent; }
.te-blocks-scroll .gjs-block-category.gjs-open { border-bottom: none; }
.te-blocks-scroll .gjs-block-category .gjs-title { background: transparent; border: none; padding: 0 2px 14px; margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #FFFFFF; cursor: pointer; display: flex; align-items: center; gap: 6px; user-select: none; }
.te-blocks-scroll .gjs-block-category .gjs-title .gjs-caret-icon { font-family: Arial, sans-serif; font-style: normal; font-size: 8px; line-height: 1; margin: 0; color: #A8B1C0; }
.te-blocks-scroll .gjs-block-category.gjs-open .gjs-title .gjs-caret-icon::before { content: '▼'; }
.te-blocks-scroll .gjs-block-category:not(.gjs-open) .gjs-title .gjs-caret-icon::before { content: '▶'; }
.te-blocks-scroll .gjs-blocks-c { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 12px; justify-content: initial; }
.te-blocks-scroll .gjs-block { width: 100%; min-width: 0; min-height: 116px; margin: 0; padding: 14px 8px 12px; border: 1px solid #E5E7EB; border-radius: 12px; background: #FFFFFF; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: grab; box-shadow: none; transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease; }
.te-blocks-scroll .gjs-block:hover { border-color: #93C5FD; box-shadow: 0 3px 10px rgba(37, 99, 235, 0.16); }
.te-blocks-scroll .gjs-block:active { border: 2px solid #2563EB; cursor: grabbing; }
.te-blocks-scroll .gjs-block.gjs-bdrag { border: 2px solid #2563EB; cursor: grabbing; }
.te-blocks-scroll .gjs-block__media { margin: 0; pointer-events: none; display: flex; align-items: center; justify-content: center; }
.te-blocks-scroll .gjs-block-svg svg { width: 20px; height: 20px; }
.te-blocks-scroll .gjs-block-label { font-size: 11.5px; font-weight: 600; color: #1F2937; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
@media (max-width: 1400px) {
  .te-blocks { width: 320px; }
  .te-blocks-scroll { margin: 0 10px 10px; padding: 12px; }
}

.te-editor .gjs-pn-panel, .te-editor .gjs-pn-views-container { display: none; }
.te-editor .gjs-cv-canvas { position: relative; width: 100%; height: auto; top: 0; left: 0; min-width: 0; overflow: visible; }
.te-editor .gjs-cv-canvas__frames { position: static; width: 100%; height: auto; overflow: visible; }
.te-editor .gjs-frame-wrapper { position: relative; height: auto; margin: 26px auto 40px; box-shadow: 0 4px 18px rgba(15,23,42,0.12); border-radius: 4px; }
/* Phone-like frame for the mobile canvas: rounded bezel + subtle screen
   inset so the 375px preview reads as a real device, not a shrunk desktop. */
.te-editor.te-device-mobile .gjs-frame-wrapper {
  border-radius: 24px;
  box-shadow:
    0 0 0 8px #1E293B,
    0 0 0 9px #334155,
    0 24px 50px rgba(15, 23, 42, 0.35);
  margin: 30px auto 48px;
}
.te-editor.te-device-mobile .gjs-frame {
  border-radius: 16px;
  overflow: hidden;
}
.te-editor.te-device-mobile .gjs-cv-canvas__frames {
  padding: 0;
}
.te-editor .gjs-selected { outline: 2px solid #2563EB !important; outline-offset: -2px; }
.te-editor .gjs-highlighter { outline: 1px dashed #60A5FA; }
.te-editor .gjs-toolbar { border-radius: 6px; }
.te-editor .gjs-toolbar-item { font-size: 12px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; min-width: 26px; }
.te-editor .gjs-drop-indicator { background: #2563EB; height: 3px; border-radius: 3px; }
.te-editor .gjs-com-badge { background: #2563EB; }

/* Asset-manager upload-area image preview */
.te-am-img-preview { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 20px; min-height: 120px; box-sizing: border-box; }
.te-am-img-preview img { max-width: 100%; max-height: 180px; object-fit: contain; border-radius: 6px; background: #1a1a1a; }
.te-am-img-preview-name { font-size: 12px; color: #94A3B8; word-break: break-all; text-align: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/* ─── Main component ─────────────────────────────────────────────────────── */

const TemplateVisualEditor = forwardRef<TemplateVisualEditorHandle, TemplateVisualEditorProps>(
  function TemplateVisualEditor({ initialHtml, onChange, onError, fullscreen = false, onToggleFullscreen }, ref) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const blocksScrollRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<Editor | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const destroyedRef = useRef(false);
    const deviceRef = useRef('desktop');
    const onChangeRef = useRef(onChange);
    const onErrorRef = useRef(onError);
    const previewUrlRef = useRef<string | null>(null);

    const [editor, setEditor] = useState<Editor | null>(null);
    const [selected, setSelected] = useState<Component | null>(null);
    const [tick, setTick] = useState(0);
    const [device, setDevice] = useState('desktop');
    const [isEmpty, setIsEmpty] = useState(true);
    const [contentCollapsed, setContentCollapsed] = useState(false);

    useEffect(() => {
      onChangeRef.current = onChange;
      onErrorRef.current = onError;
    }, [onChange, onError]);

    useImperativeHandle(
      ref,
      () => ({
        getHtml: () => (editorRef.current ? getDocumentHtml(editorRef.current) : ''),
        getSelected: () => editorRef.current?.getSelected() || null,
      }),
      []
    );

    const scheduleSync = useCallback(() => {
      if (destroyedRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (destroyedRef.current) return;
        const current = editorRef.current;
        if (current) {
          onChangeRef.current(getDocumentHtml(current));
          setIsEmpty(isContentEmpty(current));
        }
      }, 250);
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      const blocksScroll = blocksScrollRef.current;
      if (!canvas || !blocksScroll) return;

      destroyedRef.current = false;

      const editor = grapesjs.init({
        container: canvas,
        height: '100%',
        width: 'auto',
        fromElement: false,
        storageManager: false,
        // Keep all edited styles as inline styles (email-safe). With the
        // GrapesJS default (avoidInlineStyle: true) styles are moved into
        // device-scoped CSS rules (`@media (max-width: 660px)`) which never
        // reach the saved HTML correctly and silently ignore image width/height
        // changes on re-render / device switch.
        avoidInlineStyle: false,
        forceClass: false,
        blockManager: {
          appendTo: blocksScroll,
          blocks: EMAIL_EDITOR_BLOCKS,
        },
        styleManager: { sectors: [] } as any,
        traitManager: {} as any,
        deviceManager: {
          devices: [
            { id: 'desktop', name: 'Desktop', width: '660px', height: 'auto' },
            { id: 'mobile', name: 'Mobile', width: '375px', height: 'auto' },
          ],
        },
        assetManager: {
          upload: 'email-template',
          uploadName: 'files',
          embedAsBase64: false,
          autoAdd: true,
          assets: [],
          uploadFile: async (ev, clb) => {
            const input = ev.target as HTMLInputElement | null;
            const fileList = ev.dataTransfer ? ev.dataTransfer.files : input?.files;
            const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith('image/'));

            // Show image preview in the upload drop-area immediately
            if (files.length > 0) {
              // Revoke previous preview URL
              if (previewUrlRef.current) {
                URL.revokeObjectURL(previewUrlRef.current);
                previewUrlRef.current = null;
              }
              const file = files[0];
              const objectUrl = URL.createObjectURL(file);
              previewUrlRef.current = objectUrl;

              // Find the GrapesJS upload form and inject a preview
              const uploadForm = document.querySelector(
                '.gjs-am-file-uploader form'
              ) as HTMLElement | null;
              if (uploadForm) {
                // Remove any existing preview
                const old = uploadForm.querySelector('.te-am-img-preview');
                if (old) old.remove();

                // Hide the default "Drop files here…" title
                const titleEl = uploadForm.querySelector(
                  '[id$="title"]'
                ) as HTMLElement | null;
                if (titleEl) titleEl.style.display = 'none';

                // Build the preview container
                const wrap = document.createElement('div');
                wrap.className = 'te-am-img-preview';

                const img = document.createElement('img');
                img.src = objectUrl;
                wrap.appendChild(img);

                const name = document.createElement('span');
                name.className = 'te-am-img-preview-name';
                name.textContent = file.name;
                wrap.appendChild(name);

                // Insert before the hidden file input
                const fileInput = uploadForm.querySelector(
                  'input[type="file"]'
                );
                if (fileInput) {
                  uploadForm.insertBefore(wrap, fileInput);
                } else {
                  uploadForm.appendChild(wrap);
                }
              }
            }

            const results: { src: string }[] = [];
            for (const file of files) {
              try {
                const src = await uploadEmailImage(file);
                results.push({ src });
              } catch (err) {
                editor.trigger(
                  'asset:upload:error',
                  err instanceof Error ? err : new Error(String(err))
                );
              }
            }
            if (clb) clb({ data: results });
            const selectedComp = editor.getSelected();
            if (selectedComp && results[0]) {
              selectedComp.set('src', results[0].src);
            }
          },
        },
      });

      editorRef.current = editor;
      setEditor(editor);

      // Give paragraphs the same selection/resize behaviour as images: the full
      // set of resize handles (corners + edges). Width/height are written back
      // to the inline style (persisted in the exported HTML) and picked up by
      // the Properties panel via component:styleUpdate. The shared
      // UNIVERSAL_RESIZE config is reused so Paragraph behaves identically to
      // every other supported block.
      editor.DomComponents.addType('p', {
        extend: 'text',
        isComponent: (el) => el.tagName?.toLowerCase() === 'p',
        model: {
          defaults: {
            resizable: UNIVERSAL_RESIZE,
          },
        },
      });

      // Make `link` components — which include the Button block's `<a>` — use the
      // SAME resize mechanism as the built-in `image` type (`resizable: true`),
      // so selecting a Button shows the identical blue selection border and blue
      // resize handles, and dragging them updates the real width/height that gets
      // serialized into the saved template. Social-icon and footer links are
      // detected via their ancestor markers and left untouched so their
      // structured markup is never altered, and only real (text-only) buttons
      // become inline double-click editable.
      const linkType = editor.DomComponents.getType('link');
      if (linkType && linkType.model) {
        const linkDefaults =
          typeof (linkType.model as any).getDefaults === 'function'
            ? (linkType.model as any).getDefaults()
            : (linkType.model.prototype as any).defaults;
        editor.DomComponents.addType('link', {
          model: {
            defaults: { ...(linkDefaults || {}), resizable: true },
            init() {
              try {
                const getAttrs = (c: any) => (c && c.getAttributes ? c.getAttributes() : {});
                const attrs = getAttrs(this);
                let p: any = this.parent();
                let inSocial = false;
                let inFooter = false;
                while (p) {
                  const a = getAttrs(p);
                  if (a && a[SOCIAL_DATA_ATTR]) inSocial = true;
                  if (a && a['data-te-footer']) inFooter = true;
                  p = p.parent();
                }
                if (inSocial || inFooter) {
                  this.set('resizable', false);
                  this.set('editable', false);
                  return;
                }
                const flagged = attrs && attrs['data-te-button'] !== undefined;
                if (flagged) {
                  // Repair any legacy/accidental leading '#' in a saved Button URL
                  // (e.g. `#https://…`) so the generated <a href> is valid.
                  const rawHref = attrs && attrs.href;
                  if (rawHref) {
                    const norm = normalizeButtonUrl(String(rawHref));
                    if (norm && norm !== String(rawHref)) {
                      this.addAttributes({ href: norm });
                    }
                  }
                }
                const hasMedia = this.components().models.some((c: any) => {
                  const t = String(c.get('tagName') || '').toLowerCase();
                  return t === 'img' || t === 'svg' || c.get('type') === 'image';
                });
                this.set('resizable', true);
                this.set('editable', flagged || !hasMedia);
              } catch {
                /* best-effort: leave defaults intact */
              }
            },
          },
        });
      }

      // ── Container / Section component types ────────────────────────────────
      // Email blocks are table-based. A Container/Section is a `<table>` with a
      // single `<td>` cell. Two problems stop the native resize from changing the
      // visible width:
      //
      //   1. The previous wrapper logic disabled `resizable` on every table that
      //      lived anywhere inside the `email-wrapper` (Container is nested there)
      //      — fixed by `isEmailScaffold` / `disableWrapperResize` above.
      //
      //   2. Clicking a Container selects its INNER `<td>` (the cell fills the
      //      table, so there is no clickable table-edge). Dragging a handle on a
      //      `<td>` sets the cell width, but the parent `<table>` has an explicit
      //      `width` that forces the cell back to its original size — so the user
      //      sees no change. The fix: make the inner cell NON-selectable so the
      //      table becomes the selected/resize target. Setting `width` on the
      //      table actually changes the rendered email width (and survives
      //      email-client rendering). `droppable` stays on so blocks can still be
      //      dropped inside the Container, and the cell's own text/child blocks
      //      remain independently selectable/editable.
      const makeInnerCellsNonSelectable = (tableComp: any) => {
        try {
          tableComp.components().models.forEach((row: any) => {
            if (String(row.get('tagName') || '').toLowerCase() !== 'tr') return;
            row.components().models.forEach((cell: any) => {
              if (String(cell.get('tagName') || '').toLowerCase() !== 'td') return;
              cell.set('selectable', false);
              cell.set('hoverable', false);
              cell.set('droppable', true);
            });
          });
        } catch {
          /* best-effort */
        }
      };

      const registerTableBlockType = (typeId: string, role: string) => {
        editor.DomComponents.addType(typeId, {
          isComponent: (el: any) =>
            !!el && !!el.getAttribute && el.getAttribute('data-te-role') === role,
          model: {
            defaults: { resizable: UNIVERSAL_RESIZE },
            init() {
              const apply = () => makeInnerCellsNonSelectable(this);
              // Children are parsed after `init`, so wait for the loaded event;
              // also apply immediately in case children are already present.
              apply();
              this.on('loaded', apply);
            },
          },
        });
      };

      registerTableBlockType('te-container', 'container');
      registerTableBlockType('te-section', 'section');

      // Image wrapper: the full-width <div> that centres the actual <img>.
      // The wrapper itself must never be the selection/resize target — only
      // the inner <img> should be interactive.
      editor.DomComponents.addType('te-image-wrapper', {
        isComponent: (el: any) =>
          !!el && !!el.getAttribute && el.getAttribute('data-te-role') === 'image-wrapper',
        model: {
          defaults: {
            selectable: false,
            hoverable: false,
            droppable: false,
            resizable: false,
          },
        },
      });

      // Apply the universal blue resize border + handles to EVERY other supported
      // component type (Text, Heading, Divider, Spacer, Video, Logo, Columns,
      // Footer, Table, Table Row, Table Cell, etc.). The image/link(p)/wrapper/
      // body/te-container/te-section types are handled separately above / skipped
      // on purpose, so this only fills in the remaining blocks — including any
      // custom block added in the future.
      makeAllTypesResizable(editor);

      // Keep GrapesJS's selection/hover tools glued to the content while the
      // outer canvas scrolls. The canvas view caches its offset (`cvsOff`);
      // in this tall auto-height layout `.gjs-cv-canvas` moves with the scroll
      // so the cached value goes stale the moment `.te-canvas` scrolls. Reset
      // it on every scroll and re-trigger GrapesJS's own canvas-scroll handler
      // (bound to the canvas view element) to re-position the tools.
      const onCanvasScroll = () => {
        const canvasView = (editor as any).Canvas?.getCanvasView?.();
        if (!canvasView) return;
        canvasView.cvsOff = null;
        canvasView.frmOff = null;
        const canvasEl = canvasView.el;
        if (canvasEl && typeof canvasEl.dispatchEvent === 'function') {
          canvasEl.dispatchEvent(new Event('scroll'));
        }
      };
      canvas.addEventListener('scroll', onCanvasScroll);

      // Custom commands for moving / duplicating / deleting the selected block.
      // When the selected component is an <img> inside an image-wrapper div,
      // operate on the wrapper so the entire block moves as one unit.
      const getImageWrapperTarget = (comp: Component): Component => {
        const p = comp.parent?.();
        if (p && p.getAttributes?.()?.['data-te-role'] === 'image-wrapper') return p;
        return comp;
      };

      editor.Commands.add('te-move-up', {
        run(ed: Editor) {
          const comp = ed.getSelected();
          if (!comp || !comp.parent()) return;
          const target = getImageWrapperTarget(comp);
          if (!target.parent() || target.index() <= 0) return;
          target.move(target.parent() as Component, { at: target.index() - 1 });
          ed.select(comp);
        },
      });

      editor.Commands.add('te-move-down', {
        run(ed: Editor) {
          const comp = ed.getSelected();
          if (!comp || !comp.parent()) return;
          const target = getImageWrapperTarget(comp);
          if (!target.parent()) return;
          target.move(target.parent() as Component, { at: target.index() + 1 });
          ed.select(comp);
        },
      });

      editor.Commands.add('te-duplicate', {
        run(ed: Editor) {
          const comp = ed.getSelected();
          if (!comp || !comp.parent()) return;
          const target = getImageWrapperTarget(comp);
          const clone = target.clone();
          target.parent()?.append(clone, { at: target.index() + 1 });
          const img = clone.components?.().models?.find((c: any) => c.is?.('image'));
          ed.select(img || clone);
        },
      });

      editor.Commands.add('te-delete', {
        run(ed: Editor) {
          const comp = ed.getSelected();
          if (!comp) return;
          if (window.confirm('Delete this element from the email?')) {
            const target = getImageWrapperTarget(comp);
            target.remove();
          }
        },
      });

      // Wrapper-aware drag-move: when the user grabs the ≡ handle on an image
      // that lives inside an image-wrapper, select the wrapper first so
      // GrapesJS's built-in tlb-move drags the entire wrapper block.
      editor.Commands.add('te-wrapper-move', {
        run(ed: Editor) {
          const comp = ed.getSelected();
          if (!comp) return;
          const target = getImageWrapperTarget(comp);
          if (target !== comp) {
            ed.select(target);
            setTimeout(() => ed.runCommand('tlb-move'), 0);
          } else {
            ed.runCommand('tlb-move');
          }
        },
      });

      // Clean up orphaned image-wrappers (empty <div>s left behind when the
      // inner <img> is deleted via keyboard shortcut or any other path).
      editor.on('component:remove', (comp: any) => {
        if (comp.is?.('image')) {
          const p = comp.parent?.();
          if (p && p.getAttributes?.()?.['data-te-role'] === 'image-wrapper' && p.components?.().length === 0) {
            setTimeout(() => { try { p.remove(); } catch {} }, 0);
          }
        }
      });

      // Keep the right-hand properties panel in sync with the canvas selection.
      editor.on('component:selected', (component: Component) => {
        setSelected(component);
        setTick((t) => t + 1);

        // The email background scaffold (the outer `email-wrapper` table and its
        // structural rows/cells) must behave like the canvas — it is never
        // resized by the user. Disable its resize handles so selecting the
        // background can't accidentally resize the whole email (requirement
        // #17). Every other table cell/row/table (Container, Section, Columns,
        // Table blocks, etc.) keeps full resizing handled by `makeAllTypesResizable`.
        const selTag = String(component.get('tagName') || '').toLowerCase();
        if (['table', 'tbody', 'tr', 'td'].includes(selTag)) {
          let p: any = component;
          let inWrapper = false;
          while (p) {
            const a = p.getAttributes ? p.getAttributes() : {};
            if (a && a['data-te-role'] === 'email-wrapper') {
              inWrapper = true;
              break;
            }
            p = p.parent();
          }
          component.set('resizable', !inWrapper);
        }

        // Skip destructive editing affordances on the document body and the
        // structural table rows/cells that make up the email layout.
        const tag = String(component.get('tagName') || '').toLowerCase();
        if (
          component.get('type') === 'wrapper' ||
          component.is?.('body') ||
          tag === 'tbody' ||
          tag === 'tr' ||
          tag === 'td'
        ) {
          return;
        }

        // Build a custom toolbar with move up/down + duplicate + delete so
        // every block is independently movable, reorderable and removable.
        const tb: any[] = [
          { id: 'te-move-up', label: '↑', command: 'te-move-up' },
          { id: 'te-move-down', label: '↓', command: 'te-move-down' },
          { id: 'te-duplicate', label: '⧉', command: 'te-duplicate' },
          { attributes: { class: 'fa fa-arrows' }, label: '≡', command: 'tlb-move' },
          { id: 'te-delete', label: '✕', command: 'te-delete' },
        ];
        if (component.is && component.is('image')) {
          tb.push({
            id: 'te-replace-image',
            label: 'Replace',
            attributes: { class: 'fa fa-image' },
            command: (ed: Editor) => ed.runCommand('open-assets', { target: ed.getSelected() }),
          });
          // If the image is inside an image-wrapper, use the wrapper-aware
          // drag command so the entire block moves as one unit.
          const inWrapper = component.parent?.()?.getAttributes?.()?.['data-te-role'] === 'image-wrapper';
          if (inWrapper) {
            const moveIdx = tb.findIndex((b: any) => b.command === 'tlb-move');
            if (moveIdx >= 0) {
              tb[moveIdx] = {
                attributes: { class: 'fa fa-arrows' },
                label: '≡',
                command: 'te-wrapper-move',
              };
            }
          }
        }
        component.set('toolbar', tb);
      });
      editor.on('selection:deselected', () => setSelected(null));
      editor.on('component:update', () => setTick((t) => t + 1));
      editor.on('component:styleUpdate', () => setTick((t) => t + 1));
      editor.on('device:select', (deviceModel) => {
        const devId = deviceModel ? deviceModel.get('id') || 'desktop' : 'desktop';
        deviceRef.current = devId;
        setDevice(devId);
        injectMobileCss(editor, devId === 'mobile');
      });
      // GrapesJS can rebuild the frame document (on load / undo / component
      // swaps); re-apply the responsive styles so mobile mode always keeps
      // the email reflowed to the 375px viewport.
      editor.on('canvas:frame:load', () => {
        injectMobileCss(editor, deviceRef.current === 'mobile');
      });
      editor.on('component:update', () => {
        if (deviceRef.current === 'mobile') injectMobileCss(editor, true);
      });

      // When an image-wrapper is added (e.g. block drop), auto-select the
      // inner <img> so the selection outline / resize handles appear on the
      // actual image, not the full-width wrapper.
      editor.on('component:add', (comp: any) => {
        if (comp.getAttributes?.()?.['data-te-role'] === 'image-wrapper') {
          const img = comp.components?.().models?.find((c: any) => c.is?.('image'));
          if (img) {
            setTimeout(() => editor.select(img), 0);
          }
        }
      });

      // If the wrapper itself gets selected (e.g. programmatic selection),
      // redirect to the inner <img> so the selection box matches the image.
      editor.on('component:selected', (comp: any) => {
        if (comp.getAttributes?.()?.['data-te-role'] === 'image-wrapper') {
          const img = comp.components?.().models?.find((c: any) => c.is?.('image'));
          if (img) {
            setTimeout(() => editor.select(img), 0);
          }
        }
      });

      // Double-clicking an image opens the asset manager so a new image can be
      // picked without touching the source HTML.
      editor.on('component:dblclick', (component: Component) => {
        if (component.is && component.is('image')) {
          editor.runCommand('open-assets', { target: component });
        }
      });

      editor.on('asset:upload:error', (error) => {
        onErrorRef.current?.(
          error instanceof Error ? error.message : 'Failed to upload image.'
        );
      });

      for (const evt of CHANGE_EVENTS) {
        editor.on(evt, scheduleSync);
      }

      // Hide the default GrapesJS panel chrome (blocks/style live in our own
      // left/right panes now), keeping only the raw canvas.
      try {
        editor.Panels.getPanels().each((panel: any) => {
          const buttons = panel.get('buttons');
          if (buttons && typeof buttons.reset === 'function') buttons.reset();
        });
      } catch {
        /* best-effort — panel removal is purely cosmetic */
      }

      // Load the template content. Placeholders such as {{first_name}} are
      // preserved verbatim — nothing is replaced or rewritten at edit time.
      editor.setComponents(initialHtml || '', { asDocument: true });
      // Never allow resizing the email background scaffold (see
      // `disableWrapperResize` / requirement #17). Runs after components are
      // parsed so the wrapper subtree exists.
      disableWrapperResize(editor);
      editor.setDevice('desktop');
      setIsEmpty(isContentEmpty(editor));

      return () => {
        destroyedRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        // Revoke any lingering image preview object URL
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        canvas.removeEventListener('scroll', onCanvasScroll);
        if (editorRef.current) {
          onChangeRef.current(getDocumentHtml(editorRef.current));
        }
        editor.destroy();
        editorRef.current = null;
        setEditor(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const runCommand = useCallback((command: string) => {
      editorRef.current?.runCommand(command);
    }, []);

    const switchDevice = useCallback((id: string) => {
      editorRef.current?.setDevice(id);
    }, []);

return (
      <div className={`te-editor${fullscreen ? ' te-fs' : ''}${device === 'mobile' ? ' te-device-mobile' : ''}`}>
        <style>{EDITOR_CSS}</style>
        <div className="te-head">
          <div className="te-devices">
            <button
              type="button"
              onClick={() => switchDevice('desktop')}
              title="Switch the canvas to desktop width (660px)"
              style={deviceTab(device === 'desktop')}
            >
              Desktop
            </button>
            <button
              type="button"
              onClick={() => switchDevice('mobile')}
              title="Switch the canvas to a mobile width (375px)"
              style={deviceTab(device === 'mobile')}
            >
              Mobile
            </button>
            <span
              style={{ width: 1, height: 20, background: '#E2E8F0', margin: '0 6px' }}
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={() => runCommand('core:undo')}
              title="Undo (Ctrl/Cmd+Z)"
              style={ghostBtn}
            >
              ↺ Undo
            </button>
            <button
              type="button"
              onClick={() => runCommand('core:redo')}
              title="Redo (Ctrl/Cmd+Shift+Z)"
              style={ghostBtn}
            >
              ↻ Redo
            </button>
            <span
              style={{ width: 1, height: 20, background: '#E2E8F0', margin: '0 6px' }}
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={onToggleFullscreen}
              title={fullscreen ? 'Exit full screen (Esc)' : 'Expand the editor to full screen'}
              style={fullscreen ? fsBtnActive : fsBtn}
            >
              {fullscreen ? '↙ Minimize' : '⛶ Full Screen'}
            </button>
          </div>
          <div className="te-hint">
            Drag blocks into the canvas · Double-click text to edit · Placeholders like{' '}
            <span style={{ fontFamily: 'var(--mono)', color: '#1D4ED8' }}>{'{{first_name}}'}</span>{' '}
            are preserved automatically.
          </div>
        </div>
        <div className="te-body">
          <div className="te-blocks">
            <div className="te-blocks-head" onClick={() => setContentCollapsed((p) => !p)}>
              <span className="te-blocks-arrow">{contentCollapsed ? '▲' : '▼'}</span>
              CONTENT
            </div>
            <div className="te-blocks-scroll" ref={blocksScrollRef} style={contentCollapsed ? { display: 'none' } : undefined} />
          </div>
          <div className="te-canvas-wrap">
            <div className="te-canvas" ref={canvasRef} />
            {isEmpty && (
              <div className="te-empty-hint">
                <span className="te-empty-dot" />
                Start building your email — add a Container, then drag blocks inside it.
              </div>
            )}
          </div>
          <div className="te-props">
            <div className="te-pane-head" style={{ background: '#FFFFFF' }}>
              Properties
            </div>
            <PropertiesPanel
              editor={editor}
              component={selected}
              tick={tick}
              onError={(m) => onErrorRef.current?.(m)}
            />
          </div>
        </div>
      </div>
    );
  }
);

function deviceTab(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    borderRadius: '8px',
    border: active ? '1px solid #2563EB' : '1px solid #CBD5E1',
    background: active ? '#EFF6FF' : '#FFFFFF',
    color: active ? '#1D4ED8' : '#334155',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

const ghostBtn: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: '8px',
  border: '1px solid transparent',
  background: 'transparent',
  color: '#475569',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
};

const fsBtn: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: '8px',
  border: '1px solid #CBD5E1',
  background: '#FFFFFF',
  color: '#334155',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const fsBtnActive: React.CSSProperties = {
  ...fsBtn,
  color: '#1D4ED8',
  borderColor: '#2563EB',
  background: '#EFF6FF',
};

export default TemplateVisualEditor;