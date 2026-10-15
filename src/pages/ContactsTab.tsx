import React, { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { supabase } from '../supabase';
import { AV_COLORS, LEAD_MIRROR_TAB } from '../constants/constants';
import type { Contact, ContactInput } from '../types/contact';
import {
  fetchContacts,
  fetchAllContactEmails,
  insertContact,
  updateContact,
  deleteContact,
  deleteContacts,
  insertContacts,
  updateContactType,
} from '../services/contactsService';
import { fetchContactTypes, createContactType } from '../services/contactTypesService';
import type { ContactType } from '../services/contactTypesService';
import {
  fetchLeads,
  updateLead,
  deleteLead,
} from '../services/leadsService';
import type { LeadRow } from '../services/leadsService';
import { queueContactsForWeeklyEmail } from '../services/weeklyQueueService';

// The contact-type tab name that mirrors the Lead Database (public.leads).
// When this tab is active the leads table is shown instead of the contacts table.
interface ImportRow {
  [key: string]: unknown;
}

export interface ParsedImportContact {
  name: string;
  company: string;
  email_1: string;
  email_2: string;
  phone_1: string;
  phone_2: string;
  designation: string;
  linkedin_url: string;
  industry: string;
  city: string;
  notes: string;
  company_category: string;
}

const EMAIL_EMPTY_SENTINELS = new Set([
  'na', 'n/a', '-', '—', 'nil', 'none', 'null', 'unknown', 'blank', 'undefined', 'not available',
]);
const GENERIC_ORG_EMAILS = new Set(['crm@iuova.in']);

function pickRowValue(row: ImportRow, keys: string[]): string {
  const byLower = new Map(Object.keys(row).map(k => [k.trim().toLowerCase(), k]));
  for (const k of keys) {
    const src = byLower.get(k.trim().toLowerCase());
    if (src === undefined) continue;
    const v = row[src];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function cleanEmailText(text: string): string {
  if (!text) return '';
  return text.replace(/\/@/g, '@').trim();
}

function extractAllEmails(text: string): string[] {
  if (!text) return [];
  const cleaned = cleanEmailText(text);
  const matches = cleaned.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const result: string[] = [];
  for (const m of matches) {
    const norm = m.toLowerCase().trim().replace(/^[,;]+|[,;]+$/g, '');
    if (norm && !result.includes(norm) && !GENERIC_ORG_EMAILS.has(norm) && !EMAIL_EMPTY_SENTINELS.has(norm)) {
      result.push(norm);
    }
  }
  return result;
}

function extractAllPhones(text: string): string[] {
  if (!text) return [];
  const re = /(?:\+?\d{1,4}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{3,5}/g;
  const matches = text.match(re) || [];
  const valid: string[] = [];
  for (const m of matches) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15) {
      const clean = m.trim().replace(/^[\/\s-]+|[\/\s-]+$/g, '');
      if (clean && !valid.includes(clean)) {
        valid.push(clean);
      }
    }
  }
  return valid;
}

function inferNameFromEmail(email: string): string {
  if (!email) return '';
  const local = email.split('@')[0].replace(/\d+$/, '');
  const parts = local
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }
  return '';
}

function extractNameFromCell(text: string, emails: string[], phones: string[]): string {
  if (!text) return '';
  let rem = cleanEmailText(text);
  for (const e of emails) rem = rem.replace(new RegExp(e, 'gi'), ' ');
  rem = rem.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ');
  for (const p of phones) rem = rem.replace(p, ' ');
  rem = rem.replace(/\b(sales manager|ceo|coo|managing director|director|general manager|vp|vice president|manager|head of [a-z]+)\b/gi, ' ');
  rem = rem.replace(/[\/\-\+\:\(\)\d]/g, ' ').replace(/\s+/g, ' ').trim();
  if (rem.length >= 2 && !/^\d+$/.test(rem) && !/^(email|phone|company|contact|date|sr|no)$/i.test(rem)) {
    return rem.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return '';
}

function smartParseImportRow(row: ImportRow, phone1Col?: string, phone2Col?: string): ParsedImportContact | null {
  const nonEmpties = Object.values(row).map(v => String(v || '').trim()).filter(Boolean);
  if (nonEmpties.length === 0) return null;
  // Ignore header rows
  if (nonEmpties.length === 1 && /^(ceo\/coo|sr\.?\s*no\.?|date|company\s*name)$/i.test(nonEmpties[0])) return null;

  // 1. Company
  let company = pickRowValue(row, ['Company', 'Company Name', 'Account', 'Organization', 'Client']);
  if (!company) {
    for (const [k, v] of Object.entries(row)) {
      if (/company|account|organization|client/i.test(k) && v) {
        company = String(v).trim();
        break;
      }
    }
  }

  // 2. Explicit Name
  let name = pickRowValue(row, ['Name', 'Client Name', 'Full Name', 'Contact Name', 'Person']);

  // 3. Scan all fields for emails, phones, linkedin, designation
  const allEmails: string[] = [];
  const allPhones: string[] = [];
  let linkedin = pickRowValue(row, ['LinkedIn', 'LinkedIn URL', 'Linkedin', 'linkedin_url', 'Linkedin URL', 'Profile URL', 'LinkedIn Profile']);
  let designation = pickRowValue(row, ['Designation', 'Role', 'Title', 'Job Title']);
  const industry = pickRowValue(row, ['Industry', 'Sector']);
  const city = pickRowValue(row, ['City', 'Location']);
  const notes = pickRowValue(row, ['Notes', 'Remarks', 'Comments']);
  const companyCategory = pickRowValue(row, ['Company Category', 'Category']) || 'Domestic';

  // Manual column overrides for phone if set
  if (phone1Col && row[phone1Col]) {
    for (const p of extractAllPhones(String(row[phone1Col]))) {
      if (!allPhones.includes(p)) allPhones.push(p);
    }
  }
  if (phone2Col && row[phone2Col]) {
    for (const p of extractAllPhones(String(row[phone2Col]))) {
      if (!allPhones.includes(p)) allPhones.push(p);
    }
  }

  // Also check explicit Email columns first
  const explicitEmail1 = pickRowValue(row, ['Email 1', 'Work Email ID 1', 'Email ID 1', 'email_1', 'Email']);
  if (explicitEmail1) {
    for (const em of extractAllEmails(explicitEmail1)) {
      if (!allEmails.includes(em)) allEmails.push(em);
    }
  }
  const explicitEmail2 = pickRowValue(row, ['Email 2', 'Work Email ID 2', 'Email ID 2', 'email_2']);
  if (explicitEmail2) {
    for (const em of extractAllEmails(explicitEmail2)) {
      if (!allEmails.includes(em)) allEmails.push(em);
    }
  }

  for (const [k, val] of Object.entries(row)) {
    if (!val) continue;
    const str = String(val).trim();
    if (!str) continue;

    // Check linkedin URL
    if (!linkedin && /linkedin\.com\/in\//i.test(str)) {
      const match = str.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s,\/]+/i);
      if (match) linkedin = match[0];
    }

    // Check designation
    if (!designation) {
      if (/\b(sales manager|ceo|coo|managing director|director|general manager|vp|vice president|manager|head of [a-z]+)\b/i.test(str)) {
        const m = str.match(/\b(sales manager|ceo|coo|managing director|director|general manager|vp|vice president|manager|head of [a-z]+)\b/i);
        if (m) designation = m[0].toUpperCase();
      } else if (/ceo\/coo/i.test(k)) {
        designation = 'CEO/COO';
      }
    }

    // Emails
    for (const em of extractAllEmails(str)) {
      if (!allEmails.includes(em)) allEmails.push(em);
    }

    // Phones
    for (const ph of extractAllPhones(str)) {
      if (!allPhones.includes(ph)) allPhones.push(ph);
    }
  }

  // Extract name from cell text if still not found
  if (!name) {
    for (const [k, val] of Object.entries(row)) {
      if (!val || /company|date|sr\.?\s*no/i.test(k)) continue;
      const extracted = extractNameFromCell(String(val), allEmails, allPhones);
      if (extracted) {
        name = extracted;
        break;
      }
    }
  }

  // Infer name from Email 1 if still not found
  if (!name && allEmails[0]) {
    name = inferNameFromEmail(allEmails[0]);
  }

  // Fallback name if company exists
  if (!name && company) {
    name = company + ' Contact';
  }

  // If completely empty row (no company, no email, no phone, no name)
  if (!company && allEmails.length === 0 && allPhones.length === 0 && !name) {
    return null;
  }

  return {
    name: name || 'Contact',
    company: company || 'Unknown Company',
    email_1: allEmails[0] || '',
    email_2: allEmails[1] || '',
    phone_1: allPhones[0] || '',
    phone_2: allPhones[1] || '',
    designation: designation || '',
    linkedin_url: linkedin || '',
    industry: industry || '',
    city: city || '',
    notes: notes || '',
    company_category: companyCategory || 'Domestic',
  };
}

function getPhoneColumnMapping(headers: string[]): { phone1: string; phone2: string } {
  const token = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');
  const phone2Aliases = new Set([
    'phone2', 'phonenumber2', 'contactnumber2', 'contactno2', 'workphone',
    'workphonenumber', 'officephone', 'businessphone', 'secondaryphone',
    'alternatephone', 'altphone', 'telephone2',
  ]);
  const phone1Aliases = new Set([
    'phone1', 'phonenumber1', 'contactnumber1', 'contactno1', 'mobile',
    'mobilenumber', 'mobileno', 'primaryphone', 'cell', 'cellphone',
  ]);
  const genericPhoneAliases = new Set([
    'phone', 'phonenumber', 'contactnumber', 'contactno', 'telephone',
  ]);
  const tokens = headers.map(token);
  const phoneCandidates = headers.filter((_, index) =>
    /phone|mobile|telephone|contactno|contactnumber/.test(tokens[index])
  );
  if (phoneCandidates.length === 1) {
    return { phone1: phoneCandidates[0], phone2: '' };
  }
  const findAlias = (aliases: Set<string>) => {
    const index = tokens.findIndex(value => aliases.has(value));
    return index < 0 ? '' : headers[index];
  };

  let phone2 = findAlias(phone2Aliases);
  let phone1 = findAlias(phone1Aliases) || findAlias(genericPhoneAliases);
  if (!phone1) {
    phone1 = phoneCandidates.find(header => header !== phone2) || '';
  }
  if (!phone2 && phoneCandidates.length > 1) {
    phone2 = phoneCandidates.find(header => header !== phone1) || '';
  }

  return { phone1, phone2 };
}

