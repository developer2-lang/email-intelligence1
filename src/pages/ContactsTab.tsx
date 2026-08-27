import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { AV_COLORS } from '../constants/constants';
import type { Contact, ContactInput } from '../types/contact';
import {
  fetchContacts,
  insertContact,
  updateContact,
  deleteContact,
  deleteContacts,
  insertContacts,
  updateContactType,
} from '../services/contactsService';
import { fetchContactTypes, createContactType } from '../services/contactTypesService';
import type { ContactType } from '../services/contactTypesService';

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

const LeadIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

const EngagementIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const EnrichmentIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M6 3h12l4 6-10 13L2 9l4-6z" />
    <path d="M11 3 8 9l4 13 4-13-3-6" />
    <path d="M2 9h20" />
  </svg>
);

const DatabaseIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);

const UserIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const CheckIcon = ({ size = 20 }: { size?: number }) => (
  <svg {...iconProps} width={size} height={size}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

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
  onNavigate: (tab: 'dashboard' | 'contacts' | 'campaigns' | 'sequences' | 'analytics' | 'settings' | 'contact-types') => void;
  isUploadModalOpen: boolean;
  setIsUploadModalOpen: (open: boolean) => void;
  onQueueSelectedContacts?: (emails: string[]) => void;
}

export default function ContactsTab({
  contacts: _propContacts,
  apiState,
  onPersistContacts,
  onToast,
  onNavigate,
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
  const [cSortKey, setCSortKey] = useState('name');
  const [cSortDir, setCSortDir] = useState<1 | -1>(1); // 1 = asc, -1 = desc
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
  const [isDragging, setIsDragging] = useState(false);

  // ─── DRAG & DROP FOR CONTACT TYPE TABS ───
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [draggedContactId, setDraggedContactId] = useState<string | null>(null);

  const C_PER_PAGE = 15;

  // ─── LOAD CONTACTS FROM SUPABASE ───
  const refreshContacts = useCallback(async () => {
    const { data, error } = await fetchContacts();
    if (error) {
      setFetchError(error);
      setContacts([]);
      onToast('Failed to load contacts: ' + error, 'error');
    } else {
      setFetchError(null);
      setContacts(data || []);
      onPersistContacts(data || []);
    }
    setLoading(false);
  }, [onPersistContacts, onToast]);

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

  useEffect(() => {
    const loadContacts = async () => {
      await refreshContacts();
    };
    void loadContacts();
  }, [refreshContacts]);

  useEffect(() => {
    const loadContactTypes = async () => {
      await refreshContactTypes();
    };
    void loadContactTypes();
  }, [refreshContactTypes]);

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
        (c.designation || '').toLowerCase().includes(search)
      );
    }

    if (cTypeFilter !== 'all') {
      result = result.filter(c => c.type === cTypeFilter);
    }

    if (cCatFilter) {
      result = result.filter(c => c.category === cCatFilter);
    }

    result.sort((a, b) => {
      const valA = (a[cSortKey as keyof Contact] ?? '').toString().toLowerCase();
      const valB = (b[cSortKey as keyof Contact] ?? '').toString().toLowerCase();
      if (valA < valB) return -1 * cSortDir;
      if (valA > valB) return 1 * cSortDir;
      return 0;
    });

    return result;
  }, [contacts, cSearchVal, cTypeFilter, cCatFilter, cSortKey, cSortDir]);

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
      onToast('Connect Lusha in Settings & APIs to enable enrichment', 'warn');
      onNavigate('settings');
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
      onToast('Connect Lusha in Settings & APIs to enable enrichment', 'warn');
      onNavigate('settings');
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
    setAfEmail(c.email || '');
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
    if (!afName.trim() || !afEmail.trim() || !afCompany.trim()) {
      onToast('Name, email and company are required', 'error');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(afEmail.trim())) {
      onToast('Please enter a valid email address', 'error');
      return;
    }

    const payload: ContactInput = {
      full_name: afName.trim(),
      email: afEmail.trim(),
      company: afCompany.trim(),
      designation: afDesig.trim(),
      industry: afIndustry.trim(),
      city: afCity.trim(),
      contact_type: afType,
      company_category: afCat,
      notes: afNotes.trim(),
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
        setLoading(true);
        await refreshContacts();
        return;
      }

      if (contacts.some(c => c.email.toLowerCase() === payload.email.toLowerCase())) {
        onToast('A contact with this email already exists', 'warn');
        return;
      }

      const { data, error } = await insertContact(payload);
      if (error) {
        onToast(error, 'error');
        return;
      }

      setIsContactModalOpen(false);
      onToast(`${(data?.name || payload.full_name)} added to contacts`, 'success');
      setLoading(true);
      await refreshContacts();
    } finally {
      setSubmitting(false);
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

  // ─── DYNAMIC TYPE TABS ───
  const typeTabs = useMemo(() => {
    if (contactTypes.length === 0) {
      return DEFAULT_TYPE_TABS;
    }
    const tabs = [{ id: 'all', label: 'All Contacts', count: contacts.length }];
    contactTypes.forEach(ct => {
      const count = contacts.filter(c => c.type === ct.name).length;
      tabs.push({ id: ct.name, label: ct.name, count });
    });
    return tabs;
  }, [contactTypes, contacts]);

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
      } catch (err: any) {
        onToast('Error reading file: ' + err.message, 'error');
      }
    };
    if (ext === 'csv') reader.readAsText(file);
    else reader.readAsBinaryString(file);
  };

  const confirmImport = async () => {
    if (uploadBuffer.length === 0) return;

    const existingEmails = new Set(contacts.map(c => c.email.toLowerCase().trim()));
    const toInsert: ContactInput[] = [];
    let added = 0;
    let skipped = 0;

    uploadBuffer.forEach((row: any) => {
      const email = (row['Email'] || row['email'] || '').trim().toLowerCase();
      if (!email) { skipped++; return; }
      if (existingEmails.has(email)) { skipped++; return; }

      toInsert.push({
        full_name: row['Name'] || row['name'] || '',
        email,
        company: row['Company'] || row['company'] || '',
        designation: row['Designation'] || row['designation'] || '',
        industry: row['Industry'] || row['industry'] || '',
        city: row['City'] || row['city'] || '',
        contact_type: row['Contact Type'] || row['contact_type'] || 'New Lead',
        company_category: row['Category'] || row['company_category'] || 'Domestic',
        notes: row['Notes'] || row['notes'] || '',
      });
      added++;
    });

    if (toInsert.length > 0) {
      const { error } = await insertContacts(toInsert);
      if (error) {
        onToast('Import failed: ' + error, 'error');
        return;
      }
      setLoading(true);
      await refreshContacts();
    }

    setIsUploadModalOpen(false);
    onToast(`${added} contacts imported ${skipped ? ` (${skipped} skipped)` : ''}`, 'success');
    setUploadBuffer([]);
    setUploadFileName('');
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
            className="btn btn-secondary"
            onClick={() => { onNavigate('settings'); onToast('Search and import leads using Lusha', 'info'); }}
          >
            <SparklesIcon size={15} /> Lusha Leads
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
        <StatCard label="New Leads" value={metrics.newLeads} sub="Freshly captured prospects" icon={<LeadIcon />} tone="blue" />
        <StatCard label="Unqualified Prospects" value={metrics.unqualified} sub="Prospect segment" icon={<UserIcon />} tone="purple" />
        <StatCard label="High Engagement" value={metrics.highEngagement} sub="Engagement score ≥ 70" icon={<EngagementIcon />} tone="green" />
        <StatCard label="Enriched via Lusha" value={metrics.enriched} sub="Lusha enrichment applied" icon={<EnrichmentIcon />} tone="amber" />
        <StatCard label="Verified Contact Meta" value={metrics.verifiedMeta} sub="Industry + role + city filled" icon={<CheckIcon />} tone="teal" />
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
            </select>
          </div>
        </div>

        {/* Segment pills */}
        <div className="ct-tabs">
          {typeTabs.map(tab => (
            <button
              key={tab.id}
              className={`ct-tab ${cTypeFilter === tab.id ? 'active' : ''} ${dragOverTabId === tab.id ? 'drag-over' : ''}`}
              onClick={() => { setCTypeFilter(tab.id); setCPage(1); }}
              onDragOver={(e) => tab.id !== 'all' && handleTabDragOver(e, tab.id)}
              onDragLeave={handleTabDragLeave}
              onDrop={(e) => tab.id !== 'all' && handleTabDrop(e, tab.id)}
            >
              <span>{tab.label}</span>
              {tab.count !== undefined && tab.count > 0 && (
                <span className="ct-tab-count">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ─── CONTACTS TABLE ─── */}
        <div className="ct-table-wrap">
          <table className="ct-table">
            <thead>
              <tr>
                <th style={{ width: 40, cursor: 'grab' }} title="Drag to reorder or drop into Campaign Editor">
                  <GripIcon size={14} style={{ opacity: 0.4 }} />
                </th>
                <th style={{ width: 42 }}>
                  <input
                    type="checkbox"
                    checked={filteredContacts.length > 0 && selectedIds.size === filteredContacts.length}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                  />
                </th>
                <th className="ct-sortable" onClick={() => handleSort('name')}>
                  Name {cSortKey === 'name' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th className="ct-sortable" onClick={() => handleSort('company')}>
                  Company {cSortKey === 'company' && <span className="ct-sort-arrow">{cSortDir === 1 ? '↑' : '↓'}</span>}
                </th>
                <th>Email</th>
                <th>Designation</th>
                <th>Type</th>
                <th>Category</th>
                <th style={{ textAlign: 'right', width: 116 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9}>
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
                  <td colSpan={9}>
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
                    const contactData = {
                      id: c.id,
                      name: c.name,
                      email: c.email,
                    };
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
                            <div className="ct-name">
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
                        <span className="ct-email">{c.email}</span>
                      </td>
                      <td>
                        <div className="ct-desig">{c.designation || '—'}</div>
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
          <div className="modal modal-wide">
            <div className="modal-header">
              <div>
                <div className="modal-title">
                  {editingId !== null ? 'Edit Contact Details' : 'Add New Contact'}
                </div>
                <div className="ct-sub" style={{ marginTop: 3 }}>
                  {editingId !== null ? 'Update the contact profile details' : 'Create a new contact profile'}
                </div>
              </div>
              <button className="modal-close" onClick={() => setIsContactModalOpen(false)} title="Close">
                <CloseIcon size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div className="form-grid">
                <div className="form-group">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Rajiv Sharma"
                    value={afName}
                    onChange={(e) => setAfName(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Email Address *</label>
                  <input
                    type="email"
                    placeholder="rajiv@company.com"
                    value={afEmail}
                    onChange={(e) => setAfEmail(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Company *</label>
                  <input
                    type="text"
                    placeholder="e.g. Bajaj Electricals"
                    value={afCompany}
                    onChange={(e) => setAfCompany(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Designation</label>
                  <input
                    type="text"
                    placeholder="VP Product Innovation"
                    value={afDesig}
                    onChange={(e) => setAfDesig(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Industry</label>
                  <input
                    type="text"
                    placeholder="Electrical Equipment"
                    value={afIndustry}
                    onChange={(e) => setAfIndustry(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>City</label>
                  <input
                    type="text"
                    placeholder="Mumbai"
                    value={afCity}
                    onChange={(e) => setAfCity(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Contact Type</label>
                  <select value={afType} onChange={(e) => setAfType(e.target.value)}>
                    {contactTypes.map(ct => (
                      <option key={ct.name} value={ct.name}>{ct.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Company Category</label>
                  <select value={afCat} onChange={(e) => setAfCat(e.target.value)}>
                    <option value="OEM">OEM</option>
                    <option value="Startup">Startup</option>
                    <option value="International">International</option>
                    <option value="Domestic">Domestic</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Notes & Context</label>
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
                {submitting ? 'Saving...' : editingId !== null ? 'Save Changes' : 'Create Contact'}
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
                  Expected Header Format
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {['Name', 'Company', 'Email', 'Designation', 'Industry', 'Contact Type', 'City', 'Notes'].map(col => (
                    <span key={col} className="chip">{col}</span>
                  ))}
                </div>
              </div>

              {/* Data Preview */}
              {uploadBuffer.length > 0 && (
                <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    padding: '9px 12px',
                    background: 'var(--surface3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                  }}>
                    <span style={{ fontWeight: 600, color: 'var(--text2)' }}>Preview First 5 Rows</span>
                    <span style={{ fontWeight: 700, color: 'var(--green)' }}>{uploadBuffer.length} rows parsed</span>
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
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => { setIsUploadModalOpen(false); setUploadBuffer([]); setUploadFileName(''); }}
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
    </div>
  );
}
