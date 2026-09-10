/**
 * Social icon library + email-safe HTML renderer used by the Template Editor's
 * "Social" block.
 *
 * Brand icons are rendered as public, email-safe raster PNGs (served over
 * HTTPS from a hot-link friendly CDN) referenced by a normal `<img>` tag. Gmail
 * strips inline `<svg>` and refuses SVG `<img>` sources, so the exported email
 * must use a real raster image to actually display the icons.
 *
 * The full block configuration (icons, order, urls, per-icon + block styling)
 * is stored on the block's root `<table>` in the `data-te-social` attribute so
 * saving/reloading a template round-trips the settings exactly.
 */

import siInstagram from 'simple-icons/icons/instagram.svg?raw';
import siFacebook from 'simple-icons/icons/facebook.svg?raw';
import siYoutube from 'simple-icons/icons/youtube.svg?raw';
import siX from 'simple-icons/icons/x.svg?raw';
import siWhatsapp from 'simple-icons/icons/whatsapp.svg?raw';
import siTelegram from 'simple-icons/icons/telegram.svg?raw';
import siPinterest from 'simple-icons/icons/pinterest.svg?raw';
import siTiktok from 'simple-icons/icons/tiktok.svg?raw';
import siSnapchat from 'simple-icons/icons/snapchat.svg?raw';
import siReddit from 'simple-icons/icons/reddit.svg?raw';
import siDiscord from 'simple-icons/icons/discord.svg?raw';
import siGithub from 'simple-icons/icons/github.svg?raw';
import siMedium from 'simple-icons/icons/medium.svg?raw';
import siThreads from 'simple-icons/icons/threads.svg?raw';
import siGoogle from 'simple-icons/icons/google.svg?raw';

export const SOCIAL_DATA_ATTR = 'data-te-social';

export type SocialShape = 'circle' | 'square' | 'none';
export type SocialAlign = 'left' | 'center' | 'right';

export interface SocialIconItem {
  id: string;
  url: string;
  size: number;
  color: string;
  bg: string;
  shape: SocialShape;
  radius: string;
}

export interface SocialConfig {
  version: number;
  icons: SocialIconItem[];
  size: number;
  color: string;
  bg: string;
  shape: SocialShape;
  radius: string;
  spacing: number;
  align: SocialAlign;
  showLabels: boolean;
}

export interface SocialPlatformDef {
  id: string;
  label: string;
  brandColor: string;
  defaultUrl: string;
  /** Returns the inner SVG markup (path elements) using the given fill color. */
  svgInner: (fill: string) => string;
  /** Optional CSS background value (e.g. gradient) used instead of brandColor when the icon uses its default background. */
  cssBackground?: string;
}

function pathFromSvg(raw: string): string {
  const match = raw.match(/<path\b[^>]*\bd="([^"]*)"/);
  return match ? match[1] : '';
}

function svgPath(fill: string, d: string): string {
  return `<path fill="${fill}" d="${d}"/>`;
}

function siPath(raw: string): (fill: string) => string {
  const d = pathFromSvg(raw);
  return (fill) => svgPath(fill, d);
}

/** LinkedIn was removed from simple-icons; the official path is embedded here. */
const LINKEDIN_PATH =
  'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z';

const GLOBE_PATH =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z';

const EMAIL_PATH =
  'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z';

const INSTAGRAM_GRADIENT =
  'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)';

