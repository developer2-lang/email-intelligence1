import type { ReactNode } from 'react'
import { NAV_META } from '../constants/constants'
import type { TabKey } from '../types'

const NAV_SECTIONS: { label: string; tabs: TabKey[] }[] = [
  { label: 'Overview', tabs: ['dashboard', 'analytics'] },
  { label: 'Outreach', tabs: ['contacts', 'contact-types', 'campaigns', 'followups'] },
  { label: 'Lead Gen', tabs: ['lead-search'] },
  { label: 'Templates', tabs: ['template-editor', 'template-library'] },
  { label: 'Automation', tabs: ['sequences', 'sequence-builder'] },
  { label: 'Settings', tabs: ['settings'] },
]

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const NAV_ICONS: Record<TabKey, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  contacts: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  campaigns: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  followups: (
    <>
      <path d="m9 10-5 5 5 5" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </>
  ),
  sequences: (
    <>
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </>
  ),
  'sequence-builder': (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M7 10v1a3 3 0 0 0 3 3h4" />
    </>
  ),
  analytics: (
    <>
      <line x1="18" x2="18" y1="20" y2="10" />
      <line x1="12" x2="12" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </>
  ),
  'template-editor': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" x2="21" y1="9" y2="9" />
      <path d="M6 13.5h6M6 16.5h9" />
    </>
  ),
  'template-library': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 10h18" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  'contact-types': (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="4 4" />
    </>
  ),
  'lead-search': (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
}

interface SidebarProps {
  activeTab: TabKey
  onNavigate: (tab: TabKey) => void
  prefFrom?: string
}

function displayName(prefFrom?: string): string {
  if (!prefFrom) return 'Rupali Sirsath'
  const name = prefFrom.split('<')[0].trim()
  return name || 'Rupali Sirsath'
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

export default function Sidebar({ activeTab, onNavigate, prefFrom }: SidebarProps) {
  const userName = displayName(prefFrom)

  return (
    <aside className="sidebar" id="app-sidebar">
      <div className="side-brand">
        <div className="side-logo" aria-hidden="true">
          <Icon>
            <path d="M8 5.5h8M12 5.5v13M8 18.5h8" />
          </Icon>
        </div>
        <div>
          <div className="side-brand-name">IUOVA</div>
          <div className="side-brand-sub">Email Intelligence</div>
        </div>
      </div>

      <nav className="side-nav" aria-label="Main navigation">
        {NAV_SECTIONS.map((section) => (
          <div className="side-section" key={section.label}>
            <div className="side-section-label">{section.label}</div>
            {section.tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`side-item ${activeTab === tab ? 'active' : ''}`}
                onClick={() => onNavigate(tab)}
              >
                <span className="side-icon">
                  <Icon>{NAV_ICONS[tab]}</Icon>
                </span>
                <span className="side-label">{NAV_META[tab].title}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="side-user">
        <div className="side-avatar">{getInitials(userName)}</div>
        <div className="side-user-info">
          <div className="side-user-name">{userName}</div>
          <div className="side-user-role">BD Manager</div>
        </div>
      </div>

      <div className="side-foot">IUOVA · Outreach OS · v1.0</div>
    </aside>
  )
}