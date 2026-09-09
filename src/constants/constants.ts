export const SEED_CONTACTS: any[] = [];

export const SEED_CAMPAIGNS: any[] = [];

export const NAV_META: { [key: string]: { title: string; sub: string } } = {
  dashboard:  { title: 'Dashboard',             sub: 'Overview · IUOVA Email Intelligence' },
  contacts:   { title: 'Contacts',              sub: 'Manage and enrich your contact database' },
  campaigns:  { title: 'Campaigns',             sub: 'Build, schedule and send email campaigns' },
  followups:  { title: 'Follow-ups',            sub: 'Follow-up to opened or not-opened recipients' },
  sequences:  { title: 'Sequences',             sub: 'Email drip automation' },
  'sequence-builder': { title: 'Sequence Builder', sub: 'Design and assemble email drip workflows' },
  analytics:  { title: 'Analytics',             sub: 'Campaign performance & engagement' },
  'template-editor': { title: 'Template Editor', sub: 'Design and manage email templates' },
  'template-library': { title: 'All Templates', sub: 'Browse, search and manage every saved template' },
  settings:   { title: 'Settings & APIs',       sub: 'Connect Lusha, Mailchimp and other tools' },
  'contact-types': { title: 'Contact Types',    sub: 'Manage contact type definitions' },
};

export const AV_COLORS = ['#2563EB','#10B981','#F59E0B','#8B5CF6','#EF4444','#0891B2','#7C3AED'];

// ─── Campaign Type ─────────────────────────────────────────────────────────
// The Campaign Type dropdown options. The selected value is stored verbatim
// as the campaigns.campaign_type column.
export const CAMPAIGN_TYPES = [
  'Newsletter',
  'Cold Outreach',
  'Partnership',
  'Follow Up',
  'Product Launch',
  'Event Invite',
  'Retainer Pitch',
  'Announcement',
  'Custom',
] as const;

// Chip colors keyed by Campaign Type label.
export const CAMPAIGN_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  Newsletter:       { bg: '#EFF6FF', color: '#2563EB' },  // Blue
  'Cold Outreach':  { bg: '#F3E8FF', color: '#7C3AED' },  // Purple
  Partnership:      { bg: '#ECFDF5', color: '#059669' },  // Green
  'Follow Up':      { bg: '#EEF2FF', color: '#4F46E5' },  // Indigo
  'Product Launch': { bg: '#FDF2F8', color: '#DB2777' },  // Pink
  'Event Invite':   { bg: '#FDF4FF', color: '#C026D3' },  // Fuchsia
  'Retainer Pitch': { bg: '#ECFEFF', color: '#0891B2' },  // Cyan
  Announcement:     { bg: '#FFF7ED', color: '#EA580C' },  // Orange
  Custom:           { bg: '#F1F5F9', color: '#475569' },  // Gray
  Campaign:         { bg: '#F1F5F9', color: '#475569' },  // Gray (NULL fallback)
};

export const CAMPAIGN_TYPE_FALLBACK_COLOR = { bg: '#F1F5F9', color: '#475569' };

// Legacy template keys / old rows → new Campaign Type labels.
export const TEMPLATE_KEY_TO_CAMPAIGN_TYPE: Record<string, string> = {
  cold: 'Cold Outreach',
  newsletter: 'Newsletter',
  retainer: 'Retainer Pitch',
  sprint: 'Partnership',
  checkin: 'Follow Up',
};

// The Supabase `templates` table has NO `key`/`slug` column, so every template
// row resolves to key = its UUID and TEMPLATE_KEY_TO_CAMPAIGN_TYPE above can
// never match a real template. Map template NAME → Campaign Type label instead
// so clicking a template card pre-fills the correct type (never 'Custom').
export const TEMPLATE_NAME_TO_CAMPAIGN_TYPE: Record<string, string> = {
  'Cold Outreach': 'Cold Outreach',
  'Discovery Sprint': 'Partnership',
  'Innovation Retainer': 'Retainer Pitch',
  'Retainer Check-in': 'Follow Up',
  'The Design Brief': 'Newsletter',
};

// Campaign Type label → legacy template key used for auto-loading a template.
export const CAMPAIGN_TYPE_TO_TEMPLATE_KEY: Record<string, string> = {
  'Cold Outreach': 'cold',
  Newsletter: 'newsletter',
  'Retainer Pitch': 'retainer',
  Partnership: 'sprint',
  'Follow Up': 'checkin',
};

// Campaign Type label → template NAME (reverse of TEMPLATE_NAME_TO_CAMPAIGN_TYPE).
// Selecting a type from the dropdown auto-loads the matching template by name,
// since templates carry no key column in the DB.
export const CAMPAIGN_TYPE_TO_TEMPLATE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(TEMPLATE_NAME_TO_CAMPAIGN_TYPE).map(([name, type]) => [type, name])
);

// Normalize a stored campaign_type value: legacy keys map to labels, NULL
// maps to "Campaign". Never returns a hardcoded/garbage value.
export function normalizeCampaignType(value?: string | null): string {
  const key = String(value || '').trim();
  if (!key) return 'Campaign';
  return TEMPLATE_KEY_TO_CAMPAIGN_TYPE[key] || key;
}