export const SOCIAL_PLATFORMS: SocialPlatformDef[] = [
  { id: 'instagram', label: 'Instagram', brandColor: '#E4405F', defaultUrl: 'https://www.instagram.com/', svgInner: siPath(siInstagram), cssBackground: INSTAGRAM_GRADIENT },
  { id: 'facebook', label: 'Facebook', brandColor: '#1877F2', defaultUrl: 'https://www.facebook.com/', svgInner: siPath(siFacebook) },
  { id: 'linkedin', label: 'LinkedIn', brandColor: '#0A66C2', defaultUrl: 'https://www.linkedin.com/company/', svgInner: (f) => svgPath(f, LINKEDIN_PATH) },
  { id: 'youtube', label: 'YouTube', brandColor: '#FF0000', defaultUrl: 'https://www.youtube.com/', svgInner: siPath(siYoutube) },
  { id: 'x', label: 'X / Twitter', brandColor: '#000000', defaultUrl: 'https://x.com/', svgInner: siPath(siX) },
  { id: 'whatsapp', label: 'WhatsApp', brandColor: '#25D366', defaultUrl: 'https://wa.me/', svgInner: siPath(siWhatsapp) },
  { id: 'telegram', label: 'Telegram', brandColor: '#26A5E4', defaultUrl: 'https://t.me/', svgInner: siPath(siTelegram) },
  { id: 'pinterest', label: 'Pinterest', brandColor: '#BD081C', defaultUrl: 'https://www.pinterest.com/', svgInner: siPath(siPinterest) },
  { id: 'tiktok', label: 'TikTok', brandColor: '#000000', defaultUrl: 'https://www.tiktok.com/', svgInner: siPath(siTiktok) },
  { id: 'snapchat', label: 'Snapchat', brandColor: '#FFFC00', defaultUrl: 'https://www.snapchat.com/', svgInner: siPath(siSnapchat) },
  { id: 'reddit', label: 'Reddit', brandColor: '#FF4500', defaultUrl: 'https://www.reddit.com/', svgInner: siPath(siReddit) },
  { id: 'discord', label: 'Discord', brandColor: '#5865F2', defaultUrl: 'https://discord.gg/', svgInner: siPath(siDiscord) },
  { id: 'github', label: 'GitHub', brandColor: '#181717', defaultUrl: 'https://github.com/', svgInner: siPath(siGithub) },
  { id: 'medium', label: 'Medium', brandColor: '#000000', defaultUrl: 'https://medium.com/', svgInner: siPath(siMedium) },
  { id: 'threads', label: 'Threads', brandColor: '#000000', defaultUrl: 'https://www.threads.net/', svgInner: siPath(siThreads) },
  { id: 'google', label: 'Google', brandColor: '#4285F4', defaultUrl: 'https://www.google.com/', svgInner: siPath(siGoogle) },
  { id: 'website', label: 'Website', brandColor: '#2563EB', defaultUrl: 'https://', svgInner: (f) => svgPath(f, GLOBE_PATH) },
  { id: 'email', label: 'Email', brandColor: '#D44638', defaultUrl: 'mailto:', svgInner: (f) => svgPath(f, EMAIL_PATH) },
];

export function platformById(id: string): SocialPlatformDef {
  return SOCIAL_PLATFORMS.find((p) => p.id === id) || SOCIAL_PLATFORMS[0];
}

/**
 * Icons8 `ios` icon slugs for every supported brand. Icons8 serves real raster
 * PNGs over HTTPS and lets the glyph colour be baked into the URL, so we can
 * honour the chosen icon colour without webfonts, CSS or inline SVG (all of
 * which Gmail strips or blocks in a sent email).
 */