function fmtShortDate(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}



// Standardized icon components for sleek UI
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const PlusIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const UploadIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const SparklesIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
  </svg>
);

const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const GripIcon = ({ size = 16, style }: { size?: number; style?: React.CSSProperties }) => (
  <svg {...iconProps} width={size} height={size} style={style}>
    <circle cx="9" cy="5" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="19" r="1" />
  </svg>
);

const EditIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const SendIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const CloseIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const UsersIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const DatabaseIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);

const contactFieldIconPaths = {
  person: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  email: 'M4 4h16v16H4zM22 6l-10 7L2 6',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72l.45 2.7a2 2 0 0 1-.57 1.72L7.1 10.03a16 16 0 0 0 6 6l1.89-1.89a2 2 0 0 1 1.72-.57l2.7.45a2 2 0 0 1 1.72 1.9z',
  company: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01',
  role: 'M3 7h18v14H3zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M3 12h18M10 12v2h4v-2',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  industry: 'M4 4h16v16H4zM8 8h2v2H8zM14 8h2v2h-2zM8 14h2v2H8zM14 14h2v2h-2z',
  location: 'M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0zM12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  group: 'M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6',
  notes: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8',
} as const;

function ContactFieldIcon({ name }: { name: keyof typeof contactFieldIconPaths }) {
  return (
    <svg {...iconProps} width={14} height={14} aria-hidden="true">
      <path d={contactFieldIconPaths[name]} />
    </svg>
  );
}

// ─── Small presentational components ───────────────────────────────────────

const CARD_TONES = {
  indigo: { bg: '#EEF2FF', fg: '#4F46E5' },
  sky: { bg: '#F0F9FF', fg: '#0369A1' },
  blue: { bg: '#DBEAFE', fg: '#1D4ED8' },
  purple: { bg: '#F5F3FF', fg: '#7C3AED' },
  green: { bg: '#ECFDF5', fg: '#059669' },
  amber: { bg: '#FFFBEB', fg: '#D97706' },
  teal: { bg: '#F0FDFA', fg: '#0F766E' },
} as const;

/** Modern stat card used in the overview grid (icon + label + big number + sub). */
function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
  tone: keyof typeof CARD_TONES;
}) {
  const t = CARD_TONES[tone];
  return (
    <div className="stat-card">
      <div className="stat-top">
        <div className="stat-icon" style={{ background: t.bg, color: t.fg }}>
          {icon}
        </div>
        <div className="stat-label">{label}</div>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-delta">{sub}</div>
    </div>
  );
}

/** Small pill badge for a contact's type. */
function TypeBadge({ type }: { type: string }) {
  return <span className={`tag ${typeTone(type)}`}>{type || '—'}</span>;
}

/** Small pill badge for a contact's company category. */
function CategoryBadge({ category }: { category: string }) {
  return <span className={`tag ${categoryTone(category)}`}>{category || '—'}</span>;
}

/** Segment pills shown above the table (mirrors the existing cTypeFilter values). */
const DEFAULT_TYPE_TABS: { id: string; label: string; count?: number }[] = [
  { id: 'all', label: 'All Contacts' },
  { id: 'Existing Client', label: 'Clients' },
  { id: 'New Lead', label: 'Leads' },
  { id: 'Prospect', label: 'Prospects' },
  { id: 'Newsletter', label: 'Newsletter' },
];

// Used as fallback when contact types haven't loaded yet

// Helper for tag style badges
function typeTone(type: string) {
  switch (type) {
    case 'Existing Client':
      return 'tag-client';
    case 'New Lead':
      return 'tag-lead';
    case 'Prospect':
      return 'tag-prospect';
    case 'Newsletter':
      return 'tag-newsletter';
    case 'Partner':
      return 'tag-partner';
    default:
      return 'tag-default';
  }
}

function categoryTone(category: string) {
  switch (category) {
    case 'OEM':
      return 'tag-oem';
    case 'Startup':
      return 'tag-startup';
    case 'International':
      return 'tag-intl';
    case 'Domestic':
      return 'tag-domestic';
    default:
      return 'tag-default';
  }
}

interface ContactsTabProps {
  contacts: any[];
  apiState: { lusha: boolean; mailchimp: boolean };
  onPersistContacts: (contacts: any[]) => void;
  onToast: (msg: string, type?: string) => void;
  onNavigate: (tab: 'dashboard' | 'contacts' | 'campaigns' | 'sequences' | 'contact-types') => void;
  isUploadModalOpen: boolean;
  setIsUploadModalOpen: (open: boolean) => void;
  onQueueSelectedContacts?: (emails: string[]) => void;
}

