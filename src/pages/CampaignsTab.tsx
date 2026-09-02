import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react';
import type { Campaign, EmailTemplate, PendingFollowup, CampaignAttachment } from '../types/campaign';
import type { Contact } from '../types/contact';
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_COLORS,
  CAMPAIGN_TYPE_FALLBACK_COLOR,
  CAMPAIGN_TYPE_TO_TEMPLATE_KEY,
  CAMPAIGN_TYPE_TO_TEMPLATE_NAME,
} from '../constants/constants';
import {
  fetchCampaigns,
  deleteCampaign,
  fetchTemplates,
  buildScheduleInput,
  sendCampaign,
  scheduleCampaign,
  saveDraft,
  uploadCampaignAttachment,
  fetchCampaignAttachments,
  replaceCampaignAttachments,
  removeCampaignAttachment,
  relocatePendingAttachments,
  uploadEmailTemplate,
  deleteEmailTemplate,
  fixBrokenImageUrls,
  formatFileSize,
} from '../services/campaignService';
import { fetchContacts } from '../services/contactsService';
import { fetchContactTypes, type ContactType } from '../services/contactTypesService';
import {
  fetchPendingFollowups,
  sendPendingFollowup,
} from '../services/followupService';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import { supabase } from '../supabase';

interface CampaignsTabProps {
  campaigns: any[];
  contacts?: any[];
  onPersistCampaigns: (campaigns: any[]) => void;
  onToast: (msg: string, type?: string) => void;
  campTabState: 'list' | 'compose' | 'templates' | 'followups';
  setCampTabState: (state: 'list' | 'compose' | 'templates' | 'followups') => void;
  selectedAudienceEmails?: string[];
  onClearSelectedAudienceEmails?: () => void;
}

const TEMPLATE_CATEGORIES = ['All', 'Outreach', 'Pitch', 'Newsletter', 'Client'];

/**
 * True when a template body is a complete HTML email document, exactly as the
 * Template Editor saves it (full <!DOCTYPE>/<html>/<head>/<body> markup,
 * including images, tables, buttons and inline styles). Such bodies must be
 * loaded verbatim into the Campaign composer — never stripped to plain text —
 * so the Campaign preview and the sent email match the saved template.
 * Legacy plain-text templates (which are not HTML documents) keep the
 * plain-text composer behaviour unchanged.
 */
function isFullHtmlDocument(content: string): boolean {
  return /<(?:!doctype|html|head|body)\b/i.test(String(content || '').trim());
}

/**
 * Load a database-backed template's content into the composer. Templates saved
 * by the Template Editor are full HTML documents stored in the `body` column —
 * those are used verbatim (raw HTML preserved, rendered in the preview, and
 * sent as-is). Legacy plain-text bodies keep the existing strip-to-text
 * behaviour so existing templates continue working unchanged.
 */
function applyDatabaseTemplateBody(
  setCompBody: (v: string) => void,
  setBodyIsHtml: (v: boolean) => void,
  setEditorMode: (m: 'text' | 'html' | 'preview') => void,
  body: string
): void {
  if (isFullHtmlDocument(body)) {
    setCompBody(body);
    setBodyIsHtml(true);
    setEditorMode('preview');
  } else {
    setCompBody(stripHtmlTags(body));
    setBodyIsHtml(false);
    setEditorMode('text');
  }
}

/**
 * Convert HTML (template body or stored campaign body) into readable plain text
 * for the plain-text composer. Tags become line breaks, list items become
 * "- " lines, and HTML entities are decoded so placeholders and text stay
 * intact while editing.
 */
function stripHtmlTags(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert the plain-text composer body into clean HTML for the preview.
 * Mirrors the backend `plainTextToHtml` conversion (paragraphs, <br>, lists,
 * escaped entities) so the preview matches what the recipient receives.
 */
function plainTextToHtml(text: string): string {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let openList: 'ul' | 'ol' | null = null;
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
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      if (openList !== type) {
        closeList();
        out.push(`<${type}>`);
        openList = type;
      }
      out.push(`<li>${(bullet ? bullet[2] : (number ? number[2] : line)).trim()}</li>`);
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
 * True when `content` is a raw SMTP/MIME email message rather than an already
 * rendered HTML template. Raw email source begins with transport/routing
 * headers (Delivered-To, Received, MIME-Version, Content-Type, DKIM-Signature,
 * ...) — those lines never begin a saved email template, so their presence is a
 * reliable signal that the stored value is the email SOURCE and must be parsed
 * before it can be previewed as a normal email.
 */
function isMimeEmailSource(content: string): boolean {
  const text = String(content || '');
  if (!text.trim()) return false;
  // A clean HTML document (full <!DOCTYPE>/<html>/<head>/<body> markup) is not
  // raw email source even if it contains a Content-Type meta tag.
  if (/^\s*<(?:!doctype|html|head|body)\b/i.test(text)) return false;
  return /(?:^|\r?\n)(?:Content-Type|MIME-Version|Content-Transfer-Encoding|Message-ID|Return-Path|Delivered-To|Received-SPF|Authentication-Results|DKIM-Signature|ARC-Seal|ARC-Message-Signature|ARC-Authentication-Results|X-Received|X-Google-|Received|Content-Disposition)\s*:/i.test(text);
}

/**
 * Decode a quoted-printable MIME body. Soft line breaks are removed and `=XX`
 * hex escapes are turned back into bytes, which are then decoded as UTF-8 so
 * multibyte characters survive intact.
 */
function decodeQuotedPrintable(input: string): string {
  const joined = String(input || '')
    .replace(/=\r?\n/g, '')
    .replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      const hex = joined.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(0x3d); // bare '=' (not a valid escape)
      }
    } else {
      const char = String.fromCodePoint(joined.codePointAt(i)!);
      const encoded = new TextEncoder().encode(char);
      bytes.push(...encoded);
      i += char.length - 1;
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/**
 * Decode a base64 MIME body as UTF-8 text.
 */
function decodeBase64(input: string): string {
  const clean = String(input || '').replace(/\s+/g, '');
  if (!clean) return '';
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decode a MIME body according to its Content-Transfer-Encoding header.
 * 7bit / 8bit / binary bodies are already usable text and pass through.
 */
function decodeMimeBody(body: string, encoding: string): string {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return decodeBase64(body);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/**
 * Extract the first `text/html` (or, as a fallback, `text/plain`) body from a
 * raw MIME email source, stopping at the multipart boundary. Returns null when
 * the content has no usable body of the requested type.
 */
function extractMimeBody(source: string, kind: 'html' | 'plain'): string | null {
  const text = String(source || '');
  const lines = text.split(/\r?\n/);
  const boundaryMatch = text.match(/boundary\s*=\s*"?([^"\r\n;]+)"?/i);
  const boundary = boundaryMatch ? boundaryMatch[1] : null;
  const headerRe =
    kind === 'html'
      ? /^Content-Type:\s*text\/html(?:\s*;|$)/i
      : /^Content-Type:\s*text\/plain(?:\s*;|$)/i;

  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;

    let encoding = '7bit';
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '') {
      const enc = lines[j].match(/^Content-Transfer-Encoding:\s*(\S+)/i);
      if (enc) encoding = enc[1].toLowerCase();
      j++;
    }
    j++; // skip the blank line separating headers from the body

    const bodyLines: string[] = [];
    while (j < lines.length) {
      const line = lines[j];
      if (boundary && line.trim().startsWith('--' + boundary)) break;
      bodyLines.push(line);
      j++;
    }

    const body = bodyLines.join('\n').replace(/\s+$/, '');
    if (!body.trim()) continue;
    return decodeMimeBody(body, encoding);
  }

  return null;
}

/**
 * Produce the HTML that should be rendered for a stored campaign/template body:
 *  - raw MIME/email source → extract + decode its `text/html` part;
 *  - already-rendered HTML → used verbatim;
 *  - plain text             → kept as-is (the plain-text composer handles it).
 *
 * The raw MIME headers and encoded content are NEVER returned — only the
 * decoded HTML body (or readable plain text) reaches the preview.
 */
function extractRenderableEmailHtml(content: string): { html: string; isHtml: boolean } {
  const text = String(content || '');
  if (isMimeEmailSource(text)) {
    const html = extractMimeBody(text, 'html');
    if (html && html.trim()) return { html, isHtml: true };
    const plain = extractMimeBody(text, 'plain');
    if (plain && plain.trim()) return { html: plain, isHtml: false };
    return { html: stripHtmlTags(text), isHtml: false };
  }
  if (/<[a-z][^>]*>/i.test(text)) return { html: text, isHtml: true };
  return { html: text, isHtml: false };
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHLY_POSITIONS = ['First', 'Second', 'Third', 'Fourth', 'Last'];
const MONTHLY_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const MONTHLY_RULES = MONTHLY_POSITIONS.flatMap((p) => MONTHLY_WEEKDAYS.map((d) => `${p} ${d}`));

// Shared style for the Email Body textarea in both plain-text and HTML-source
// editing modes so switching modes never resizes or restyles the editor.
const BODY_TEXTAREA_STYLE: CSSProperties = {
  flex: 1,
  minHeight: '650px',
  width: '100%',
  border: '1px solid #E2E8F0',
  padding: '16px',
  outline: 'none',
  background: '#FFFFFF',
  borderRadius: '0 0 6px 6px',
  fontSize: '13.5px',
  lineHeight: '1.6',
  color: '#334155',
  overflowY: 'auto',
  resize: 'vertical',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

// Style for the rendered HTML email preview shown in the Email Body card. The
// template's own markup renders at natural size inside a scrollable, white
// container so the design is visible just as a recipient would see it.
const BODY_PREVIEW_STYLE: CSSProperties = {
  flex: 1,
  minHeight: '650px',
  width: '100%',
  border: '1px solid #E2E8F0',
  padding: '16px',
  background: '#FFFFFF',
  borderRadius: '0 0 6px 6px',
  overflowY: 'auto',
  boxSizing: 'border-box',
};

// Style for the editor-mode / HTML view toggle pills (Plain Text · HTML ·
// Preview · Source). `active` renders the pill as selected.
function editorTabStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    border: active ? '1px solid #2563EB' : '1px solid #E2E8F0',
    background: active ? '#EFF6FF' : '#FFFFFF',
    color: active ? '#1D4ED8' : '#64748B',
    transition: 'all 0.15s ease',
  };
}

function RateCell({
  rate,
  count,
  delivered,
  label,
}: {
  rate: number;
  count: number;
  delivered: number;
  label: 'opened' | 'clicked';
}) {
  const value = Math.min(100, Math.max(0, Number(rate) || 0));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <LinearProgress
          variant="determinate"
          value={value}
          sx={{
            width: 52,
            height: 6,
            borderRadius: 999,
            backgroundColor: '#E5E7EB',
            '& .MuiLinearProgress-bar': {
              backgroundColor: '#10B981',
              borderRadius: 999,
            },
          }}
        />
        <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>{value.toFixed(1)}%</div>
      </div>
      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{count}/{delivered} {label}</div>
    </div>
  );
}

