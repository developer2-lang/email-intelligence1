import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Sidebar from '../components/Sidebar'
import Toast from '../components/Toast'
import { NAV_META } from '../constants/constants'
import type { TabKey, ToastMessage } from '../types'

interface MainLayoutProps {
  activeTab: TabKey
  onNavigate: (tab: TabKey) => void
  toasts: ToastMessage[]
  prefFrom?: string
  userEmail?: string
  onSignOut?: () => void
  children: ReactNode
}

export default function MainLayout({ activeTab, onNavigate, toasts, prefFrom, userEmail, onSignOut, children }: MainLayoutProps) {
  const [navOpen, setNavOpen] = useState(false)
  const meta = NAV_META[activeTab]

  // Close the mobile navigation drawer on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleNavigate = (tab: TabKey) => {
    setNavOpen(false)
    onNavigate(tab)
  }

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <Sidebar activeTab={activeTab} onNavigate={handleNavigate} prefFrom={prefFrom} userEmail={userEmail} onSignOut={onSignOut} />

      <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="nav-toggle"
              onClick={() => setNavOpen((p) => !p)}
              aria-label="Toggle navigation menu"
              aria-expanded={navOpen}
              aria-controls="app-sidebar"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <div>
              <div className="topbar-title">{meta.title}</div>
              <div className="topbar-sub">{meta.sub}</div>
            </div>
          </div>
          <div className="topbar-right">
            <span className="tag tag-client">{userEmail ? userEmail : 'Demo Mode'}</span>
          </div>
        </header>

        <div className="content">{children}</div>
      </main>

      <div className="toast-wrap">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} />
        ))}
      </div>
    </div>
  )
}