const ICONS8_ICON_NAMES: Record<string, string> = {
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

/**
 * Public, email-safe PNG URL for a social brand. Gmail strips inline `<svg>`
 * and refuses to render SVG `<img>` sources, so the exported email references
 * a real raster PNG served over HTTPS from a CDN that allows hot-linking. The
 * glyph colour is part of the URL (Icons8 `ios` style) which preserves the
 * configured icon colour. Unknown brands fall back to a neutral globe glyph.
 */
export function socialIconImageUrl(brand: string, fill: string): string {
  const hex = String(fill || '#FFFFFF').replace(/^#/, '') || 'FFFFFF';
  const name = ICONS8_ICON_NAMES[String(brand || 'website').toLowerCase()] || 'globe';
  return `https://img.icons8.com/ios/48/${hex}/${name}.png`;
}

export function socialShapeValue(v: unknown): SocialShape {
  return v === 'square' || v === 'none' ? v : 'circle';
}

function toNum(v: unknown, fallback: number): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultSocialConfig(): SocialConfig {
  const mk = (id: string): SocialIconItem => {
    const p = platformById(id);
    return { id, url: p.defaultUrl, size: 40, color: '#FFFFFF', bg: p.brandColor, shape: 'circle', radius: '' };
  };
  return {
    version: 1,
    icons: [mk('instagram'), mk('linkedin'), mk('facebook'), mk('youtube')],
    size: 40,
    color: '#FFFFFF',
    bg: '',
    shape: 'circle',
    radius: '',
    spacing: 8,
    align: 'center',
    showLabels: false,
  };
}

/** Parse the JSON stored in `data-te-social`. Falls back to defaults when invalid. */
export function parseSocialConfig(raw?: string | null): SocialConfig {
  const def = defaultSocialConfig();
  if (!raw) return def;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return def;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SocialConfig).icons)) {
    return def;
  }
  const p = parsed as Partial<SocialConfig>;
  const icons = (p.icons as Partial<SocialIconItem>[] | undefined) || [];
  return {
    version: 1,
    icons: icons.map((ic) => {
      const id = platformById(String(ic.id || '')).id;
      const pl = platformById(id);
      return {
        id,
        url: String(ic.url || pl.defaultUrl || ''),
        size: toNum(ic.size, def.size),
        color: String(ic.color || '#FFFFFF'),
        bg: String(ic.bg || ''),
        shape: socialShapeValue(ic.shape),
        radius: String(ic.radius || ''),
      };
    }),
    size: toNum(p.size, def.size),
    color: String(p.color || '#FFFFFF'),
    bg: String(p.bg || ''),
    shape: socialShapeValue(p.shape),
    radius: String(p.radius || ''),
    spacing: toNum(p.spacing, 8),
    align: p.align === 'left' || p.align === 'right' ? p.align : 'center',
    showLabels: !!p.showLabels,
  };
}

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a single icon (anchor + svg + optional label) as email-safe HTML. */
function buildSocialIconHtml(
  item: SocialIconItem,
  index: number,
  spacing: number,
  showLabels: boolean
): string {
  const platform = platformById(item.id);
  const box = Math.max(Number(item.size) || 40, 12);
  const shape = socialShapeValue(item.shape);
  const hasBg = shape !== 'none';
  const bg = hasBg ? item.bg || platform.brandColor : 'transparent';
  const fill = hasBg ? item.color || '#FFFFFF' : item.color || platform.brandColor;
  const useGradient = hasBg && !!platform.cssBackground && (!item.bg || item.bg === platform.brandColor);
  const bgProp = useGradient ? `background:${platform.cssBackground}` : `background-color:${bg}`;
  const svgRatio = hasBg ? 0.6 : 1;
  const svgSize = Math.max(Math.round(box * svgRatio), 8);
  const pad = hasBg ? Math.round((box - svgSize) / 2) : 0;
  const radius =
    shape === 'circle'
      ? '50%'
      : shape === 'square'
        ? item.radius || `${Math.round(box * 0.22)}px`
        : '0';
  // Email-safe raster image instead of inline SVG (Gmail strips/blocks SVG).
  // The glyph colour is baked into the public PNG URL; a meaningful alt keeps
  // the link usable even if the image cannot load.
  const imgUrl = socialIconImageUrl(platform.id, fill);
  const img = `<img src="${imgUrl}" width="${svgSize}" height="${svgSize}" alt="${escapeAttr(platform.label)}" border="0" style="display:block; margin:${pad}px auto 0; border:0; outline:none; text-decoration:none;" />`;
  const label = showLabels
    ? `<div style="font-family: Arial, Helvetica, sans-serif; font-size:11px; line-height:1.3; color:#475569; text-align:center; margin-top:2px; font-weight:500;">${platform.label}</div>`
    : '';
  const href = item.url || platform.defaultUrl || '#';
  const margin = index === 0 ? '' : `; margin-left:${spacing}px`;
  return (
    `<div style="display:inline-block; text-align:center; vertical-align:top;${margin}">` +
    `<a href="${escapeAttr(href)}" target="_blank" style="display:inline-block; width:${box}px; height:${box}px; text-decoration:none; ${bgProp}; border-radius:${radius}; color:${fill}; text-align:center; vertical-align:middle;">${img}</a>` +
    `${label}` +
    `</div>`
  );
}

/** Render only the icon elements (the cell content) from the current config. */
export function buildSocialIconsHtml(config: SocialConfig): string {
  const { icons, spacing, showLabels } = config;
  return icons
    .map((item, i) => buildSocialIconHtml(item, i, spacing, showLabels))
    .join('');
}

/** Render the inner `<tr>` of the social block from the current config. */
export function buildSocialRowHtml(config: SocialConfig): string {
  const { align } = config;
  return `<tr><td align="${align}" style="padding: 0; font-size: 0; line-height: 0;">${buildSocialIconsHtml(config)}</td></tr>`;
}

/** Full social block markup (root table + data attribute) for the block library. */
export function buildSocialBlockHtml(config: SocialConfig): string {
  const json = JSON.stringify(config);
  return (
    `<table data-te-social="${escapeAttr(json)}" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width: 100%; margin: 0 0 16px;">` +
    buildSocialRowHtml(config) +
    `</table>`
  );
}