function CampaignTypeChip({ type }: { type?: string }) {
  const label = type || 'Campaign';
  const colors = CAMPAIGN_TYPE_COLORS[label] || CAMPAIGN_TYPE_FALLBACK_COLOR;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: colors.bg,
        color: colors.color,
      }}
    >
      {label}
    </span>
  );
}

export default function CampaignsTab({
  campaigns: _propCampaigns,
  contacts: _propContacts,
  onPersistCampaigns,
  onToast,
  campTabState,
  setCampTabState,
  selectedAudienceEmails,
  onClearSelectedAudienceEmails
}: CampaignsTabProps) {
  // ─── SUPABASE STATE ───
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [audienceContacts, setAudienceContacts] = useState<Contact[]>([]);
  const [contactTypes, setContactTypes] = useState<ContactType[]>([]);
  const [, setContactTypesLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // ─── EDITOR STATE ───
  const [compSubject, setCompSubject] = useState('Partnership Opportunity: Design Intelligence for {{company}}');
  const [compName, setCompName] = useState('');
  const [compAudience, setCompAudience] = useState('All Contacts');
  const [compFromName, setCompFromName] = useState('Rupali Sirsath — IUOVA Design Consultancy');
  const [compType, setCompType] = useState('Custom');
  const [compDate, setCompDate] = useState('');
  const [compTime, setCompTime] = useState('10:00 AM');

  // ─── RECURRING SCHEDULE STATE (UI ONLY — NOT PERSISTED) ───
  const [scheduleType, setScheduleType] = useState<'one_time' | 'weekly' | 'monthly'>('one_time');
  const [repeatEvery, setRepeatEvery] = useState(1);
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [monthlyOption, setMonthlyOption] = useState<'day' | 'weekday'>('day');
  const [dayOfMonth, setDayOfMonth] = useState(15);
  const [weekdayRule, setWeekdayRule] = useState('First Monday');

  // ─── BATCH SENDING STATE ───
  const [sendInBatches, setSendInBatches] = useState(false);
  const [batchSize, setBatchSize] = useState(30);
  const [batchDelayHours, setBatchDelayHours] = useState(1);
  const [selectedContacts] = useState<Contact[]>([]);

const DELAY_OPTIONS = [
  { value: 5 / 60, label: '5 Minutes' },
  { value: 10 / 60, label: '10 Minutes' },
  { value: 0.25, label: '15 Minutes' },
  { value: 0.5, label: '30 Minutes' },
  { value: 1, label: '1 Hour' },
  { value: 2, label: '2 Hours' },
  { value: 4, label: '4 Hours' },
  { value: 8, label: '8 Hours' },
  { value: 24, label: '24 Hours' },
];

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [compBody, setCompBody] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // ─── TEMPLATE LOADING / EDITOR MODE STATE ───
  // id of the template currently fetching its HTML from Supabase Storage.
  const [templateLoadingId, setTemplateLoadingId] = useState<string | null>(null);
  // Error message shown when a storage-backed template fails to load.
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  // 'text' = existing plain-text composer (database templates);
  // 'html' = raw HTML source editor (storage-backed templates);
  // 'preview' = rendered email preview (default view after loading a template).
  const [editorMode, setEditorMode] = useState<'text' | 'html' | 'preview'>('text');
  // True when the current Email Body is raw HTML (storage template), false when
  // it is plain text. Drives what the 'preview' mode renders.
  const [bodyIsHtml, setBodyIsHtml] = useState(false);

  // ─── PENDING FOLLOW-UPS STATE (Pending Follow-ups tab) ───
  const [pendingFollowups, setPendingFollowups] = useState<PendingFollowup[]>([]);
  const [pendingFollowupsLoading, setPendingFollowupsLoading] = useState(true);
  const [pendingFollowupsError, setPendingFollowupsError] = useState<string | null>(null);
  const [sendingFollowupId, setSendingFollowupId] = useState<string | null>(null);

  // ─── ATTACHMENTS STATE (composer) ───
  const [attachments, setAttachments] = useState<CampaignAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  // ─── TEMPLATE UPLOAD STATE (Load Template section) ───
  const [templateUploading, setTemplateUploading] = useState(false);
  const [templateUploadError, setTemplateUploadError] = useState<string | null>(null);
  const [templateUploadSuccess, setTemplateUploadSuccess] = useState<string | null>(null);
  const templateFileInputRef = useRef<HTMLInputElement>(null);

  // ─── TEMPLATE DELETE STATE (Load Template section) ───
  const [templateToDelete, setTemplateToDelete] = useState<EmailTemplate | null>(null);
  const [templateDeleting, setTemplateDeleting] = useState(false);
  const [templateInUse, setTemplateInUse] = useState<EmailTemplate | null>(null);
  const [templateDeleteError, setTemplateDeleteError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [prevSelectedEmails, setPrevSelectedEmails] = useState<string[] | undefined>(selectedAudienceEmails);
  if (
    selectedAudienceEmails &&
    selectedAudienceEmails.length > 0 &&
    prevSelectedEmails !== selectedAudienceEmails
  ) {
    setPrevSelectedEmails(selectedAudienceEmails);
    setCompAudience(selectedAudienceEmails.join(', '));
  }

  // ─── TEMPLATES STATE ───
  const [selectedTemplateCategory, setSelectedTemplateCategory] = useState('All');

  const filteredTemplates = templates.filter(t =>
    selectedTemplateCategory === 'All' || t.category === selectedTemplateCategory
  );

  // ─── LOAD DATA FROM SUPABASE ───
  const refreshCampaigns = useCallback(async () => {
    const { data, error } = await fetchCampaigns();
    if (error) {
      setFetchError(error);
      setCampaigns([]);
      onToast('Failed to load campaigns: ' + error, 'error');
    } else {
      setFetchError(null);
      setCampaigns(data);
      onPersistCampaigns(data);
    }
    setLoading(false);
  }, [onPersistCampaigns, onToast]);

  // Silent background refresh — keeps Open Rate / Click Rate live as
  // recipients open and click the sent emails, without spamming toasts.
  const pollCampaigns = useCallback(async () => {
    const { data, error } = await fetchCampaigns();
    if (error) {
      console.error('Campaign auto-refresh failed:', error);
    } else if (data) {
      setFetchError(null);
      setCampaigns(data);
      onPersistCampaigns(data);
    }
  }, [onPersistCampaigns]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    const { data, error } = await fetchTemplates();
    if (error) {
      setTemplatesError(error);
      setTemplates([]);
      onToast('Failed to load templates: ' + error, 'error');
    } else {
      setTemplates(data);
    }
    setTemplatesLoading(false);
  }, [onToast]);

  const loadAudienceContacts = useCallback(async () => {
    const { data, error } = await fetchContacts();
    if (error) {
      onToast('Failed to load contacts: ' + error, 'error');
    } else {
      setAudienceContacts(data);
    }
  }, [onToast]);

  const loadContactTypes = useCallback(async () => {
    setContactTypesLoading(true);
    const { data, error } = await fetchContactTypes();
    if (error) {
      onToast('Failed to load contact types: ' + error, 'error');
      setContactTypes([]);
    } else {
      setContactTypes(data || []);
    }
    setContactTypesLoading(false);
  }, [onToast]);

  const loadPendingFollowups = useCallback(async () => {
    setPendingFollowupsLoading(true);
    setPendingFollowupsError(null);
    try {
      const data = await fetchPendingFollowups();
      setPendingFollowups(data || []);
    } catch (err) {
      setPendingFollowupsError(err instanceof Error ? err.message : 'Failed to load follow-ups');
      setPendingFollowups([]);
    } finally {
      setPendingFollowupsLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      await Promise.all([refreshCampaigns(), loadTemplates(), loadAudienceContacts(), loadContactTypes()]);
    };
    void load();
  }, [refreshCampaigns, loadTemplates, loadAudienceContacts, loadContactTypes]);

  // Auto-refresh the campaign list while it is on screen so Open Rate /
  // Click Rate update after sending and as recipients engage.
  useEffect(() => {
    if (campTabState !== 'list') return;
    const interval = window.setInterval(() => {
      void pollCampaigns();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [campTabState, pollCampaigns]);

  // Load the Pending Follow-ups queue whenever that tab is opened. Deferred so
  // the loading setState does not run synchronously inside the effect.
  useEffect(() => {
    if (campTabState !== 'followups') return;
    const timer = window.setTimeout(() => { void loadPendingFollowups(); }, 0);
    return () => window.clearTimeout(timer);
  }, [campTabState, loadPendingFollowups]);

  // ─── PLAIN-TEXT COMPOSER COMMANDS ───
  const insertMergeTag = (tag: string) => {
    const ta = bodyRef.current;
    if (!ta) {
      setCompBody(prev => prev + tag);
      return;
    }
    const start = ta.selectionStart ?? compBody.length;
    const end = ta.selectionEnd ?? compBody.length;
    const next = compBody.slice(0, start) + tag + compBody.slice(end);
    setCompBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + tag.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  // Match a template by id, legacy key slug, OR name. The `templates` table has
  // no key/slug column, so template.key is a UUID — matching by name is what
  // makes dropdown selection and template cards resolve to the right template.
  const findTemplate = (idOrKey: string) =>
    templates.find(t => t.id === idOrKey || t.key === idOrKey || t.name === idOrKey);

  // Apply a template to the composer: highlight the selected card and replace
  // ONLY the Email Body editor with the template content. The Subject Line is
  // never touched by template selection — it is always typed manually.
  //
  //  - template_source === 'database': body is loaded as PLAIN TEXT so
  //    placeholders like {{first_name}} stay intact while the user edits.
  //    Subject and every other field are left exactly as entered (unchanged
  //    legacy behavior).
  //  - template_source === 'storage': the HTML file is fetched from Supabase
  //    Storage using the row's storage_bucket / storage_path, loaded into the
  //    HTML editor (raw HTML preserved, never converted to plain text). The
  //    Subject Line is left exactly as entered.
  //
  // On a storage fetch failure the previous subject/body are kept untouched and
  // a clear error is shown — the editor never falls back to an empty body.
  const handleSelectTemplate = async (t: EmailTemplate) => {
    setSelectedTemplate(t);
    setTemplateLoadError(null);

    if (t.template_source === 'storage') {
      if (!t.storage_bucket || !t.storage_path) {
        setTemplateLoadError(`Template '${t.name}' is missing a storage bucket or file path.`);
        return;
      }
      setTemplateLoadingId(t.id);
      try {
        const { data } = supabase.storage
          .from(t.storage_bucket)
          .getPublicUrl(t.storage_path);
        if (!data?.publicUrl) {
          throw new Error('Could not resolve the template file URL.');
        }
        const response = await fetch(data.publicUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch template file (HTTP ${response.status}).`);
        }
        const html = await response.text();
        if (!html.trim()) {
          throw new Error('The template file is empty.');
        }
        setCompBody(fixBrokenImageUrls(html));
        setBodyIsHtml(true);
        setEditorMode('preview');
        onToast(`Template '${t.name}' loaded successfully.`, 'success');
      } catch (err) {
        setTemplateLoadError(err instanceof Error ? err.message : 'Failed to load template from storage.');
      } finally {
        setTemplateLoadingId(null);
      }
      return;
    }

    applyDatabaseTemplateBody(setCompBody, setBodyIsHtml, setEditorMode, fixBrokenImageUrls(t.body || ''));
    onToast(`Template '${t.name}' loaded successfully.`, 'success');
  };

  // Load a template by id/key (used by the Template Library) and switch to the
  // composer so the user can review the prefilled content.
  const loadTemplate = (id: string) => {
    const t = findTemplate(id);
    if (!t) return;
    void handleSelectTemplate(t);
    setCampTabState('compose');
  };

  const handleTypeChange = (val: string) => {
    setCompType(val);
    const key = CAMPAIGN_TYPE_TO_TEMPLATE_KEY[val];
    // Resolve the template by legacy key slug, then by the template NAME that
    // corresponds to this type (templates carry no key column in the DB).
    const t =
      (key ? findTemplate(key) : null) ||
      (CAMPAIGN_TYPE_TO_TEMPLATE_NAME[val] ? findTemplate(CAMPAIGN_TYPE_TO_TEMPLATE_NAME[val]) : null);
    // Only the Email Body is replaced with the linked template's content; all
    // other fields (name, subject, from, audience, schedule) stay as entered.
    if (t) {
      if (t.template_source === 'storage') {
        void handleSelectTemplate(t);
      } else {
    applyDatabaseTemplateBody(setCompBody, setBodyIsHtml, setEditorMode, fixBrokenImageUrls(t.body || ''));
      }
    }
  };

  const openComposer = () => {
    setEditingId(null);
    setSelectedTemplate(null);
    setCompName('');
    setCompBody('');
    setBodyIsHtml(false);
    setEditorMode('text');
    setTemplateLoadError(null);
    setTemplateLoadingId(null);
    setAttachments([]);
    setAttachmentError(null);
    setSendInBatches(false);
    setBatchSize(30);
    setBatchDelayHours(1);
    setCampTabState('compose');
  };

  const openEditCampaign = (c: Campaign) => {
    setEditingId(c.id);
    setCompName(c.name);
    setCompSubject(c.subject === 'No Subject' ? '' : c.subject);
    setCompAudience(c.audience || 'All Contacts');
    setCompFromName(c.fromName || 'Rupali Sirsath — IUOVA Design Consultancy');
    setCompType((CAMPAIGN_TYPES as readonly string[]).includes(c.campaignType) ? c.campaignType : 'Custom');
    setCompDate(c.scheduleDate);
    setCompTime(c.scheduleTime || '10:00 AM');
    // Load batch sending settings
    setSendInBatches(c.sendInBatches || false);
    setBatchSize(c.batchSize || 30);
    setBatchDelayHours(c.firstBatchDelayHours || c.subsequentBatchDelayHours || 1);
    // Load the campaign's saved email the way a recipient would see it: raw
    // MIME / email-source bodies are parsed down to their decoded HTML, already
    // rendered HTML is used verbatim, and legacy plain-text bodies stay plain
    // text. The raw MIME headers / encoded content are never shown.
    const extracted = extractRenderableEmailHtml(c.emailBody || '');
    setCompBody(extracted.html);
    setBodyIsHtml(extracted.isHtml);
    setEditorMode(extracted.isHtml ? 'preview' : 'text');
    setAttachments([]);
    setAttachmentError(null);
    setCampTabState('compose');

    // Load the campaign's saved attachments (best-effort).
    void (async () => {
      const { data: savedAttachments, error: attErr } = await fetchCampaignAttachments(c.id);
      if (attErr) {
        onToast('Failed to load attachments: ' + attErr, 'error');
      } else {
        setAttachments(savedAttachments);
      }
    })();
  };

  // Generate audience segments from database contact_types with counts from contacts
  const getAudienceSegments = useCallback(() => {
    const contactTypeCounts = new Map<string, number>();
    for (const contact of audienceContacts) {
      const type = contact.type?.trim();
      if (type) {
        contactTypeCounts.set(type, (contactTypeCounts.get(type) || 0) + 1);
      }
    }
    const segments: Array<{ value: string; label: string; count: number }> = [
      { value: 'All Contacts', label: 'All Contacts', count: audienceContacts.length },
    ];
    // Add all active contact types from the database, with their counts from contacts
    for (const ct of contactTypes) {
      if (ct.is_active) {
        const count = contactTypeCounts.get(ct.name) || 0;
        segments.push({ value: ct.name, label: ct.name, count });
      }
    }
    return segments;
  }, [audienceContacts, contactTypes]);

  const audienceSegments = getAudienceSegments();

  const getSegmentCount = (segment: string) => {
    // If we have selected contacts from drag-and-drop, use that count
    if (selectedContacts.length > 0) return selectedContacts.length;
    if (segment === 'All Contacts') return audienceContacts.length;
    const found = audienceSegments.find(s => s.value === segment);
    if (found) return found.count;
    if (segment.includes(',') || segment.includes('@')) {
      return segment.split(',').filter(Boolean).length;
    }
    return 0;
  };

  // ─── LAUNCH OR SCHEDULE ───
  const handleSaveCampaign = async (status: 'sent' | 'scheduled' | 'draft') => {
    if (saving) return;
    if (!compName.trim()) {
      onToast('Campaign Name is required', 'error');
      return;
    }
    const bodyText = compBody;
    if (!bodyText.trim()) {
      onToast('Email Body cannot be empty', 'error');
      return;
    }

    // Confirmation logic for sending or scheduling to target recipients
    if (status === 'sent' || status === 'scheduled') {
      const recipientCount = getSegmentCount(compAudience);
      const actionVerb = status === 'sent' ? 'send immediately' : 'schedule';
      const confirmMsg = `Are you sure you want to ${actionVerb} this campaign to ${recipientCount} recipient(s)?`;
      if (!window.confirm(confirmMsg)) {
        return;
      }
    }

    const selectedTemplate = findTemplate(compType);

    const includeSchedule =
      status === 'scheduled' ||
      scheduleType === 'one_time' ||
      scheduleType === 'weekly' ||
      scheduleType === 'monthly';

    const payload = {
      id: editingId !== null ? String(editingId) : null,
      campaign_name: compName.trim(),
      subject_line: compSubject.trim() || '',
      from_name: compFromName.trim() || '',
      audience_segment: compAudience || 'All Contacts',
      campaign_type: compType || '',
      html_content: bodyText || '',
      schedule_date: status === 'scheduled' ? (compDate || undefined) : undefined,
      schedule_time: status === 'scheduled' ? (compTime || undefined) : undefined,
      template_name: selectedTemplate?.name || null,
      template_id: selectedTemplate?.id || null,
      schedule: includeSchedule
        ? buildScheduleInput({
            scheduleType,
            compDate,
            compTime,
            repeatEvery,
            selectedDays,
            monthlyOption,
            dayOfMonth,
            weekdayRule,
          })
        : null,
      attachments: attachments.map((a) => ({
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        storage_bucket: a.storage_bucket,
        storage_path: a.storage_path,
      })),
      // Selected contact IDs from drag-and-drop (takes precedence over audience_segment)
      selected_contact_ids: selectedContacts.length > 0 ? selectedContacts.map((c) => c.id) : undefined,
      // Batch sending parameters (user configurable)
      send_in_batches: sendInBatches,
      batch_size: sendInBatches ? batchSize : undefined,
      first_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
      subsequent_batch_delay_hours: sendInBatches ? batchDelayHours : undefined,
    };

    setSaving(true);
    try {
      // Move a brand-new composer's not-yet-persisted files into the campaign's
      // Storage folder (campaign-attachments/{campaign_name}/{file_name}) BEFORE
      // the campaign is sent or its attachment metadata is persisted, so the
      // stored storage_path always equals the real object path. The saved
      // campaign_name equals the trimmed payload.campaign_name (saveCampaignCloud
      // stores String(payload.campaign_name).trim()).
      if (attachments.length > 0) {
        const relocated = await relocatePendingAttachments(payload.campaign_name, attachments);
        setAttachments(relocated);
        payload.attachments = relocated.map((a) => ({
          file_name: a.file_name,
          file_type: a.file_type,
          file_size: a.file_size,
          storage_bucket: a.storage_bucket,
          storage_path: a.storage_path,
        }));
      }

      let savedCampaignId: string | null = null;
      if (status === 'sent') {
        const result = await sendCampaign(payload) as { campaign_id?: string };
        savedCampaignId = result?.campaign_id || null;
        onToast('Campaign sent successfully!', 'success');
      } else if (status === 'scheduled') {
        const result = await scheduleCampaign(payload) as { campaign_id?: string };
        savedCampaignId = result?.campaign_id || null;
        onToast(`Campaign scheduled for ${compDate}`, 'success');
      } else {
        const result = await saveDraft(payload) as { id?: string; campaign_id?: string };
        savedCampaignId = result?.id || result?.campaign_id || null;
        onToast('Campaign saved as draft', 'success');
      }

      // Persist the attachment metadata against the saved campaign. Send Now
      // carries the list inside the send-campaign Edge Function payload (it
      // creates the campaign row), so only schedule/draft persist it here —
      // best-effort: a failure must not undo the campaign save.
      if (savedCampaignId && status !== 'sent') {
        const { error: attError } = await replaceCampaignAttachments(
          String(savedCampaignId),
          payload.attachments
        );
        if (attError) {
          onToast('Campaign saved, but attachments could not be saved: ' + attError, 'error');
        }
      }

      // Reset Form
      setEditingId(null);
      setCompName('');
      setCompSubject('');
      setCompDate('');
      setCompTime('10:00 AM');
      setScheduleType('one_time');
      setRepeatEvery(1);
      setSelectedDays([]);
      setMonthlyOption('day');
      setDayOfMonth(15);
      setWeekdayRule('First Monday');
setCompBody('');
    setBodyIsHtml(false);
    setEditorMode('text');
    setAttachments([]);
      setAttachmentError(null);
      setCampTabState('list');
      if (onClearSelectedAudienceEmails) {
        onClearSelectedAudienceEmails();
      }
      setLoading(true);
      await refreshCampaigns();
    } catch (error: any) {
      onToast(error?.message || 'Failed to save campaign', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    if (!confirm('Delete this campaign?')) return;
    const { error } = await deleteCampaign(id);
    if (error) {
      onToast('Failed to delete campaign: ' + error, 'error');
      return;
    }
    setLoading(true);
    await refreshCampaigns();
    onToast('Campaign deleted', 'info');
  };

  // Send one pending follow-up from the Pending Follow-ups tab.
  const handleSendFollowup = async (id: string) => {
    if (sendingFollowupId) return;
    if (!window.confirm('Send this follow-up email now?')) return;
    setSendingFollowupId(id);
    try {
      await sendPendingFollowup(id);
      onToast('Follow-up sent', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to send follow-up', 'error');
    } finally {
      setSendingFollowupId(null);
      await loadPendingFollowups();
    }
  };

  const formatDateTime = (input?: string | null) => {
    if (!input) return '—';
    const date = new Date(input);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  // Upload the chosen files to Supabase Storage and add their metadata to the
  // composer's list. For an EXISTING campaign the metadata row is persisted
  // immediately (real campaign_id / storage_bucket / storage_path). For a
  // brand-NEW campaign only the file is uploaded — the attachment stays in
  // temporary composer state (no campaign row is created) and its metadata is
  // persisted after Save Draft / Send Now / Schedule creates the campaign.
  const handleAddAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingAttachment(true);
    setAttachmentError(null);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadCampaignAttachment(file, editingId);
        setAttachments((prev) => [...prev, uploaded]);
      }
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to upload attachment');
    } finally {
      setUploadingAttachment(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  };

  // Remove an attachment: delete its Storage object (best-effort) and, when the
  // metadata was already persisted against a saved campaign, its DB row, then
  // drop it from the composer's list. Before a campaign is saved a temporary
  // attachment is only removed from composer state — no campaign row is ever
  // created or deleted here.
  const handleRemoveAttachment = async (attachment: CampaignAttachment) => {
    const { error } = await removeCampaignAttachment(attachment);
    if (error) {
      onToast(error, 'error');
      return;
    }
    const remaining = attachments.filter((a) => a.storage_path !== attachment.storage_path);
    setAttachments(remaining);

    onToast(`Removed ${attachment.file_name}`, 'info');
  };

  // Upload a .html/.htm email template file into the existing template storage
  // + templates table (template_source='storage'), then add it to the local
  // list so the new card shows up in Load Template / Template Library
  // immediately. The template persists in Supabase, so it survives a refresh.
  const handleUploadTemplate = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setTemplateUploading(true);
    setTemplateUploadError(null);
    setTemplateUploadSuccess(null);
    try {
      const uploaded = await uploadEmailTemplate(file);
      setTemplates((prev) =>
        [...prev, uploaded].sort((a, b) => a.name.localeCompare(b.name))
      );
      setTemplateUploadSuccess('Template uploaded successfully');
      onToast(`Template '${uploaded.name}' uploaded successfully.`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload template';
      setTemplateUploadError(message);
      onToast(message, 'error');
    } finally {
      setTemplateUploading(false);
      if (templateFileInputRef.current) templateFileInputRef.current.value = '';
    }
  };

  // Ask for confirmation before deleting a template. Nothing is deleted until
  // the user confirms in the dialog — Cancel closes it and leaves the card.
  const requestDeleteTemplate = (t: EmailTemplate) => {
    setTemplateDeleteError(null);
    setTemplateToDelete(t);
  };

  // Cancel the delete confirmation — close the dialog, do nothing.
  const cancelDeleteTemplate = () => {
    if (templateDeleting) return;
    setTemplateToDelete(null);
    setTemplateDeleteError(null);
  };

  // Confirm deletion: delete ONLY the selected email template (by its real DB
  // id) through the shared template service. The card is removed from the
  // list on success; a template currently used by a campaign is blocked with a
  // "Template In Use" warning. Other campaign fields / contacts / sequences /
  // follow-ups are never touched.
  const confirmDeleteTemplate = async () => {
    if (!templateToDelete) return;
    setTemplateDeleting(true);
    setTemplateDeleteError(null);
    try {
      const result = await deleteEmailTemplate(templateToDelete);
      if (!result.ok) {
        if (result.inUse) {
          setTemplateInUse(templateToDelete);
          setTemplateToDelete(null);
        } else {
          setTemplateDeleteError(result.error || 'Failed to delete template');
        }
        return;
      }
      const deleted = templateToDelete;
      setTemplates((prev) => prev.filter((t) => t.id !== deleted.id));
      setSelectedTemplate((prev) => (prev && prev.id === deleted.id ? null : prev));
      setTemplateToDelete(null);
      onToast(`Template '${deleted.name}' deleted successfully.`, 'success');
    } catch (err) {
      setTemplateDeleteError(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setTemplateDeleting(false);
    }
  };

  // Open Preview Modal
  const openPreview = () => {
    // In HTML mode the body is already markup; in plain-text mode convert it to
    // the same clean HTML the backend will generate. Then replace merge tags
    // with sample values for the preview. A body loaded as HTML (template or
    // extracted from a raw email source) is always rendered directly — it must
    // never be re-escaped through plainTextToHtml.
    let html =
      bodyIsHtml || editorMode === 'html'
        ? String(compBody || '')
        : plainTextToHtml(compBody);
    html = html
      .replace(/{{first_name}}/g, 'Rajiv')
      .replace(/{{company}}/g, 'Bajaj Electricals')
      .replace(/{{month}}/g, 'May')
      .replace(/{{headline}}/g, 'The Future of Fans')
      .replace(/{{issue}}/g, '08');

    setPreviewHtml(html);
    setPreviewOpen(true);
  };

  return (
    <div className="page active">
      {/* Tab bar header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '18px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 700 }}>Campaigns</div>
          <div style={{ fontSize: '12px', color: 'var(--text4)', marginTop: '2px' }}>
            Build and monitor your outreach campaigns
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {campTabState !== 'list' && (
            <button className="btn btn-ghost btn-sm" onClick={() => setCampTabState('list')}>Back to campaigns</button>
          )}
          {campTabState !== 'compose' && (
            <button className="btn btn-primary btn-sm" onClick={openComposer}>Compose Campaign</button>
          )}
        </div>
      </div>

      {/* Mini tabs */}
      <div className="tabs">
        <div className={`tab ${campTabState === 'list' ? 'active' : ''}`} onClick={() => setCampTabState('list')}>Active Campaigns</div>
        <div className={`tab ${campTabState === 'compose' ? 'active' : ''}`} onClick={openComposer}>Composer & Editor</div>
        <div className={`tab ${campTabState === 'templates' ? 'active' : ''}`} onClick={() => setCampTabState('templates')}>Template Library</div>
        <div className={`tab ${campTabState === 'followups' ? 'active' : ''}`} onClick={() => setCampTabState('followups')}>Pending Follow-ups</div>
      </div>

      {/* ─── RENDER: LIST ─── */}
      {campTabState === 'list' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '24%' }}>Campaign Name</th>
                <th>Type</th>
                <th>Audience</th>
                <th>Sent</th>
                <th style={{ width: '22%' }}>Schedule</th>
                <th>Delivered</th>
                <th>Open Rate</th>
                <th>Click Rate</th>
                <th>Status</th>
                <th style={{ width: '90px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">⟳</div>
                      <div className="empty-title">Loading campaigns…</div>
                    </div>
                  </td>
                </tr>
              ) : campaigns.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <div className="empty-state">
                      <div className="empty-icon">✉</div>
                      <div className="empty-title">No campaigns yet</div>
                      <div className="empty-sub">
                        {fetchError ? fetchError : 'Create your first campaign or choose an email template to begin.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                campaigns.map(c => {
                  const isSent = c.status.toLowerCase() === 'sent';

                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{c.name}</div>
                      </td>
                      <td>
                        <CampaignTypeChip type={c.campaignType} />
                      </td>
                      <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{c.audience}</td>
                      <td style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text2)' }}>{c.sentCount}</td>
                      <td>
                        <Tooltip title={c.scheduleText} placement="top" arrow>
                          <span style={{
                            display: 'block',
                            fontSize: '11px',
                            color: 'var(--text4)',
                            fontFamily: 'var(--mono)',
                            maxWidth: '260px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            ...(c.scheduleText && c.scheduleText.trim() !== '' && c.scheduleText !== '--'
                              ? { fontWeight: 700, color: 'var(--text2)' }
                              : {}),
                          }}>
                            {c.scheduleText}
                          </span>
                        </Tooltip>
                      </td>
                      <td style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text2)' }}>
                        {isSent ? c.deliveredCount : '—'}
                      </td>
                      <td>
                        {c.deliveredCount > 0 ? (
                          <RateCell rate={c.openRate} count={c.openedCount} delivered={c.deliveredCount} label="opened" />
                        ) : '—'}
                      </td>
                      <td>
                        {c.deliveredCount > 0 ? (
                          <RateCell rate={c.clickRate} count={c.clickedCount} delivered={c.deliveredCount} label="clicked" />
                        ) : '—'}
                      </td>
                      <td>
                        <span className={`tag ${
                          c.status.toLowerCase() === 'sent' ? 'tag-client' :
                          c.status.toLowerCase() === 'scheduled' ? 'tag-oem' : 'tag-draft'
                        }`}>{c.status}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <button className="btn-icon" title="Edit campaign" onClick={() => openEditCampaign(c)}>✎</button>
                          <button className="btn-icon" title="Delete" onClick={() => handleDeleteCampaign(c.id)} style={{ color: 'var(--red)' }}>✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── RENDER: COMPOSE ─── */}
      {campTabState === 'compose' && (
        <div className="composer-layout" style={{ fontFamily: '"Inter", sans-serif' }}>
          {/* LEFT COLUMN */}
          <div className="composer-left">
            {/* CARD 1: CAMPAIGN DETAILS */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '16px', fontWeight: 700, textTransform: 'uppercase' }}>Campaign Details</div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Campaign Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Polycab Retainer Pitch — June 2026"
                    value={compName}
                    onChange={(e) => setCompName(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Subject Line *</label>
                  <input
                    type="text"
                    placeholder="Partnership Opportunity: Design Intelligence for {{company}}"
                    value={compSubject}
                    onChange={(e) => setCompSubject(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>From Name</label>
                  <input
                    type="text"
                    value={compFromName}
                    onChange={(e) => setCompFromName(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Audience Segment</label>
                  <select
                    value={compAudience}
                    onChange={(e) => setCompAudience(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FFFFFF', cursor: 'pointer' }}
                  >
                    {audienceSegments.map((segment) => (
                      <option key={segment.value} value={segment.value}>
                        {segment.label} ({segment.count})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Campaign Type</label>
                  <select
                    value={compType}
                    onChange={(e) => handleTypeChange(e.target.value)}
                    style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#FFFFFF', cursor: 'pointer' }}
                  >
                    {CAMPAIGN_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>

                {/* ─── SCHEDULE SETTINGS ─── */}
                <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
                <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Schedule Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Schedule Type</div>
                  <div style={{ display: 'flex', gap: '24px' }}>
                    {([
                      { key: 'one_time', label: 'One Time' },
                      { key: 'weekly', label: 'Weekly' },
                      { key: 'monthly', label: 'Monthly' },
                    ] as { key: 'one_time' | 'weekly' | 'monthly'; label: string }[]).map(({ key, label }) => (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                        <input
                          type="radio"
                          name="scheduleType"
                          checked={scheduleType === key}
                          onChange={() => setScheduleType(key)}
                          style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                {scheduleType === 'one_time' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '12px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Schedule Date</label>
                      <input
                        type="date"
                        value={compDate}
                        onChange={(e) => setCompDate(e.target.value)}
                        style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '100%', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}

                {scheduleType === 'weekly' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                      <input
                        type="number"
                        min={1}
                        value={repeatEvery}
                        onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                        style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: '#64748B' }}>Week(s)</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Send On</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: '8px' }}>
                        {WEEKDAY_NAMES.map((day) => {
                          const isChecked = selectedDays.includes(day);
                          return (
                            <label key={day} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => setSelectedDays((prev) => (isChecked ? prev.filter((d) => d !== day) : [...prev, day]))}
                                style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                              />
                              {day}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}

                {scheduleType === 'monthly' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#334155' }}>Repeat Every</span>
                      <input
                        type="number"
                        min={1}
                        value={repeatEvery}
                        onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))}
                        style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center' }}
                      />
                      <span style={{ fontSize: '13px', color: '#64748B' }}>Month(s)</span>
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>Monthly Schedule</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                          <input
                            type="radio"
                            name="monthlyOption"
                            checked={monthlyOption === 'day'}
                            onChange={() => setMonthlyOption('day')}
                            style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                          />
                          Day of Month
                          <input
                            type="number"
                            min={1}
                            max={31}
                            value={dayOfMonth}
                            disabled={monthlyOption !== 'day'}
                            onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                            style={{ width: '64px', height: '40px', padding: '0 8px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', textAlign: 'center', background: monthlyOption === 'day' ? '#FFFFFF' : '#F8FAFC', opacity: monthlyOption === 'day' ? 1 : 0.5 }}
                          />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                          <input
                            type="radio"
                            name="monthlyOption"
                            checked={monthlyOption === 'weekday'}
                            onChange={() => setMonthlyOption('weekday')}
                            style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                          />
                          Weekday
                          <select
                            value={weekdayRule}
                            disabled={monthlyOption !== 'weekday'}
                            onChange={(e) => setWeekdayRule(e.target.value)}
                            style={{ height: '40px', padding: '0 10px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: monthlyOption === 'weekday' ? '#FFFFFF' : '#F8FAFC', cursor: 'pointer', opacity: monthlyOption === 'weekday' ? 1 : 0.5, minWidth: '150px' }}
                          >
                            {MONTHLY_RULES.map((rule) => (
                              <option key={rule} value={rule}>{rule}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: '14px', fontWeight: 600, color: '#334155', display: 'block', marginBottom: '6px' }}>Time (IST)</label>
                      <input
                        type="text"
                        value={compTime}
                        onChange={(e) => setCompTime(e.target.value)}
                        style={{ width: '160px', height: '48px', padding: '0 16px', border: '1px solid #E2E8F0', borderRadius: '10px', fontSize: '13px', outline: 'none' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ─── SENDING LIMITS / BATCH SENDING ─── */}
              <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Sending Limits</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#334155', cursor: 'pointer', fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    checked={sendInBatches}
                    onChange={(e) => setSendInBatches(e.target.checked)}
                    style={{ accentColor: '#2563EB', width: '16px', height: '16px', cursor: 'pointer', margin: 0 }}
                  />
                  Send in batches
                </label>

                {sendInBatches && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '10px' }}>
                    <div style={{ display: 'flex', gap: '24px' }}>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Batch Size</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <input
                            type="number"
                            value={batchSize}
                            onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                            min={1}
                            max={1000}
                            style={{
                              width: '100px',
                              height: '40px',
                              padding: '0 12px',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              fontSize: '13px',
                              outline: 'none',
                              background: '#FFFFFF',
                              color: '#334155',
                              textAlign: 'center',
                            }}
                          />
                          <span style={{ fontSize: '13px', color: '#64748B' }}>contacts</span>
                        </div>
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Send next batch after</label>
                        <select
                          value={batchDelayHours}
                          onChange={(e) => setBatchDelayHours(parseFloat(e.target.value))}
                          style={{
                            width: '100%',
                            height: '40px',
                            padding: '0 12px',
                            border: '1px solid #E2E8F0',
                            borderRadius: '8px',
                            fontSize: '13px',
                            outline: 'none',
                            background: '#FFFFFF',
                            color: '#334155',
                            cursor: 'pointer',
                          }}
                        >
                          {DELAY_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {(() => {
                      const totalRecipients = getSegmentCount(compAudience);
                      const estimatedBatches = totalRecipients > 0 && batchSize > 0 ? Math.ceil(totalRecipients / batchSize) : 0;
                      const delayLabel = DELAY_OPTIONS.find(o => o.value === batchDelayHours)?.label || '1 Hour';
                      
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          <div style={{ fontSize: '13px', color: '#1D4ED8', fontWeight: 500 }}>
                            {batchSize} contacts will be sent every {delayLabel}.
                          </div>
                          <div style={{ fontSize: '12px', color: '#475569' }}>
                            Audience: {compAudience} ({totalRecipients})
                          </div>
                          <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                            Estimated batches: {estimatedBatches}
                          </div>
                          
                          {estimatedBatches > 0 && (
                            <div style={{ 
                              maxHeight: '200px', 
                              overflowY: 'auto', 
                              fontSize: '12px', 
                              color: '#334155',
                              background: '#FFFFFF',
                              border: '1px solid #E2E8F0',
                              borderRadius: '8px',
                              padding: '12px'
                            }}>
                              {Array.from({ length: estimatedBatches }, (_, i) => {
                                const start = i * batchSize + 1;
                                const end = Math.min((i + 1) * batchSize, totalRecipients);
                                return (
                                  <div key={i} style={{ padding: '4px 0', borderBottom: i < estimatedBatches - 1 ? '1px solid #F1F5F9' : 'none' }}>
                                    Batch {i + 1}: S.No. {start}–{end}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* ─── ATTACHMENTS ─── */}
              <div style={{ height: '1px', background: '#E5E7EB', margin: '4px 0 8px' }} />
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Attachments</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip"
                  onChange={(e) => void handleAddAttachments(e.target.files)}
                />
                <button
                  type="button"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={uploadingAttachment}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    width: '100%',
                    height: '48px',
                    background: uploadingAttachment ? '#F1F5F9' : '#FFFFFF',
                    color: uploadingAttachment ? '#94A3B8' : '#1D4ED8',
                    border: uploadingAttachment ? '1px solid #E2E8F0' : '1px dashed #93C5FD',
                    borderRadius: '10px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: uploadingAttachment ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseOver={(e) => { if (!uploadingAttachment) e.currentTarget.style.background = '#EFF6FF'; }}
                  onMouseOut={(e) => { if (!uploadingAttachment) e.currentTarget.style.background = '#FFFFFF'; }}
                >
                  {uploadingAttachment ? 'Uploading…' : '+ Add Attachment / Upload File'}
                </button>
                <div style={{ fontSize: '11px', color: '#8A94A6' }}>
                  Supported: PDF, images (JPG, PNG, WEBP, GIF), videos (MP4, MOV, WEBM) and other common email attachments (max 20 MB each).
                </div>

                {attachmentError && (
                  <div style={{ fontSize: '12px', color: '#DC2626' }}>{attachmentError}</div>
                )}

                {attachments.length === 0 ? (
                  <div style={{ fontSize: '12px', color: '#8A94A6', padding: '10px 0' }}>
                    No attachments yet. Upload files to include them when the campaign email is sent.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {attachments.map((att) => (
                      <div
                        key={att.storage_path}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '10px 12px',
                          border: '1px solid #E5E7EB',
                          borderRadius: '10px',
                          background: '#F8FAFC',
                        }}
                      >
                        <span style={{
                          fontSize: '10px',
                          fontWeight: 700,
                          color: '#1D4ED8',
                          background: '#EFF6FF',
                          border: '1px solid #BFDBFE',
                          borderRadius: '6px',
                          padding: '3px 6px',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                        }}>
                          {(att.file_type.split('/').pop() || 'file').slice(0, 10)}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.file_name}</span>
                          <span style={{ fontSize: '11.5px', color: '#8A94A6' }}>
                            {att.file_type || 'Unknown type'} • {formatFileSize(att.file_size)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRemoveAttachment(att)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#DC2626',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            padding: '6px 8px',
                            borderRadius: '6px',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                          onMouseOver={(e) => { e.currentTarget.style.background = '#FEE2E2'; }}
                          onMouseOut={(e) => { e.currentTarget.style.background = 'none'; }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </div>
            </div>

            {/* CARD 2: MERGE TAGS */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '12px', fontWeight: 700, textTransform: 'uppercase' }}>Merge Tags - Click to Insert</div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {['{{first_name}}', '{{company}}', '{{designation}}', '{{city}}', '{{month}}'].map(tag => (
                  <button
                    key={tag}
                    onClick={() => insertMergeTag(tag)}
                    style={{
                      background: '#EFF6FF',
                      border: '1px solid #BFDBFE',
                      color: '#1D4ED8',
                      padding: '6px 14px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      cursor: 'pointer',
                      fontWeight: 500,
                      transition: 'all 0.15s ease'
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#DBEAFE'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = '#EFF6FF'; }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            {/* CARD 3: ACTIONS ROW */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => handleSaveCampaign('sent')}
                disabled={saving}
                style={{
                  background: '#10B981',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#059669'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#10B981'; }}
              >
                {saving ? 'Sending…' : 'Send Now'}
              </button>
              <button
                type="button"
                onClick={() => handleSaveCampaign('scheduled')}
                disabled={saving}
                style={{
                  background: '#2563EB',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#1D4ED8'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#2563EB'; }}
              >
                {saving ? 'Scheduling…' : 'Schedule Campaign'}
              </button>
              <button
                type="button"
                onClick={() => handleSaveCampaign('draft')}
                disabled={saving}
                style={{
                  background: '#FFFFFF',
                  color: '#4A5568',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { if (!saving) e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseOut={(e) => { if (!saving) e.currentTarget.style.background = '#FFFFFF'; }}
              >
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
              <button
                type="button"
                onClick={openPreview}
                style={{
                  background: '#FFFFFF',
                  color: '#4A5568',
                  border: '1px solid #E2E8F0',
                  borderRadius: '10px',
                  padding: '0 24px',
                  height: '44px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: 'background 0.15s'
                }}
                onMouseOver={(e) => { e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseOut={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
              >
                Preview
              </button>
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="composer-right">
            {/* CARD 4: LOAD TEMPLATE */}
            <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)' }}>
              <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', marginBottom: '14px', fontWeight: 700, textTransform: 'uppercase' }}>Load Template</div>

              {/* Upload an HTML email template (.html / .htm) */}
              <input
                ref={templateFileInputRef}
                type="file"
                hidden
                accept=".html,.htm,text/html"
                onChange={(e) => void handleUploadTemplate(e.target.files)}
              />
              <button
                type="button"
                onClick={() => templateFileInputRef.current?.click()}
                disabled={templateUploading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  height: '48px',
                  background: templateUploading ? '#F1F5F9' : '#FFFFFF',
                  color: templateUploading ? '#94A3B8' : '#1D4ED8',
                  border: templateUploading ? '1px solid #E2E8F0' : '1px dashed #93C5FD',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: templateUploading ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseOver={(e) => { if (!templateUploading) e.currentTarget.style.background = '#EFF6FF'; }}
                onMouseOut={(e) => { if (!templateUploading) e.currentTarget.style.background = '#FFFFFF'; }}
              >
                {templateUploading ? 'Uploading…' : '+ Upload Template'}
              </button>
              <div style={{ fontSize: '11px', color: '#8A94A6', marginTop: '6px' }}>
                Supported: .html / .htm email template files.
              </div>

              {templateUploadSuccess && (
                <div style={{ fontSize: '12px', color: '#059669', marginTop: '8px' }}>{templateUploadSuccess}</div>
              )}
              {templateUploadError && (
                <div style={{ fontSize: '12px', color: '#DC2626', marginTop: '8px' }}>{templateUploadError}</div>
              )}

              {templatesLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
                  <CircularProgress size={26} />
                </div>
              ) : templatesError ? (
                <div style={{ fontSize: '12px', color: 'var(--red)', padding: '8px 0' }}>
                  {templatesError}
                </div>
              ) : templates.length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--text4)', padding: '8px 0' }}>
                  No templates available
                </div>
              ) : (
                <>
                  {templateDeleteError && (
                    <div style={{ fontSize: '12px', color: 'var(--red)', padding: '0 0 10px 0', lineHeight: 1.4 }}>
                      Could not delete template: {templateDeleteError}
                    </div>
                  )}
                  {templateLoadError && (
                    <div style={{ fontSize: '12px', color: 'var(--red)', padding: '0 0 10px 0', lineHeight: 1.4 }}>
                      {templateLoadError}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {templates.map((tmpl) => {
                    const isActive = selectedTemplate?.id === tmpl.id;
                    const isLoading = templateLoadingId === tmpl.id;
                    return (
                      <div
                        key={tmpl.id}
                        onClick={() => void handleSelectTemplate(tmpl)}
                        style={{
                          padding: '12px 14px',
                          borderRadius: '12px',
                          border: isActive ? '2px solid #2563EB' : '1px solid #E5E7EB',
                          background: isActive ? '#EFF6FF' : '#FFFFFF',
                          cursor: isLoading ? 'wait' : 'pointer',
                          transition: 'all 0.15s ease',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          boxSizing: 'border-box',
                          pointerEvents: isLoading ? 'none' : 'auto',
                          opacity: isLoading ? 0.6 : 1
                        }}
                        onMouseOver={(e) => {
                          if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#CBD5E1';
                        }}
                        onMouseOut={(e) => {
                          if (!isActive && !isLoading) e.currentTarget.style.borderColor = '#E5E7EB';
                        }}
                      >
                        {isLoading ? (
                          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                            <CircularProgress size={22} />
                          </div>
                        ) : (
                          <>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: isActive ? '#1E40AF' : '#1E293B', marginBottom: '4px' }}>{tmpl.name}</div>
                            <div style={{ fontSize: '11px', color: isActive ? '#3B82F6' : '#64748B' }}>{tmpl.description}</div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '10px' }}>
                              <button
                                type="button"
                                className="btn btn-danger btn-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestDeleteTemplate(tmpl);
                                }}
                                title="Delete this template"
                                style={{ lineHeight: 1, padding: '5px 10px' }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleSelectTemplate(tmpl);
                                }}
                                title="Load this template"
                                style={{ lineHeight: 1, padding: '5px 14px' }}
                              >
                                Load
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>
              )}
            </div>

          {/* CARD 5: EMAIL BODY */}
          <div className="card" style={{ padding: '24px', background: '#FFFFFF', borderRadius: '16px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)', display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', letterSpacing: '0.05em', color: '#8A94A6', fontWeight: 700, textTransform: 'uppercase' }}>Email Body</div>
              </div>
              
              {/* Editor mode toggle: Plain Text (editable) / HTML (editable source) / Preview (rendered email) */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => setEditorMode('text')}
                  style={editorTabStyle(editorMode === 'text')}
                >
                  Plain Text
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('html')}
                  style={editorTabStyle(editorMode === 'html')}
                >
                  HTML
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode('preview')}
                  style={editorTabStyle(editorMode === 'preview')}
                >
                  Preview
                </button>
              </div>

              {editorMode === 'text' ? (
                <>
                  {/* Plain-text editor hint */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '8px 12px',
                    border: '1px solid #E2E8F0',
                    borderBottom: 'none',
                    borderRadius: '6px 6px 0 0',
                    background: '#F8FAFC',
                    flexShrink: 0
                  }}>
                    <span style={{ fontSize: '12px', color: '#475569' }}>Plain text — placeholders like <span style={{ fontFamily: 'monospace', color: '#1D4ED8' }}>{'{{first_name}}'}</span> are replaced automatically when sending.</span>
                  </div>

                  {/* Editable Text Area */}
                  <textarea
                    ref={bodyRef}
                    value={compBody}
                    onChange={(e) => setCompBody(e.target.value)}
                    placeholder="Start drafting your outreach template here..."
                    spellCheck={false}
                    style={BODY_TEXTAREA_STYLE}
                  ></textarea>
                </>
              ) : editorMode === 'html' ? (
                <textarea
                  ref={bodyRef}
                  value={compBody}
                  onChange={(e) => setCompBody(e.target.value)}
                  placeholder="Edit HTML template..."
                  spellCheck={false}
                  style={BODY_TEXTAREA_STYLE}
                />
              ) : (
                <div style={BODY_PREVIEW_STYLE}>
                  {compBody.trim() ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: bodyIsHtml ? compBody : plainTextToHtml(compBody),
                      }}
                    />
                  ) : (
                    <div style={{ color: '#94A3B8', fontSize: '13.5px' }}>
                      Load a template to preview its rendered email design.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── RENDER: TEMPLATES ─── */}
      {campTabState === 'templates' && (
        <div>
          {/* Categories select header */}
          <div className="toolbar" style={{ marginBottom: '14px' }}>
            <div className="toolbar-left">
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text3)' }}>Filter by Type:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {TEMPLATE_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    className={`btn btn-sm ${selectedTemplateCategory === cat ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setSelectedTemplateCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {templatesLoading ? (
            <div className="empty-state">
              <div className="empty-icon">⟳</div>
              <div className="empty-title">Loading templates…</div>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✉</div>
              <div className="empty-title">No templates found</div>
              <div className="empty-sub">Try a different category or add templates to your email_templates table.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
              {filteredTemplates.map(t => (
                <div key={t.id} className="card flex flex-col justify-between" style={{ padding: '14px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span className="tag tag-prospect" style={{ fontSize: '10px' }}>{t.category}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text4)' }}>{t.description}</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t.name}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text4)', fontStyle: 'italic', marginBottom: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sub: {t.subject}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text3)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.4, background: 'var(--surface2)', padding: '8px', borderRadius: '4px', fontStyle: 'italic' }}>
                      {t.body.replace(/<[^>]*>/g, '').substring(0, 140)}...
                    </div>
                  </div>
                  <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--border)', textAlign: 'right' }}>
                    <button className="btn btn-secondary btn-xs" onClick={() => loadTemplate(t.id)}>Use Template →</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── RENDER: PENDING FOLLOW-UPS ─── */}
      {campTabState === 'followups' && (
        <div>
          <div className="toolbar" style={{ marginBottom: '14px' }}>
            <div className="toolbar-left">
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text3)' }}>
                Follow-ups queued when a recipient opens a campaign with Manual mode. Review and send them here.
              </span>
            </div>
            <div className="toolbar-right">
              <button className="btn btn-secondary btn-sm" onClick={() => void loadPendingFollowups()}>⟳ Refresh</button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Email</th>
                  <th>Original Campaign</th>
                  <th>Follow-up Campaign</th>
                  <th>Opened At</th>
                  <th>Status</th>
                  <th style={{ width: '150px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingFollowupsLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⟳</div>
                        <div className="empty-title">Loading follow-ups…</div>
                      </div>
                    </td>
                  </tr>
                ) : pendingFollowupsError ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⚠</div>
                        <div className="empty-title">Could not load follow-ups</div>
                        <div className="empty-sub">{pendingFollowupsError}</div>
                      </div>
                    </td>
                  </tr>
                ) : pendingFollowups.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">⏳</div>
                        <div className="empty-title">No pending follow-ups</div>
                        <div className="empty-sub">
                          Follow-ups appear here when a recipient opens a campaign that has Manual follow-up enabled.
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : (
                  pendingFollowups.map((p) => {
                    const canSend = p.status === 'pending' || p.status === 'failed';
                    return (
                      <tr key={p.id}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{p.recipient_name || '—'}</div>
                        </td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.email}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.campaign_name || '—'}</td>
                        <td style={{ fontSize: '12.5px', color: 'var(--text3)' }}>{p.followup_campaign_name || '—'}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text4)', fontFamily: 'var(--mono)' }}>{formatDateTime(p.opened_at)}</td>
                        <td>
                          <span className={`tag ${
                            p.status === 'sent' ? 'tag-client' :
                            p.status === 'failed' ? 'tag-oem' : 'tag-draft'
                          }`}>{p.status}</span>
                        </td>
                        <td>
                          {canSend ? (
                            <button
                              className="btn btn-secondary btn-xs"
                              disabled={sendingFollowupId === p.id}
                              onClick={() => void handleSendFollowup(p.id)}
                            >
                              {sendingFollowupId === p.id ? 'Sending…' : 'Send Follow-up'}
                            </button>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── DELETE TEMPLATE CONFIRMATION MODAL ─── */}
      {templateToDelete && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Delete Template?</div>
              <button className="btn-icon" onClick={cancelDeleteTemplate} disabled={templateDeleting}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              <div style={{ fontWeight: 600, color: '#1E293B', marginBottom: '6px' }}>
                Are you sure you want to delete "{templateToDelete.name}"?
              </div>
              <div>This template will be permanently removed.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={cancelDeleteTemplate} disabled={templateDeleting}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                style={{ borderColor: 'var(--red)' }}
                onClick={() => void confirmDeleteTemplate()}
                disabled={templateDeleting}
              >
                {templateDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── TEMPLATE IN USE WARNING MODAL ─── */}
      {templateInUse && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '440px' }}>
            <div className="modal-header">
              <div className="modal-title">Template In Use</div>
              <button className="btn-icon" onClick={() => setTemplateInUse(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ fontSize: '13px', color: '#475569' }}>
              <div>This template is currently used by a campaign.</div>
              <div>You cannot delete it until it is no longer being used.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setTemplateInUse(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── PREVIEW MODAL: GEORGIA LETTER LAYOUT ─── */}
      {previewOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: '640px' }}>
            <div className="modal-header">
              <div className="modal-title">Desktop Campaign Preview</div>
              <button className="btn-icon" onClick={() => setPreviewOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ background: 'var(--surface2)', padding: '20px' }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', overflow: 'hidden', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                {/* Header bar */}
                <div style={{ background: 'var(--surface2)', padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '8px', flexDirection: 'column' }}>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>To:</span><span style={{ color: 'var(--text2)', fontWeight: 600 }}>Rajiv Mehta &lt;arvind.mehta@bajajelectricals.com&gt;</span></div>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>From:</span><span style={{ color: 'var(--text2)' }}>Rupali Sirsath &lt;rupali.s@iuova.com&gt;</span></div>
                  <div style={{ fontSize: '12px', display: 'flex' }}><span style={{ width: '50px', color: 'var(--text4)' }}>Subject:</span><span style={{ color: 'var(--text1)', fontWeight: 700 }}>{compSubject.replace(/{{company}}/g, 'Bajaj Electricals').replace(/{{first_name}}/g, 'Rajiv') || '(No Subject)'}</span></div>
                </div>
                {/* Email content */}
                <div
                  style={{
                    padding: '24px 32px',
                    fontSize: '15px',
                    fontFamily: '"Georgia", serif',
                    lineHeight: '1.6',
                    color: '#1E293B',
                    minHeight: '260px',
                    background: '#FFFFFF'
                  }}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                ></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setPreviewOpen(false)}>Close Preview</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