export default function ContactsTab({
  contacts: _propContacts,
  apiState,
  onPersistContacts,
  onToast,
  onNavigate: _onNavigate,
  isUploadModalOpen,
  setIsUploadModalOpen,
  onQueueSelectedContacts,
}: ContactsTabProps) {
  // ─── CONTACT TYPES STATE ───
  const [contactTypes, setContactTypes] = useState<ContactType[]>([]);
  const [_contactTypesLoading, setContactTypesLoading] = useState(true);
  const [_contactTypesError, setContactTypesError] = useState<string | null>(null);

  // ─── CREATE LIST MODAL STATE ───
  const [isCreateListModalOpen, setIsCreateListModalOpen] = useState(false);
  const [createListName, setCreateListName] = useState('');
  const [createListSubmitting, setCreateListSubmitting] = useState(false);
  const [createListError, setCreateListError] = useState<string | null>(null);

  // ─── SUPABASE CONTACTS STATE ───
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ─── FILTERS & PAGINATION ───
  const [cPage, setCPage] = useState(1);
  const [cSortKey, setCSortKey] = useState('createdAt');
  const [cSortDir, setCSortDir] = useState<1 | -1>(-1); // -1 = desc (newest first)
  const [cTypeFilter, setCTypeFilter] = useState('all');
  const [cCatFilter, setCCatFilter] = useState('');
  const [cSearchVal, setCSearchVal] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<any>>(new Set());

  // ─── ADD/EDIT FORM STATE ───
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<any | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [afName, setAfName] = useState('');
  const [afEmail, setAfEmail] = useState('');
  const [afEmail2, setAfEmail2] = useState('');
  const [afPhone, setAfPhone] = useState('');
  const [afPhone2, setAfPhone2] = useState('');
  const [afLinkedin, setAfLinkedin] = useState('');
  const [afCompany, setAfCompany] = useState('');
  const [afDesig, setAfDesig] = useState('');
  const [afIndustry, setAfIndustry] = useState('');
  const [afCity, setAfCity] = useState('');
  const [afType, setAfType] = useState('New Lead');
  const [afCat, setAfCat] = useState('OEM');
  const [afNotes, setAfNotes] = useState('');

  // ─── EXCEL UPLOADER STATE ───
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadBuffer, setUploadBuffer] = useState<any[]>([]);
  const [smartContactsBuffer, setSmartContactsBuffer] = useState<ParsedImportContact[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [importType, setImportType] = useState('New Lead');
  const [phone1Column, setPhone1Column] = useState('');
  const [phone2Column, setPhone2Column] = useState('');

  // Automatically parse uploaded rows into clean contacts with Smart Auto-Extraction
  useEffect(() => {
    if (uploadBuffer.length === 0) {
      setSmartContactsBuffer([]);
      return;
    }
    const parsed = uploadBuffer
      .map(row => smartParseImportRow(row, phone1Column, phone2Column))
      .filter((c): c is ParsedImportContact => Boolean(c));
    setSmartContactsBuffer(parsed);
  }, [uploadBuffer, phone1Column, phone2Column]);

  // ─── DRAG & DROP FOR CONTACT TYPE TABS ───
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [draggedContactId, setDraggedContactId] = useState<string | null>(null);
  const contactTabsRef = useRef<HTMLDivElement | null>(null);
  const contactTabsScrollbarRef = useRef<HTMLDivElement | null>(null);
  const [contactTabsDimensions, setContactTabsDimensions] = useState({ clientWidth: 0, scrollWidth: 0 });
  const contactTableRef = useRef<HTMLDivElement | null>(null);
  const contactTableScrollbarRef = useRef<HTMLDivElement | null>(null);
  const [contactTableDimensions, setContactTableDimensions] = useState({ clientWidth: 0, scrollWidth: 0 });

  // ─── LEAD MIRROR STATE (lead search4 tab) ───
  const [leadRows, setLeadRows] = useState<LeadRow[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadEditTarget, setLeadEditTarget] = useState<LeadRow | null>(null);
  const [fLName, setFLName] = useState('');
  const [fLEmail, setFLEmail] = useState('');
  const [fLPhone, setFLPhone] = useState('');
  const [fLCompany, setFLCompany] = useState('');
  const [fLDesignation, setFLDesignation] = useState('');
  const [fLIndustry, setFLIndustry] = useState('');
  const [fLGeography, setFLGeography] = useState('');
  const [fLSubmitting, setFLSubmitting] = useState(false);

  // ─── DYNAMIC TYPE TABS & LEAD MIRROR TAB NAME ───
  const [leadMirrorTabName, setLeadMirrorTabName] = useState(() => {
    return localStorage.getItem('leadMirrorTabName') || LEAD_MIRROR_TAB;
  });

  // ─── INLINE TAB EDITING STATE ───
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabValue, setEditingTabValue] = useState('');
  const [savingTabId, setSavingTabId] = useState<string | null>(null);
  const editTabInputRef = useRef<HTMLInputElement>(null);

  const C_PER_PAGE = 50;

  // ─── LOAD CONTACTS FROM SUPABASE ───
  const refreshContacts = useCallback(async () => {
    const { data, error } = await fetchContacts();
    if (error) {
      setFetchError(error);
      setContacts([]);
      onToast('Failed to load contacts: ' + error, 'error');
    } else {
      setFetchError(null);
      // Filter out any mirrored lead contacts that have no email
      const validContacts = (data || []).filter(c => {
        const isLead =
          String(c.type || '').toLowerCase() === 'lead search' ||
          String(c.type || '').toLowerCase() === 'lead generation' ||
          String(c.type || '').toLowerCase() === String(leadMirrorTabName).toLowerCase();
        if (isLead && (!c.email || !String(c.email).trim() || String(c.email).trim() === '—')) {
          return false;
        }
        return true;
      });
      setContacts(validContacts);
      onPersistContacts(validContacts);
    }
    setLoading(false);
  }, [leadMirrorTabName, onPersistContacts, onToast]);

  // ─── LOAD LEADS FROM SUPABASE (lead mirror tab) ───
  const refreshLeads = useCallback(async () => {
    setLeadsLoading(true);
    const { data, error } = await fetchLeads();
    if (error) {
      setLeadRows([]);
      onToast('Failed to load leads: ' + error, 'error');
    } else {
      // ONLY leads WITH a valid email should come into the contact page
      const leadsWithEmail = (data || []).filter(
        l => l.email && String(l.email).trim().length > 0 && String(l.email).trim() !== '—' && String(l.email).trim() !== '-'
      );
      setLeadRows(leadsWithEmail);
      if (leadsWithEmail.length > 0) {
        void queueContactsForWeeklyEmail(
          leadsWithEmail.map(l => ({
            id: l.id,
            contact_id: `lead-${l.id}`,
            email: l.email,
            full_name: l.full_name,
            company: l.company_name,
            designation: l.designation,
            industry: l.industry,
          }))
        );
      }
    }
    setLeadsLoading(false);
  }, [onToast]);


  // ─── LOAD CONTACT TYPES FROM SUPABASE ───
  const refreshContactTypes = useCallback(async () => {
    setContactTypesLoading(true);
    const { data, error } = await fetchContactTypes();
    if (error) {
      setContactTypesError(error);
      setContactTypes([]);
      // Don't show toast for contact types load failure - it's not critical
    } else {
      setContactTypesError(null);
      setContactTypes(data || []);
    }
    setContactTypesLoading(false);
  }, []);

  // One-time cleanup: remove any old lead-search/lead-generation contacts from Supabase that have no email
  useEffect(() => {
    const cleanupNoEmailLeads = async () => {
      try {
        await supabase
          .from('contacts')
          .delete()
          .or('email.is.null,email.eq.""')
          .or('contact_type.ilike.lead search%,contact_type.ilike.lead generation%');
      } catch (err) {
        console.warn('Could not cleanup no-email mirrored contacts from DB:', err);
      }
    };
    void cleanupNoEmailLeads();
  }, []);

  useEffect(() => {
    const loadContacts = async () => { await refreshContacts(); };
    void loadContacts();
  }, [refreshContacts]);

  useEffect(() => {
    const loadContactTypes = async () => { await refreshContactTypes(); };
    void loadContactTypes();
  }, [refreshContactTypes]);

  // Auto-load leads on mount so the tab is ready instantly
  useEffect(() => {
    const loadLeads = async () => { await refreshLeads(); };
    void loadLeads();
  }, [refreshLeads]);


  // ─── CONTACT METRICS ───
  const metrics = useMemo(() => {
    const total = contacts.length;
    const activeProfiles = contacts.filter(c => c.type && String(c.type).trim().toLowerCase() !== 'newsletter').length;
    const newLeads = contacts.filter(c => c.type === 'New Lead').length;
    const unqualified = contacts.filter(c => c.type === 'Prospect').length;
    const highEngagement = contacts.filter(c => (c.engagement || 0) >= 70).length;
    const enriched = contacts.filter(c => c.enriched).length;
    const verifiedMeta = contacts.filter(
      c => c.industry && c.industry.trim() && c.designation && c.designation.trim() && c.city && c.city.trim()
    ).length;
    return { total, activeProfiles, newLeads, unqualified, highEngagement, enriched, verifiedMeta };
  }, [contacts]);

  // ─── CONTACTS FILTERING & SORTING ───
  const filteredContacts = useMemo(() => {
    let result = [...contacts];

    if (cSearchVal.trim()) {
      const search = cSearchVal.toLowerCase();
      result = result.filter(c =>
        (c.name || '').toLowerCase().includes(search) ||
        (c.company || '').toLowerCase().includes(search) ||
        (c.email || '').toLowerCase().includes(search) ||
        (c.email_1 || '').toLowerCase().includes(search) ||
        (c.email_2 || '').toLowerCase().includes(search) ||
        (c.designation || '').toLowerCase().includes(search) ||
        (c.linkedin_url || '').toLowerCase().includes(search) ||
        (c.phone || '').toLowerCase().includes(search) ||
        (c.phone_2 || '').toLowerCase().includes(search)
      );
    }

    if (
      cTypeFilter !== 'all' &&
      String(cTypeFilter || '').toLowerCase() !== String(leadMirrorTabName || LEAD_MIRROR_TAB).toLowerCase() &&
      String(cTypeFilter || '').toLowerCase() !== String(LEAD_MIRROR_TAB).toLowerCase()
    ) {
      result = result.filter(c =>
        String(c.type || '').toLowerCase() === String(cTypeFilter).toLowerCase()
      );
    }

    // Exclude any mirrored lead contacts that have no email
    result = result.filter(c => {
      const isLead =
        String(c.type || '').toLowerCase() === 'lead search' ||
        String(c.type || '').toLowerCase() === 'lead generation' ||
        String(c.type || '').toLowerCase() === String(leadMirrorTabName).toLowerCase();
      if (isLead && (!c.email || !String(c.email).trim() || String(c.email).trim() === '—')) {
        return false;
      }
      return true;
    });

    if (cCatFilter) {
      result = result.filter(c => c.category === cCatFilter);
    }

    if (cSortKey === 'createdAt') {
      result.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA !== timeB) return (timeA - timeB) * cSortDir;
        return 0;
      });
    } else {
      result.sort((a, b) => {
        const valA = (a[cSortKey as keyof Contact] ?? '').toString().toLowerCase();
        const valB = (b[cSortKey as keyof Contact] ?? '').toString().toLowerCase();
        if (valA < valB) return -1 * cSortDir;
        if (valA > valB) return 1 * cSortDir;
        return 0;
      });
    }

    return result;
  }, [contacts, cSearchVal, cTypeFilter, cCatFilter, cSortKey, cSortDir, leadMirrorTabName]);

  const paginatedContacts = useMemo(() => {
    const start = (cPage - 1) * C_PER_PAGE;
    return filteredContacts.slice(start, start + C_PER_PAGE);
  }, [filteredContacts, cPage]);

  const totalPages = Math.ceil(filteredContacts.length / C_PER_PAGE) || 1;

  // ─── SORT HANDLER ───
  const handleSort = (key: string) => {
    if (cSortKey === key) {
      setCSortDir(prev => (prev === 1 ? -1 : 1));
    } else {
      setCSortKey(key);
      setCSortDir(1);
    }
    setCPage(1);
  };

  // ─── SELECTIONS ───
  const handleSelectOne = (id: any) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const ids = filteredContacts.map(c => c.id);
      setSelectedIds(new Set(ids));
    } else {
      setSelectedIds(new Set());
    }
  };

  // ─── ROW ACTIONS ───
  const handleDeleteContact = async (id: any) => {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    const { error } = await deleteContact(String(id));
    if (error) {
      onToast('Failed to delete contact: ' + error, 'error');
      return;
    }
    setLoading(true);
    await refreshContacts();
    onToast('Contact removed', 'info');
  };

  const handleEnrichOne = (id: any) => {
    if (!apiState.lusha) {
      onToast('Lusha is not connected to enable enrichment', 'warn');
      return;
    }
    const c = contacts.find(x => x.id === id);
    if (!c) return;
    onToast(`Lusha enrichment queued for ${c.name}`, 'info');
  };

  // ─── BULK ACTIONS ───
  const handleBulkDelete = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedIds.size} selected contacts?`)) return;
    const idsArray = Array.from(selectedIds).map(id => String(id));
    const { error } = await deleteContacts(idsArray);
    if (error) {
      onToast('Failed to delete contacts: ' + error, 'error');
      return;
    }
    setSelectedIds(new Set());
    setLoading(true);
    await refreshContacts();
    onToast(`${idsArray.length} contacts deleted`, 'info');
  };

  const handleBulkToCampaign = () => {
    const selectedEmails = filteredContacts
      .filter(c => selectedIds.has(c.id))
      .map(c => c.email)
      .filter(Boolean);

    if (selectedEmails.length === 0) {
      onToast('No valid emails found in selected contacts', 'error');
      return;
    }

    if (onQueueSelectedContacts) {
      onQueueSelectedContacts(selectedEmails);
    } else {
      onToast(`${selectedEmails.length} contacts queued for campaign`, 'success');
    }
    setSelectedIds(new Set());
  };

  const handleBulkEnrich = () => {
    if (!apiState.lusha) {
      onToast('Lusha is not connected to enable enrichment', 'warn');
      return;
    }
    onToast(`Enrichment initiated for ${selectedIds.size} contacts`, 'info');
    setSelectedIds(new Set());
  };

  // ─── MODAL OPENERS ───
  const handleOpenAddContact = () => {
    setEditingId(null);
    setAfName('');
    setAfEmail('');
    setAfEmail2('');
    setAfPhone('');
    setAfPhone2('');
    setAfLinkedin('');
    setAfCompany('');
    setAfDesig('');
    setAfIndustry('');
    setAfCity('');
    setAfType(contactTypes[0]?.name || 'New Lead');
    setAfCat('OEM');
    setAfNotes('');
    setIsContactModalOpen(true);
  };

  const handleOpenEditContact = (id: any) => {
    const c = contacts.find(x => x.id === id);
    if (!c) return;
    setEditingId(id);
    setAfName(c.name || '');
    setAfEmail(c.email_1 || c.email || '');
    setAfEmail2(c.email_2 || '');
    setAfPhone(c.phone_1 || '');
    setAfPhone2(c.phone_2 || '');
    setAfLinkedin(c.linkedin_url || '');
    setAfCompany(c.company || '');
    setAfDesig(c.designation || '');
    setAfIndustry(c.industry || '');
    setAfCity(c.city || '');
    setAfType(c.type || 'New Lead');
    setAfCat(c.category || 'OEM');
    setAfNotes(c.notes || '');
    setIsContactModalOpen(true);
  };

  const handleSubmitContactForm = async () => {
    if (submitting) return;
    if (!afName.trim() || (!afEmail.trim() && !afEmail2.trim()) || !afCompany.trim()) {
      onToast('Name, at least one email, and company are required', 'error');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (afEmail.trim() && !emailRegex.test(afEmail.trim())) {
      onToast('Please enter a valid email address for Email', 'error');
      return;
    }
    if (afEmail2.trim() && !emailRegex.test(afEmail2.trim())) {
      onToast('Please enter a valid email address for Email 2', 'error');
      return;
    }

    const primaryEmail = afEmail.trim() || afEmail2.trim();
    const payload: ContactInput = {
      full_name: afName.trim(),
      email: primaryEmail,
      email_1: afEmail.trim() || null,
      email_2: afEmail2.trim() || null,
      company: afCompany.trim(),
      designation: afDesig.trim(),
      industry: afIndustry.trim(),
      city: afCity.trim(),
      contact_type: afType,
      company_category: afCat,
      notes: afNotes.trim(),
      phone_1: afPhone.trim() || null,
      phone_2: afPhone2.trim() || null,
      linkedin_url: afLinkedin.trim() || null,
    };

    setSubmitting(true);
    try {
      if (editingId !== null) {
        const { error } = await updateContact(String(editingId), payload);
        if (error) {
          onToast('Failed to update contact: ' + error, 'error');
          return;
        }
        setIsContactModalOpen(false);
        onToast('Contact updated successfully', 'success');
        setCSortKey('createdAt');
        setCSortDir(-1);
        setCPage(1);
        setLoading(true);
        await refreshContacts();
        return;
      }

      const checkEmail1 = afEmail.trim().toLowerCase();
      const checkEmail2 = afEmail2.trim().toLowerCase();
      const isDuplicate = contacts.some(c => {
        const c1 = (c.email_1 || c.email || '').toLowerCase().trim();
        const c2 = (c.email_2 || '').toLowerCase().trim();
        if (checkEmail1 && (c1 === checkEmail1 || c2 === checkEmail1)) return true;
        if (checkEmail2 && (c1 === checkEmail2 || c2 === checkEmail2)) return true;
        return false;
      });

      if (isDuplicate) {
        onToast('A contact with this email address already exists', 'warn');
        return;
      }

      const { data, error } = await insertContact(payload);
      if (error) {
        onToast(error, 'error');
        return;
      }

      // Automatically queue newly added contact for weekly email
      if (payload.email) {
        void queueContactsForWeeklyEmail([{
          id: data?.id,
          contact_id: data?.id,
          email: payload.email,
          full_name: payload.full_name,
          company: payload.company,
          designation: payload.designation,
          industry: payload.industry,
        }]);
      }

      setIsContactModalOpen(false);
      onToast(`${(data?.name || payload.full_name)} added to contacts`, 'success');
      setCSortKey('createdAt');
      setCSortDir(-1);
      setCPage(1);
      setLoading(true);
      await refreshContacts();
    } finally {
      setSubmitting(false);
    }
  };


  // ─── LEAD MIRROR HANDLERS (lead search4 tab) ───
  const handleOpenLeadEdit = (lead: LeadRow) => {
    setLeadEditTarget(lead);
    setFLName(lead.full_name || '');
    setFLEmail(lead.email || '');
    setFLPhone(lead.phone || '');
    setFLCompany(lead.company_name || '');
    setFLDesignation(lead.designation || '');
    setFLIndustry(lead.industry || '');
    setFLGeography(lead.geography || '');
  };

  const handleDeleteLead = async (lead: LeadRow) => {
    if (!confirm(`Delete ${lead.full_name || 'this lead'} from the Lead Database?`)) return;
    const { error } = await deleteLead(lead.id);
    if (error) {
      onToast('Failed to delete lead: ' + error, 'error');
      return;
    }
    onToast('Lead removed', 'info');
    await refreshLeads();
  };

  const handleSubmitLeadForm = async () => {
    if (fLSubmitting || !leadEditTarget) return;
    if (!fLName.trim()) { onToast('Full name is required', 'error'); return; }
    setFLSubmitting(true);
    try {
      const { error } = await updateLead(leadEditTarget.id, {
        full_name: fLName.trim(),
        email: fLEmail.trim() || null,
        phone: fLPhone.trim() || null,
        company_name: fLCompany.trim() || null,
        designation: fLDesignation.trim() || null,
        industry: fLIndustry.trim() || null,
        geography: fLGeography.trim() || null,
      });
      if (error) { onToast('Failed to update lead: ' + error, 'error'); return; }
      setLeadEditTarget(null);
      onToast('Lead updated successfully', 'success');
      await refreshLeads();
    } finally {
      setFLSubmitting(false);
    }
  };

  // ─── DRAG & DROP FOR IMPORT EXCEL ───
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processUploadFile(e.dataTransfer.files[0]);
    }
  };

  // ─── DRAG & DROP HANDLERS FOR CONTACT TYPE TABS ───
  const handleTabDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTabId(tabId);
  }, []);

  const handleTabDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only clear if leaving the tab entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverTabId(null);
    }
  }, []);

  const handleTabDrop = useCallback(async (e: React.DragEvent, tabId: string) => {
    e.preventDefault();
    setDragOverTabId(null);

    if (!draggedContactId || tabId === 'all') return;

    try {
      const contactData = e.dataTransfer.getData('application/x-contact');
      if (contactData) {
        const contact = JSON.parse(contactData) as { id: string; name: string; email: string };
        
        // Verify the dragged contact matches
        if (contact.id !== draggedContactId) return;

        // Don't allow dropping on the same type
        const currentContact = contacts.find(c => c.id === draggedContactId);
        if (currentContact && currentContact.type === tabId) {
          onToast(`${contact.name} is already in ${tabId}`, 'info');
          return;
        }

        // Update the contact type in the database
        const { error } = await updateContactType(draggedContactId, tabId);
        if (error) {
          onToast(`Failed to move ${contact.name}: ${error}`, 'error');
          return;
        }

        // Update local state immediately for responsive UI
        setContacts(prev => prev.map(c => 
          c.id === draggedContactId ? { ...c, type: tabId } : c
        ));
        
        onToast(`${contact.name} moved to ${tabId}`, 'success');
      }
    } catch (err) {
      console.error('Failed to process drop:', err);
      onToast('Failed to move contact', 'error');
    } finally {
      setDraggedContactId(null);
    }
  }, [draggedContactId, contacts, onToast]);

  useEffect(() => {
    const mirrorCt = contactTypes.find(
      ct =>
        ct.id === '4d69b506-4cdd-4aac-9d9f-adbec4e4423b' ||
        ct.name.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase()
    );
    if (mirrorCt && mirrorCt.name && mirrorCt.name !== leadMirrorTabName) {
      setLeadMirrorTabName(mirrorCt.name);
      localStorage.setItem('leadMirrorTabName', mirrorCt.name);
    }
  }, [contactTypes, leadMirrorTabName]);

  const typeTabs = useMemo(() => {
    const asMirrorId = leadMirrorTabName.toLowerCase();
    const asOrigMirrorId = LEAD_MIRROR_TAB.toLowerCase();
    const tabs: { id: string; label: string; count?: number }[] = [];

    if (contactTypes.length === 0) {
      DEFAULT_TYPE_TABS.forEach(t => {
        if (t.id.toLowerCase() !== asMirrorId && t.id.toLowerCase() !== asOrigMirrorId) tabs.push(t);
      });
    } else {
      tabs.push({ id: 'all', label: 'All Contacts', count: contacts.length });
      contactTypes.forEach(ct => {
        if (
          ct.name.toLowerCase() === asMirrorId ||
          ct.name.toLowerCase() === asOrigMirrorId ||
          ct.id === '4d69b506-4cdd-4aac-9d9f-adbec4e4423b'
        ) return; // mirror handled below
        tabs.push({
          id: ct.name,
          label: ct.name,
          count: contacts.filter(c =>
            String(c.type || '').toLowerCase() === String(ct.name).toLowerCase()
          ).length,
        });
      });
    }

    // Lead mirror tab: badge always = live leads count.
    tabs.push({ id: leadMirrorTabName, label: leadMirrorTabName, count: leadRows.length });
    return tabs;
  }, [contactTypes, contacts, leadRows, leadMirrorTabName]);

  useEffect(() => {
    const tabs = contactTabsRef.current;
    if (!tabs) return;

    const measure = () => {
      setContactTabsDimensions({ clientWidth: tabs.clientWidth, scrollWidth: tabs.scrollWidth });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    Array.from(tabs.children).forEach(child => observer.observe(child));
    return () => observer.disconnect();
  }, [typeTabs, editingTabId, editingTabValue]);

  const handleContactTabsScroll = (source: 'tabs' | 'scrollbar') => {
    const sourceElement = source === 'tabs' ? contactTabsRef.current : contactTabsScrollbarRef.current;
    const targetElement = source === 'tabs' ? contactTabsScrollbarRef.current : contactTabsRef.current;
    if (sourceElement && targetElement && targetElement.scrollLeft !== sourceElement.scrollLeft) {
      targetElement.scrollLeft = sourceElement.scrollLeft;
    }
  };

  useLayoutEffect(() => {
    const table = contactTableRef.current;
    if (!table) return;

    const measure = () => {
      setContactTableDimensions({ clientWidth: table.clientWidth, scrollWidth: table.scrollWidth });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [cTypeFilter, leadMirrorTabName, contacts.length, leadRows.length]);

  const handleContactTableScroll = (source: 'table' | 'scrollbar') => {
    const sourceElement = source === 'table' ? contactTableRef.current : contactTableScrollbarRef.current;
    const targetElement = source === 'table' ? contactTableScrollbarRef.current : contactTableRef.current;
    if (sourceElement && targetElement && targetElement.scrollLeft !== sourceElement.scrollLeft) {
      targetElement.scrollLeft = sourceElement.scrollLeft;
    }
  };

  useEffect(() => {
    if (typeTabs.some(tab => tab.id !== 'all' && tab.id === importType)) return;
    const firstAvailableType = typeTabs.find(tab => tab.id !== 'all');
    if (firstAvailableType) setImportType(firstAvailableType.id);
  }, [typeTabs, importType]);

  // Whether the lead-mirror tab is currently active
  const isLeadMirrorTab =
    String(cTypeFilter || '').toLowerCase() === String(leadMirrorTabName || LEAD_MIRROR_TAB).toLowerCase() ||
    String(cTypeFilter || '').toLowerCase() === String(LEAD_MIRROR_TAB).toLowerCase();

  const handleStartEditTab = (tabId: string, currentLabel: string) => {
    setEditingTabId(tabId);
    setEditingTabValue(currentLabel);
    setTimeout(() => {
      if (editTabInputRef.current) {
        editTabInputRef.current.focus();
        editTabInputRef.current.select();
      }
    }, 50);
  };

  const handleSaveTabName = async (tabId: string, oldLabel: string, rawNewName: string) => {
    const newName = rawNewName.trim();
    if (!newName) {
      onToast('List name cannot be empty', 'error');
      return;
    }
    if (newName === oldLabel) {
      setEditingTabId(null);
      return;
    }

    // Case-insensitive duplicate check against other tabs
    const isDuplicate = typeTabs.some(
      t => t.id.toLowerCase() !== tabId.toLowerCase() && t.label.toLowerCase() === newName.toLowerCase()
    );
    if (isDuplicate) {
      onToast(`A contact list named "${newName}" already exists`, 'error');
      return;
    }

    setSavingTabId(tabId);

    try {
      const isLeadMirror =
        tabId.toLowerCase() === leadMirrorTabName.toLowerCase() ||
        tabId.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase() ||
        oldLabel.toLowerCase() === leadMirrorTabName.toLowerCase() ||
        oldLabel.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase();

      // Find in contactTypes
      const targetCt = contactTypes.find(
        ct =>
          ct.name.toLowerCase() === tabId.toLowerCase() ||
          ct.name.toLowerCase() === oldLabel.toLowerCase() ||
          (isLeadMirror && ct.id === '4d69b506-4cdd-4aac-9d9f-adbec4e4423b')
      );

      // 1. Update contact_types table in Supabase
      if (targetCt) {
        const { error: ctErr } = await supabase
          .from('contact_types')
          .update({ name: newName })
          .eq('id', targetCt.id);
        if (ctErr) throw ctErr;
      } else {
        const { error: ctErr } = await supabase
          .from('contact_types')
          .update({ name: newName })
          .ilike('name', oldLabel);
        if (ctErr) console.warn('Could not update contact_types by name:', ctErr);
      }

      // 2. If it's the lead mirror tab, update state & storage
      if (isLeadMirror) {
        setLeadMirrorTabName(newName);
        localStorage.setItem('leadMirrorTabName', newName);
      }

      // 3. Update all matching contacts in Supabase contacts table
      const { error: contactsErr } = await supabase
        .from('contacts')
        .update({ contact_type: newName })
        .ilike('contact_type', oldLabel);

      if (contactsErr) {
        console.warn('Could not update contacts contact_type in DB:', contactsErr);
      }

      // 4. Update contacts state locally
      const updatedContacts = contacts.map(c =>
        String(c.type || '').toLowerCase() === oldLabel.toLowerCase()
          ? { ...c, type: newName }
          : c
      );
      setContacts(updatedContacts);
      onPersistContacts(updatedContacts);

      // 5. Update contactTypes state locally
      setContactTypes(prev =>
        prev.map(ct =>
          (targetCt && ct.id === targetCt.id) || ct.name.toLowerCase() === oldLabel.toLowerCase()
            ? { ...ct, name: newName }
            : ct
        )
      );

      // 6. If currently viewing this tab, keep it active with the new name
      if (cTypeFilter === tabId || cTypeFilter.toLowerCase() === oldLabel.toLowerCase()) {
        setCTypeFilter(newName);
      }

      setEditingTabId(null);
      onToast(`Renamed to "${newName}"`, 'success');
    } catch (err: any) {
      console.error('Failed to rename tab:', err);
      onToast('Failed to rename: ' + (err?.message || 'Unknown error'), 'error');
    } finally {
      setSavingTabId(null);
    }
  };


  // ─── CREATE LIST MODAL HANDLERS ───
  const handleOpenCreateListModal = () => {
    setCreateListName('');
    setCreateListError(null);
    setIsCreateListModalOpen(true);
  };

  const handleCreateListSubmit = async () => {
    const name = createListName.trim();
    if (!name) {
      setCreateListError('List name is required');
      return;
    }

    // Check for duplicate (case-insensitive)
    const isDuplicate = contactTypes.some(
      ct => ct.name.toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
      setCreateListError('A contact list with this name already exists');
      return;
    }

    setCreateListSubmitting(true);
    setCreateListError(null);

    const { error } = await createContactType({ name, is_active: true });
    if (error) {
      setCreateListError(error);
      setCreateListSubmitting(false);
      return;
    }

    setIsCreateListModalOpen(false);
    onToast('Contact list created successfully', 'success');
    await refreshContactTypes();
    setCreateListSubmitting(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processUploadFile(e.target.files[0]);
    }
  };

  const processUploadFile = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls', 'csv'].includes(ext)) {
      onToast('Please upload a .xlsx, .xls, or .csv file', 'error');
      return;
    }
    setUploadFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        let rows: any[] = [];
        if (ext === 'csv') {
          const lines = e.target.result.split('\n').filter((l: string) => l.trim());
          const headers = lines[0].split(',').map((h: string) => h.trim().replace(/"/g, ''));
          rows = lines.slice(1).map((line: string) => {
            const vals = line.split(',').map((v: string) => v.trim().replace(/"/g, ''));
            return headers.reduce((o: any, h: string, i: number) => {
              o[h] = vals[i] || '';
              return o;
            }, {});
          });
        } else {
          const XLSX = (window as any).XLSX;
          if (!XLSX) {
            onToast('Excel parsing library not available', 'error');
            return;
          }
          const wb = XLSX.read(e.target.result, { type: 'binary' });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        }
        setUploadBuffer(rows);
        const mapping = getPhoneColumnMapping(Object.keys(rows[0] || {}));
        setPhone1Column(mapping.phone1);
        setPhone2Column(mapping.phone2);
      } catch (err: any) {
        onToast('Error reading file: ' + err.message, 'error');
      }
    };
    if (ext === 'csv') reader.readAsText(file);
    else reader.readAsBinaryString(file);
  };

  const confirmImport = async () => {
    if (smartContactsBuffer.length === 0) {
      onToast('No valid contacts found in the uploaded file', 'warn');
      return;
    }
    const selectedImportType = typeTabs.find(tab => tab.id === importType && tab.id !== 'all')?.id;
    if (!selectedImportType) {
      onToast('Select a valid contact type before importing', 'error');
      return;
    }

    const existingEmails = await fetchAllContactEmails();
    const seenEmails = new Set(existingEmails);
    const seenPhones = new Set<string>();
    const toInsert: ContactInput[] = [];
    let added = 0;
    let skipped = 0;

    smartContactsBuffer.forEach((c) => {
      const email1 = (c.email_1 || '').trim().toLowerCase();
      const email2 = (c.email_2 || '').trim().toLowerCase();
      const phone1Digits = (c.phone_1 || '').replace(/\D/g, '');
      const phone2Digits = (c.phone_2 || '').replace(/\D/g, '');

      // Must have at least an email OR a phone OR a name
      if (!email1 && !email2 && !phone1Digits && !phone2Digits && !c.name) {
        skipped++;
        return;
      }

      // Deduplicate by email if email present
      if (email1 && seenEmails.has(email1)) {
        skipped++;
        return;
      }

      // Deduplicate phone-only rows
      if (!email1 && phone1Digits && seenPhones.has(phone1Digits)) {
        skipped++;
        return;
      }

      if (email1) seenEmails.add(email1);
      if (email2) seenEmails.add(email2);
      if (phone1Digits) seenPhones.add(phone1Digits);
      if (phone2Digits) seenPhones.add(phone2Digits);

      toInsert.push({
        full_name: c.name || 'Contact',
        company: c.company || 'Unknown Company',
        email: email1 || email2 || '',
        email_1: email1 || null,
        email_2: email2 || null,
        phone: c.phone_1 || c.phone_2 || '',
        phone_1: c.phone_1 || null,
        phone_2: c.phone_2 || null,
        designation: c.designation || null,
        industry: c.industry || null,
        city: c.city || null,
        linkedin_url: c.linkedin_url || null,
        contact_type: selectedImportType,
        company_category: c.company_category || 'Domestic',
        notes: c.notes || null,
      });
      added++;
    });

    if (toInsert.length > 0) {
      const { error } = await insertContacts(toInsert);
      if (error) {
        onToast('Import failed: ' + error, 'error');
        return;
      }

      // Automatically queue newly imported contacts with email for weekly email
      const queueable = toInsert.filter(c => c.email && c.email.includes('@'));
      if (queueable.length > 0) {
        void queueContactsForWeeklyEmail(
          queueable.map(c => ({
            email: c.email!,
            full_name: c.full_name,
            company: c.company,
            designation: c.designation,
            industry: c.industry,
          }))
        );
      }

      setLoading(true);
      await refreshContacts();
    }

    setIsUploadModalOpen(false);
    onToast(`${added} contacts successfully imported${skipped ? ` (${skipped} skipped)` : ''}`, 'success');
    setUploadBuffer([]);
    setSmartContactsBuffer([]);
    setUploadFileName('');
    setPhone1Column('');
    setPhone2Column('');
  };

  return (
    <div className="page active">
      {/* ─── CONTACTS DIRECTORY TITLE + ACTIONS ─── */}
      <div className="contacts-head">
        <div>
          <div className="contacts-title">Contacts Directory</div>
          <div className="contacts-sub">
            Manage, segment, and enrich audience profiles across intelligence pipelines.
          </div>
        </div>
        <div className="contacts-actions">
          <button
            className="btn btn-primary"
            onClick={handleOpenAddContact}
          >
            <PlusIcon size={15} /> Add Contact
          </button>
          <button
            className="btn"
            onClick={() => setIsUploadModalOpen(true)}
          >
            <UploadIcon size={15} /> Import File
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleOpenCreateListModal}
          >
            <PlusIcon size={15} /> Create List
          </button>
        </div>
      </div>

      {/* ─── OVERVIEW STATISTICS CARDS ─── */}
      <div className="stats-row">
        <StatCard label="Total Contacts" value={metrics.total} sub="All database profiles" icon={<UsersIcon />} tone="indigo" />
        <StatCard label="Active Database Profiles" value={metrics.activeProfiles} sub="Non-newsletter records" icon={<DatabaseIcon />} tone="sky" />
      </div>

      {/* ─── CONTACTS TABLE PANEL ─── */}
      <div className="ct-panel">
        {/* Toolbar: title + record count, search + category filter */}
        <div className="ct-toolbar">
          <div>
            <div className="ct-panel-title">Contacts</div>
            <div className="ct-record-count">{contacts.length} records</div>
          </div>
          <div className="ct-toolbar-right">
            <div className="ct-search">
              <span className="ct-search-ic">
                <SearchIcon size={15} />
              </span>
              <input
                type="search"
                value={cSearchVal}
                onChange={(e) => { setCSearchVal(e.target.value); setCPage(1); }}
                placeholder="Search name, company, email..."
              />
            </div>
            <select
              className="ct-select"
              value={cCatFilter}
              onChange={(e) => { setCCatFilter(e.target.value); setCPage(1); }}
            >
              <option value="">All Categories</option>
              <option value="OEM">OEM</option>
              <option value="Startup">Startup</option>
              <option value="International">International</option>
              <option value="Domestic">Domestic</option>
              <option value="lead search">Lead Search</option>
            </select>
          </div>
        </div>

        {/* Segment pills */}
        {contactTabsDimensions.scrollWidth > contactTabsDimensions.clientWidth && (
          <div
            className="ct-tabs-scrollbar"
            ref={contactTabsScrollbarRef}
            onScroll={() => handleContactTabsScroll('scrollbar')}
            role="region"
            aria-label="Scroll contact lists"
            tabIndex={0}
          >
            <div style={{ width: contactTabsDimensions.scrollWidth, minWidth: contactTabsDimensions.scrollWidth, height: 1 }} />
          </div>
        )}
        <div
          className="ct-tabs"
          ref={contactTabsRef}
          onScroll={() => handleContactTabsScroll('tabs')}
        >
          {typeTabs.map(tab => {
            const isLeadMirror =
              tab.id.toLowerCase() === leadMirrorTabName.toLowerCase() ||
              tab.id.toLowerCase() === LEAD_MIRROR_TAB.toLowerCase();
            const isEditing = editingTabId === tab.id;

            if (isEditing) {
              return (
                <div
                  key={tab.id}
                  className="ct-tab ct-tab-editing"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    ref={editTabInputRef}
                    type="text"
                    className="ct-tab-input"
                    value={editingTabValue}
                    onChange={(e) => setEditingTabValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveTabName(tab.id, tab.label, editingTabValue);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingTabId(null);
                      }
                    }}
                    disabled={savingTabId === tab.id}
                    placeholder="Tab name"
                  />
                  <button
                    type="button"
                    className="ct-tab-action-btn ct-tab-save-btn"
                    title="Save name (Enter)"
                    disabled={savingTabId === tab.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleSaveTabName(tab.id, tab.label, editingTabValue);
                    }}
                  >
                    {savingTabId === tab.id ? '…' : '✓'}
                  </button>
                  <button
                    type="button"
                    className="ct-tab-action-btn ct-tab-cancel-btn"
                    title="Cancel (Esc)"
                    disabled={savingTabId === tab.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingTabId(null);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            }

            return (
              <button
                key={tab.id}
                className={`ct-tab ${cTypeFilter === tab.id || (isLeadMirror && isLeadMirrorTab) ? 'active' : ''} ${dragOverTabId === tab.id ? 'drag-over' : ''}`}
                onClick={() => {
                  setCTypeFilter(tab.id);
                  setCPage(1);
                  if (isLeadMirror) void refreshLeads();
                }}
                onDragOver={(e) => tab.id !== 'all' && !isLeadMirror && handleTabDragOver(e, tab.id)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => tab.id !== 'all' && !isLeadMirror && handleTabDrop(e, tab.id)}
              >
                <span
                  onDoubleClick={(e) => {
                    if (tab.id !== 'all') {
                      e.stopPropagation();
                      handleStartEditTab(tab.id, tab.label);
                    }
                  }}
                  title={tab.id !== 'all' ? 'Click pencil or double-click to edit name' : undefined}
                >
                  {tab.label}
                </span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="ct-tab-count">{tab.count}</span>
                )}
                {tab.id !== 'all' && (
                  <span
                    className="ct-tab-edit-ic"
                    title="Edit name"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEditTab(tab.id, tab.label);
                    }}
                  >
                    <EditIcon size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ─── LEAD DATABASE MIRROR (lead search4 tab) ─── */}
        {isLeadMirrorTab && (
          <>
            <div className="ct-toolbar">
              <div>
                <div className="ct-panel-title">Lead Database</div>
                <div className="ct-record-count">{leadRows.length} records — live mirror of Lead Database</div>
              </div>
            </div>

            {contactTableDimensions.scrollWidth > contactTableDimensions.clientWidth && (
              <div
                className="ct-table-scrollbar"
                ref={contactTableScrollbarRef}
                onScroll={() => handleContactTableScroll('scrollbar')}
                aria-hidden="true"
              >
                <div style={{ width: contactTableDimensions.scrollWidth, minWidth: contactTableDimensions.scrollWidth, height: 1 }} />
              </div>
            )}
            <div
              className="ct-table-wrap"
              ref={contactTableRef}
              onScroll={() => handleContactTableScroll('table')}
            >
              <table className="ct-table ct-table-fixed" style={{ minWidth: 1540 }}>
                <colgroup>
                  <col style={{ width: 44 }} />
                  <col style={{ width: 210 }} />
                  <col style={{ width: 230 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 190 }} />
                  <col style={{ width: 180 }} />
                  <col style={{ width: 140 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 90 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 116 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ width: 44, textAlign: 'center' }}>#</th>
                    <th style={{ width: 210 }}>Name</th>
                    <th style={{ width: 230 }}>Email</th>
                    <th style={{ width: 130 }}>Phone</th>
                    <th style={{ width: 190 }}>Company</th>
                    <th style={{ width: 180 }}>Designation</th>
                    <th style={{ width: 140 }}>Industry</th>
                    <th style={{ width: 130 }}>Geography</th>
                    <th style={{ width: 90 }}>LinkedIn</th>
                    <th style={{ width: 110 }}>Created</th>
                    <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {leadsLoading ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty-state">
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                            <span className="spinner"></span>
                            <span className="empty-title">Loading Lead Database...</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : leadRows.length === 0 ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty-state">
                          <div className="empty-icon">🔍</div>
                          <div className="empty-title">No leads found</div>
                          <div className="empty-sub">Add leads via Lead Generation or Lead Database page.</div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    leadRows.map((l, idx) => {
                      const avatarBg = AV_COLORS ? AV_COLORS[(l.full_name || 'L').charCodeAt(0) % AV_COLORS.length] : '#3b82f6';
                      const initials = (l.full_name || '')
                        .split(' ').map((x: string) => x[0]).join('').substring(0, 2).toUpperCase() || '??';
                      return (
                        <tr key={l.id}>
                          <td><div className="ct-sub">{idx + 1}</div></td>
                          <td>
                            <div className="ct-name-cell">
                              <div className="ct-avatar" style={{ background: avatarBg }}>{initials}</div>
                              <div className="ct-name-col">
                                <div className="ct-name" style={{ cursor: 'pointer' }} onClick={() => handleOpenLeadEdit(l)} title="Click to edit lead">{l.full_name || '—'}</div>
                                <div className="ct-sub">{l.headline || '—'}</div>
                              </div>
                            </div>
                          </td>
                          <td><span className="ct-email">{l.email || '—'}</span></td>
                          <td>{l.phone || '—'}</td>
                          <td>
                            <div className="ct-cell-main">{l.company_name || '—'}</div>
                            <div className="ct-sub">{l.role || '—'}</div>
                          </td>
                          <td><div className="ct-desig">{l.designation || '—'}</div></td>
                          <td>{l.industry || '—'}</td>
                          <td>{l.geography || '—'}</td>
                          <td>
                            {l.linkedin_url
                              ? <a href={l.linkedin_url} target="_blank" rel="noreferrer" className="ct-email">View</a>
                              : '—'}
                          </td>
                          <td>{fmtShortDate(l.created_at)}</td>
                          <td>
                            <div className="ct-row-actions">
                              <button title="Edit Lead" onClick={() => handleOpenLeadEdit(l)} className="ct-ibtn ct-ibtn-edit">
                                <EditIcon size={15} />
                              </button>
                              <button title="Delete Lead" onClick={() => handleDeleteLead(l)} className="ct-ibtn ct-ibtn-danger">
                                <TrashIcon size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {!leadsLoading && (
              <div className="ct-foot">
                <div className="ct-sub" style={{ marginTop: 0 }}>
                  Showing{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text2)' }}>
                    {leadRows.length > 0 ? 1 : 0} – {leadRows.length}
                  </span>{' '}
                  of {leadRows.length}{' '}
                  <span style={{ color: 'var(--text3)' }}>
                    lead record{leadRows.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── CONTACTS TABLE ─── */}
        {!isLeadMirrorTab && (
        <>
        {contactTableDimensions.scrollWidth > contactTableDimensions.clientWidth && (
          <div
            className="ct-table-scrollbar"
            ref={contactTableScrollbarRef}
            onScroll={() => handleContactTableScroll('scrollbar')}
            aria-hidden="true"
          >
            <div style={{ width: contactTableDimensions.scrollWidth, minWidth: contactTableDimensions.scrollWidth, height: 1 }} />
          </div>
        )}
        <div
          className="ct-table-wrap"
          ref={contactTableRef}
          onScroll={() => handleContactTableScroll('table')}
        >
          <table className="ct-table ct-table-fixed" style={{ minWidth: 1890 }}>
            <colgroup>
              <col style={{ width: 40 }} />
              <col style={{ width: 44 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 190 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 220 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 190 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 116 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ width: 40, cursor: 'grab', textAlign: 'center' }} title="Drag to reorder or drop into Campaign Editor">
                  <GripIcon size={14} style={{ opacity: 0.4 }} />
                </th>
                <th style={{ width: 44, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={filteredContacts.length > 0 && selectedIds.size === filteredContacts.length}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th className="ct-sortable" style={{ width: 220 }} onClick={() => handleSort('name')}>
                  Name {cSortKey === 'name' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th className="ct-sortable" style={{ width: 190 }} onClick={() => handleSort('company')}>
                  Company {cSortKey === 'company' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th className="ct-sortable" style={{ width: 220 }} onClick={() => handleSort('email')}>
                  Email {cSortKey === 'email' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th className="ct-sortable" style={{ width: 220 }} onClick={() => handleSort('email_2')}>
                  Email 2 {cSortKey === 'email_2' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th className="ct-sortable" style={{ width: 140 }} onClick={() => handleSort('phone_1')}>
                  Phone 1 {cSortKey === 'phone_1' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th style={{ width: 140 }}>Phone 2</th>
                <th style={{ width: 190 }}>Designation</th>
                <th className="ct-sortable" style={{ width: 110 }} onClick={() => handleSort('linkedin_url')}>
                  LinkedIn {cSortKey === 'linkedin_url' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th style={{ width: 130 }}>Type</th>
                <th style={{ width: 130 }}>Category</th>
                <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={13}>
                    <div className="empty-state">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span className="spinner"></span>
                        <span className="empty-title">Loading contacts directory...</span>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : paginatedContacts.length === 0 ? (
                <tr>
                  <td colSpan={13}>
                    <div className="empty-state">
                      <div className="empty-icon">🔍</div>
                      <div className="empty-title">No contacts found</div>
                      <div className="empty-sub">
                        {fetchError ? fetchError : 'Try adjusting your search criteria or import leads.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedContacts.map((c) => {
                  const avatarBg = AV_COLORS ? AV_COLORS[(c.name || 'A').charCodeAt(0) % AV_COLORS.length] : '#3b82f6';
                  const initials = (c.name || '')
                    .split(' ')
                    .map((x: string) => x[0])
                    .join('')
                    .substring(0, 2)
                    .toUpperCase() || '??';

                  const handleDragStart = (e: React.DragEvent<HTMLTableRowElement>) => {
                    const contactData = { id: c.id, name: c.name, email: c.email };
                    e.dataTransfer.setData('application/x-contact', JSON.stringify(contactData));
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggedContactId(c.id);
                    e.currentTarget.style.opacity = '0.5';
                  };

                  const handleDragEnd = (e: React.DragEvent<HTMLTableRowElement>) => {
                    e.currentTarget.style.opacity = '1';
                    setDraggedContactId(null);
                  };

                  return (
                    <tr
                      key={c.id}
                      draggable={true}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      style={{
                        ...(selectedIds.has(c.id) ? { background: 'var(--accent-light)' } : undefined),
                        cursor: 'grab',
                      }}
                    >
                      <td style={{ cursor: 'grab', padding: '8px 6px', textAlign: 'center' }}>
                        <GripIcon size={14} style={{ opacity: 0.4, color: 'var(--text4)' }} />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => handleSelectOne(c.id)}
                        />
                      </td>
                      <td>
                        <div className="ct-name-cell">
                          <div className="ct-avatar" style={{ background: avatarBg }}>
                            {initials}
                          </div>
                          <div className="ct-name-col">
                            <div
                              className="ct-name"
                              style={{ cursor: 'pointer' }}
                              onClick={() => handleOpenEditContact(c.id)}
                              title="Click to edit contact"
                            >
                              {c.name}
                              {c.enriched && <span className="ct-name-dot" title="Enriched via Lusha"></span>}
                            </div>
                            <div className="ct-sub">{c.city || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="ct-cell-main">{c.company}</div>
                        <div className="ct-sub">{c.industry || '—'}</div>
                      </td>
                      <td>
                        {c.email_1 || c.email ? (
                          <span className="ct-email">{c.email_1 || c.email}</span>
                        ) : (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {c.email_2 ? (
                          <span className="ct-email">{c.email_2}</span>
                        ) : (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {(c.phone_1 || c.phone) ? (
                          <span
                            className="ct-phone"
                            style={{
                              fontFamily: 'var(--mono, monospace)',
                              fontSize: '12px',
                              color: 'var(--text2)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {c.phone_1 || c.phone}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        {c.phone_2 ? (
                          <span className="ct-phone">{c.phone_2}</span>
                        ) : (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <div className="ct-desig">{c.designation || '—'}</div>
                      </td>
                      <td>
                        {c.linkedin_url ? (
                          <a
                            href={c.linkedin_url.startsWith('http') ? c.linkedin_url : `https://${c.linkedin_url}`}
                            target="_blank"
                            rel="noreferrer"
                            className="ct-email"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
                            title={c.linkedin_url}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="#0A66C2" style={{ flexShrink: 0 }}>
                              <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 10.9v8.37H9.2V10.9H6.46M7.83 6.45c-.88 0-1.6.72-1.6 1.6 0 .88.72 1.6 1.6 1.6.88 0 1.6-.72 1.6-1.6 0-.88-.72-1.6-1.6-1.6Z"/>
                            </svg>
                            <span>View</span>
                          </a>
                        ) : (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <TypeBadge type={c.type} />
                      </td>
                      <td>
                        <CategoryBadge category={c.category} />
                      </td>
                      <td>
                        <div className="ct-row-actions">
                          <button
                            title="Enrich via Lusha"
                            onClick={() => handleEnrichOne(c.id)}
                            className="ct-ibtn ct-ibtn-warn"
                          >
                            <SparklesIcon size={15} />
                          </button>
                          <button
                            title="Edit Contact"
                            onClick={() => handleOpenEditContact(c.id)}
                            className="ct-ibtn ct-ibtn-edit"
                          >
                            <EditIcon size={15} />
                          </button>
                          <button
                            title="Delete Contact"
                            onClick={() => handleDeleteContact(c.id)}
                            className="ct-ibtn ct-ibtn-danger"
                          >
                            <TrashIcon size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ─── PAGINATION FOOTER ─── */}
        {!loading && (
          <div className="ct-foot">
            <div className="ct-sub" style={{ marginTop: 0 }}>
              Showing{' '}
              <span style={{ fontWeight: 600, color: 'var(--text2)' }}>
                {paginatedContacts.length > 0 ? (cPage - 1) * C_PER_PAGE + 1 : 0}
                {' – '}
                {Math.min(cPage * C_PER_PAGE, filteredContacts.length)}
              </span>{' '}
              of {filteredContacts.length}
            </div>
            {totalPages > 1 && (
              <div className="pagination">
                <button
                  disabled={cPage === 1}
                  onClick={() => setCPage(prev => Math.max(1, prev - 1))}
                  className="pg-btn"
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setCPage(p)}
                    className={`pg-btn ${p === cPage ? 'active' : ''}`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  disabled={cPage === totalPages}
                  onClick={() => setCPage(prev => Math.min(totalPages, prev + 1))}
                  className="pg-btn"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>

      {/* ─── FLOATING BULK SELECTION ACTION BAR ─── */}
      {selectedIds.size > 0 && (
        <div className="bulkbar">
          <div className="bulkbar-count">
            <span className="bulkbar-num">{selectedIds.size}</span>
            selected
          </div>
          <div className="bulkbar-sep"></div>
          <div className="bulkbar-actions">
            <button
              onClick={handleBulkEnrich}
              className="bulkbar-btn bulkbar-btn-enrich"
            >
              <SparklesIcon /> Enrich Lusha
            </button>
            <button
              onClick={handleBulkToCampaign}
              className="bulkbar-btn bulkbar-btn-queue"
            >
              <SendIcon /> Queue Campaign
            </button>
            <button
              onClick={handleBulkDelete}
              className="bulkbar-btn bulkbar-btn-delete"
            >
              <TrashIcon /> Delete
            </button>
          </div>
        </div>
      )}

      {/* ─── MODAL: CONTACTS ADD/EDIT ─── */}
      {isContactModalOpen && (
        <div className="modal-overlay">
          <div className="modal modal-wide contact-form-modal">
            <div className="modal-header contact-form-header">
              <div>
                <span className="contact-modal-mark" aria-hidden="true">
                  <UsersIcon size={22} />
                  <span>+</span>
                </span>
              </div>
              <div className="contact-form-heading">
                <div className="modal-title">
                  {editingId !== null ? 'Edit Contact Details' : 'Add New Contact'}
                </div>
                <div className="ct-sub">
                  {editingId !== null
                    ? 'Update the contact profile details'
                    : 'Create a new contact profile to manage your network'}
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsContactModalOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="contact-section-heading">
                <span className="contact-section-icon"><ContactFieldIcon name="person" /></span>
                <span>Basic Information</span>
              </div>
              <div className="form-grid contact-form-grid">
                <div className="form-group">
                  <label><ContactFieldIcon name="person" />Full Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Rajiv Sharma"
                    value={afName}
                    onChange={(e) => setAfName(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="email" />Email *</label>
                  <input
                    type="email"
                    placeholder="rajiv@company.com"
                    value={afEmail}
                    onChange={(e) => setAfEmail(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="email" />Email 2</label>
                  <input
                    type="email"
                    placeholder="Optional second email"
                    value={afEmail2}
                    onChange={(e) => setAfEmail2(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="phone" />Phone 1</label>
                  <input
                    type="tel"
                    placeholder="e.g. +91 98765 43210"
                    value={afPhone}
                    onChange={(e) => setAfPhone(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="phone" />Phone 2</label>
                  <input
                    type="tel"
                    placeholder="Optional second number"
                    value={afPhone2}
                    onChange={(e) => setAfPhone2(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="company" />Company *</label>
                  <input
                    type="text"
                    placeholder="e.g. Bajaj Electricals"
                    value={afCompany}
                    onChange={(e) => setAfCompany(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="role" />Designation</label>
                  <input
                    type="text"
                    placeholder="VP Product Innovation"
                    value={afDesig}
                    onChange={(e) => setAfDesig(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="link" />LinkedIn URL</label>
                  <input
                    type="text"
                    placeholder="https://www.linkedin.com/in/username"
                    value={afLinkedin}
                    onChange={(e) => setAfLinkedin(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="industry" />Industry</label>
                  <input
                    type="text"
                    placeholder="Electrical Equipment"
                    value={afIndustry}
                    onChange={(e) => setAfIndustry(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="location" />City</label>
                  <input
                    type="text"
                    placeholder="Mumbai"
                    value={afCity}
                    onChange={(e) => setAfCity(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="group" />Contact Type</label>
                  <select value={afType} onChange={(e) => setAfType(e.target.value)}>
                    {contactTypes.map(ct => (
                      <option key={ct.name} value={ct.name}>{ct.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label><ContactFieldIcon name="company" />Company Category</label>
                  <select value={afCat} onChange={(e) => setAfCat(e.target.value)}>
                    <option value="OEM">OEM</option>
                    <option value="Startup">Startup</option>
                    <option value="International">International</option>
                    <option value="Domestic">Domestic</option>
                  </select>
                </div>
              </div>

              <div className="form-group contact-notes-group">
                <label><ContactFieldIcon name="notes" />Notes & Context</label>
                <textarea
                  rows={3}
                  placeholder="Context regarding initial discussion, background..."
                  value={afNotes}
                  onChange={(e) => setAfNotes(e.target.value)}
                ></textarea>
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setIsContactModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={submitting}
                onClick={handleSubmitContactForm}
              >
                {submitting ? 'Saving...' : editingId !== null ? 'Save Changes' : 'Save Contact'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: IMPORT EXCEL / CSV ─── */}
      {isUploadModalOpen && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Import Contacts from File</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Upload an Excel or CSV file to bulk add contacts
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsUploadModalOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div
                className={`dropzone ${isDragging ? 'dragging' : ''}`}
                onClick={() => document.getElementById('upload-file-input-tab')?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="dropzone-icon">
                  <UploadIcon />
                </div>
                <div className="dropzone-title">
                  {uploadFileName ? `Selected: ${uploadFileName}` : 'Drag & drop Excel or CSV file here'}
                </div>
                <div className="dropzone-sub">Supports .xlsx, .xls, or .csv formats</div>
              </div>

              <input
                type="file"
                id="upload-file-input-tab"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileSelect}
              />

              <div style={{ marginTop: 16 }}>
                <div className="ct-record-count" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                  Assign Contact Type
                </div>
                <select
                  className="ct-select"
                  value={importType}
                  onChange={(e) => setImportType(e.target.value)}
                >
                  {typeTabs.filter(t => t.id !== 'all').map(tab => (
                    <option key={tab.id} value={tab.id}>{tab.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.25)',
                  borderRadius: 8,
                  marginBottom: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>✨</span>
                    <div>
                      <strong style={{ color: 'var(--blue)' }}>Smart Auto-Extraction Active:</strong>
                      <span style={{ color: 'var(--text2)', marginLeft: 6 }}>
                        Automatically extracts Name, Company, Email, Email 2, Phone 1, Phone 2, Designation, and LinkedIn from mixed and unformatted cells.
                      </span>
                    </div>
                  </div>
                  {smartContactsBuffer.length > 0 && (
                    <span className="badge" style={{ background: 'var(--blue)', color: '#fff', fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                      {smartContactsBuffer.length} Ready
                    </span>
                  )}
                </div>

                <div className="ct-record-count" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                  Expected Standard Columns (or Auto-Extracted from Cells)
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {['Name', 'Company', 'Email', 'Email 2', 'Phone 1', 'Phone 2', 'Designation', 'LinkedIn', 'Industry', 'Contact Type', 'City', 'Notes'].map(col => (
                    <span key={col} className="chip">{col}</span>
                  ))}
                </div>
                {uploadBuffer.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    <label className="form-group">
                      <span>Phone 1 column</span>
                      <select className="ct-select" value={phone1Column} onChange={e => setPhone1Column(e.target.value)}>
                        <option value="">Auto-Detect from cells</option>
                        {Object.keys(uploadBuffer[0] || {}).filter(column => column !== phone2Column).map(column => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                    <label className="form-group">
                      <span>Phone 2 column</span>
                      <select className="ct-select" value={phone2Column} onChange={e => setPhone2Column(e.target.value)}>
                        <option value="">Auto-Detect from cells</option>
                        {Object.keys(uploadBuffer[0] || {}).filter(column => column !== phone1Column).map(column => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>

              {/* Data Preview */}
              {smartContactsBuffer.length > 0 ? (
                <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    padding: '9px 12px',
                    background: 'var(--surface3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                  }}>
                    <span style={{ fontWeight: 600, color: 'var(--text2)' }}>
                      Preview Extracted Contacts (First {Math.min(smartContactsBuffer.length, 5)} of {smartContactsBuffer.length})
                    </span>
                    <span style={{ fontWeight: 700, color: 'var(--green)' }}>
                      {smartContactsBuffer.length} contacts parsed
                    </span>
                  </div>
                  <div style={{ overflowX: 'auto', maxHeight: 200 }}>
                    <table style={{ fontSize: 11, width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--surface2)', textAlign: 'left' }}>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>#</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Name</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Company</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Email</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Email 2</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Phone 1</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Phone 2</th>
                          <th style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>Designation</th>
                          <th style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>LinkedIn</th>
                        </tr>
                      </thead>
                      <tbody>
                        {smartContactsBuffer.slice(0, 5).map((c, idx) => (
                          <tr key={idx} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: 'var(--text3)' }}>{idx + 1}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', fontWeight: 600, color: 'var(--text)' }}>{c.name || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: 'var(--text2)' }}>{c.company || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: c.email_1 ? 'var(--blue)' : 'var(--text3)' }}>{c.email_1 || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: c.email_2 ? 'var(--blue)' : 'var(--text3)' }}>{c.email_2 || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: c.phone_1 ? 'var(--green)' : 'var(--text3)' }}>{c.phone_1 || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: c.phone_2 ? 'var(--green)' : 'var(--text3)' }}>{c.phone_2 || '—'}</td>
                            <td style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: 'var(--text3)' }}>{c.designation || '—'}</td>
                            <td style={{ padding: '8px 10px', color: 'var(--text3)' }}>{c.linkedin_url ? '✓' : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : uploadBuffer.length > 0 ? (
                <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    padding: '9px 12px',
                    background: 'var(--surface3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                  }}>
                    <span style={{ fontWeight: 600, color: 'var(--text2)' }}>Raw Rows</span>
                    <span style={{ fontWeight: 700, color: 'var(--green)' }}>{uploadBuffer.length} rows</span>
                  </div>
                  <div style={{ overflowX: 'auto', maxHeight: 192 }}>
                    <table style={{ fontSize: 11 }}>
                      <thead>
                        <tr>
                          {Object.keys(uploadBuffer[0] || {}).map(key => (
                            <th key={key} style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                              {key}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {uploadBuffer.slice(0, 5).map((row, idx) => (
                          <tr key={idx}>
                            {Object.keys(uploadBuffer[0] || {}).map(key => (
                              <td key={key} style={{ padding: '8px 10px', borderRight: '1px solid var(--border)', color: 'var(--text3)', whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {row[key] || ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setIsUploadModalOpen(false);
                  setUploadBuffer([]);
                  setUploadFileName('');
                  setPhone1Column('');
                  setPhone2Column('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={uploadBuffer.length === 0}
                onClick={confirmImport}
              >
                Confirm & Import Contacts
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: CREATE CONTACT LIST ─── */}
      {isCreateListModalOpen && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Create Contact List</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  Enter a name for the new contact list
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsCreateListModalOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-group">
                <label>List Name *</label>
                <input
                  type="text"
                  placeholder="e.g. New Partner Leads"
                  value={createListName}
                  onChange={(e) => {
                    setCreateListName(e.target.value);
                    if (createListError) setCreateListError(null);
                  }}
                  autoFocus
                />
                {createListError && (
                  <div className="form-error" style={{ color: 'var(--red)', fontSize: '12px', marginTop: 4 }}>
                    {createListError}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setIsCreateListModalOpen(false)}
                disabled={createListSubmitting}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={createListSubmitting || !createListName.trim()}
                onClick={handleCreateListSubmit}
              >
                {createListSubmitting ? 'Creating...' : 'Create List'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: EDIT LEAD (lead search4 tab) ─── */}
      {leadEditTarget && (
        <div className="modal-overlay">
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">Edit Lead Details</div>
                <div className="ct-sub" style={{ marginTop: 3 }}>Update the lead profile in the Lead Database</div>
              </div>
              <button className="modal-close" onClick={() => setLeadEditTarget(null)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group"><label>Full Name *</label><input type="text" placeholder="e.g. Rajiv Sharma" value={fLName} onChange={(e) => setFLName(e.target.value)} /></div>
                <div className="form-group"><label>Email Address</label><input type="email" placeholder="rajiv@company.com" value={fLEmail} onChange={(e) => setFLEmail(e.target.value)} /></div>
                <div className="form-group"><label>Phone</label><input type="text" placeholder="+91 98XXXXXXX" value={fLPhone} onChange={(e) => setFLPhone(e.target.value)} /></div>
                <div className="form-group"><label>Company</label><input type="text" placeholder="e.g. Bajaj Electricals" value={fLCompany} onChange={(e) => setFLCompany(e.target.value)} /></div>
                <div className="form-group"><label>Designation</label><input type="text" placeholder="VP Product Innovation" value={fLDesignation} onChange={(e) => setFLDesignation(e.target.value)} /></div>
                <div className="form-group"><label>Industry</label><input type="text" placeholder="Electrical Equipment" value={fLIndustry} onChange={(e) => setFLIndustry(e.target.value)} /></div>
                <div className="form-group"><label>Geography</label><input type="text" placeholder="Mumbai" value={fLGeography} onChange={(e) => setFLGeography(e.target.value)} /></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setLeadEditTarget(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={fLSubmitting} onClick={handleSubmitLeadForm}>
                {fLSubmitting ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
