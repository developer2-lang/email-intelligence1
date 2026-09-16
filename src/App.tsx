import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SEED_CAMPAIGNS, SEED_CONTACTS } from './constants/constants'
import { useLocalStorage } from './hooks/useLocalStorage'
import MainLayout from './layouts/MainLayout'
import AppRoutes from './routes/AppRoutes'
import type { ApiState, CampTabState, SenderPrefs, StoredApiKeys, TabKey, ToastMessage } from './types'
import { fetchCampaigns } from './services/campaignService'
import { fetchContacts } from './services/contactsService'
import { fetchSequences } from './api/sequenceApi'
import {
  fetchEnrolledContactsCount,
  fetchRecentActivity,
  fetchTopEngagedContacts,
} from './services/dashboardService'
import type { ActivityItem, EngagedContact } from './services/dashboardService'

const DEFAULT_KEYS: StoredApiKeys = { lusha: '', mailchimp: '' }

// Minimal hash routing so `/template-editor` can be opened as a deep link
// (and the app keeps its existing tab-based navigation everywhere else).
function tabFromHash(): TabKey | null {
  const hash = window.location.hash.replace(/^#\/?/, '').trim()
  if (hash === 'template-editor') return 'template-editor'
  if (hash === 'lead-search') return 'lead-search'
  return null
}

const DEFAULT_PREFS: SenderPrefs = {
  from: 'Rupali Sirsath <rupali.s@iuova.com>',
  reply: 'rupali.s@iuova.com',
  signature:
    'Best regards,\nRupali Sirsath\nBusiness Development | IUOVA Design Consultancy',
}

export default function App() {
  // ─── PERSISTED DATA ───
  const [contacts, setContacts] = useLocalStorage<any[]>('ei_contacts', SEED_CONTACTS)
  const [campaigns, setCampaigns] = useLocalStorage<any[]>('ei_campaigns', SEED_CAMPAIGNS)
  const [sequences, setSequences] = useLocalStorage<any[]>('ei_sequences', [])
  const [storedApiKeys, setStoredApiKeys] = useLocalStorage<StoredApiKeys>(
    'ei_api_keys',
    DEFAULT_KEYS,
  )
  const [prefs, setPrefs] = useLocalStorage<SenderPrefs>('ei_sender_prefs', DEFAULT_PREFS)

  // ─── UI STATE ───
  const [activeTab, setActiveTab] = useState<TabKey>(() => tabFromHash() ?? 'dashboard')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false)
  const [campTabState, setCampTabState] = useState<CampTabState>('list')
  const [selectedAudienceEmails, setSelectedAudienceEmails] = useState<string[]>([])
  const [isSyncing, setIsSyncing] = useState(false)
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([])
  const [enrolledContactsCount, setEnrolledContactsCount] = useState(0)
  const [topEngaged, setTopEngaged] = useState<EngagedContact[]>([])
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState<string | null>(null)

  // ─── INITIAL LOAD FROM SUPABASE ───
  // Load contacts / campaigns / sequences + dashboard activity straight from
  // Supabase on first mount (and on dashboard retry) so the dashboard reflects
  // real DB state before any tab is visited (previously stats only appeared
  // once each tab had mounted).
  const loadDashboardData = useCallback(async () => {
    const [contactsRes, campaignsRes, sequencesRes, feed, enrolled, engaged] =
      await Promise.allSettled([
        fetchContacts(),
        fetchCampaigns(),
        fetchSequences(),
        fetchRecentActivity(),
        fetchEnrolledContactsCount(),
        fetchTopEngagedContacts(),
      ])

    if (contactsRes.status === 'fulfilled' && contactsRes.value && !contactsRes.value.error) {
      setContacts(contactsRes.value.data)
    }
    if (campaignsRes.status === 'fulfilled' && campaignsRes.value && !campaignsRes.value.error) {
      setCampaigns(campaignsRes.value.data)
    }
    if (sequencesRes.status === 'fulfilled' && Array.isArray(sequencesRes.value)) {
      setSequences(sequencesRes.value)
    }
    if (feed.status === 'fulfilled' && Array.isArray(feed.value)) {
      setActivityFeed(feed.value)
    }
    if (enrolled.status === 'fulfilled' && typeof enrolled.value === 'number') {
      setEnrolledContactsCount(enrolled.value)
    }
    if (engaged.status === 'fulfilled' && Array.isArray(engaged.value)) {
      setTopEngaged(engaged.value)
    }

    const failures: string[] = []
    if (contactsRes.status === 'rejected') {
      failures.push(`Contacts: ${(contactsRes.reason as Error)?.message || 'fetch failed'}`)
    } else if (contactsRes.value?.error) {
      failures.push(`Contacts: ${contactsRes.value.error}`)
    }
    if (campaignsRes.status === 'rejected') {
      failures.push(`Campaigns: ${(campaignsRes.reason as Error)?.message || 'fetch failed'}`)
    } else if (campaignsRes.value?.error) {
      failures.push(`Campaigns: ${campaignsRes.value.error}`)
    }
    if (sequencesRes.status === 'rejected') {
      failures.push(`Sequences: ${(sequencesRes.reason as Error)?.message || 'fetch failed'}`)
    }
    setDashboardError(failures.length > 0 ? failures.join(' · ') : null)
    setDashboardLoading(false)
  }, [setContacts, setCampaigns, setSequences])

  // Kick off the initial load on mount. Deferred by a tick so the load's
  // setStates never run synchronously inside the effect body.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboardData()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadDashboardData])

  const chart1Ref = useRef<HTMLCanvasElement | null>(null)

  const apiState: ApiState = useMemo(
    () => ({
      lusha: storedApiKeys.lusha.trim().length > 0,
      mailchimp: storedApiKeys.mailchimp.trim().length > 0,
    }),
    [storedApiKeys],
  )

  // ─── TOASTS ───
  const toastId = useRef(0)

  const onToast = useCallback((msg: string, type: string = 'info') => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { id, text: msg, type: type as ToastMessage['type'] }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3500)
  }, [])

  // ─── NAVIGATION ───
  const onNavigate = useCallback((tab: TabKey) => {
    setActiveTab(tab)
    if (tab === 'template-editor') {
      window.location.hash = '/template-editor'
    } else if (window.location.hash) {
      window.location.hash = ''
    }
  }, [])

  // Allow `/template-editor` to be reached via the URL hash (back/forward too).
  useEffect(() => {
    const onHashChange = () => {
      const tab = tabFromHash()
      if (tab) setActiveTab(tab)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // ─── MAILCHIMP SYNC (mock) ───
  const triggerMailchimpSync = useCallback(() => {
    if (isSyncing) return
    setIsSyncing(true)
    window.setTimeout(() => {
      setIsSyncing(false)
      onToast('Mailchimp analytics sync is available in Settings', 'info')
    }, 800)
  }, [isSyncing, onToast])

  // ─── BULK CONTACT → CAMPAIGN QUEUE ───
  const queueSelectedContacts = useCallback((emails: string[]) => {
    setSelectedAudienceEmails(emails)
    setCampTabState('compose')
    setActiveTab('campaigns')
  }, [])

  // ─── SENDER PREFERENCES ───
  const setPrefFrom = useCallback((val: string) => setPrefs((p) => ({ ...p, from: val })), [setPrefs])
  const setPrefReply = useCallback(
    (val: string) => setPrefs((p) => ({ ...p, reply: val })),
    [setPrefs],
  )
  const setPrefSig = useCallback(
    (val: string) => setPrefs((p) => ({ ...p, signature: val })),
    [setPrefs],
  )

  return (
    <MainLayout activeTab={activeTab} onNavigate={onNavigate} toasts={toasts} prefFrom={prefs.from}>
      <AppRoutes
        activeTab={activeTab}
        contacts={contacts}
        campaigns={campaigns}
        sequences={sequences}
        apiState={apiState}
        storedApiKeys={storedApiKeys}
        onPersistContacts={setContacts}
        onPersistCampaigns={setCampaigns}
        onPersistSequences={setSequences}
        onPersistApiKeys={setStoredApiKeys}
        onNavigate={onNavigate}
        onToast={onToast}
        isUploadModalOpen={isUploadModalOpen}
        setIsUploadModalOpen={setIsUploadModalOpen}
        campTabState={campTabState}
        setCampTabState={setCampTabState}
        selectedAudienceEmails={selectedAudienceEmails}
        onClearSelectedAudienceEmails={() => setSelectedAudienceEmails([])}
        onQueueSelectedContacts={queueSelectedContacts}
        chart1Ref={chart1Ref}
        activityFeed={activityFeed}
        enrolledContactsCount={enrolledContactsCount}
        topEngaged={topEngaged}
        dashboardLoading={dashboardLoading}
        dashboardError={dashboardError}
        onRetryDashboard={() => {
          setDashboardLoading(true)
          setDashboardError(null)
          void loadDashboardData()
        }}
        isSyncing={isSyncing}
        triggerMailchimpSync={triggerMailchimpSync}
        prefFrom={prefs.from}
        setPrefFrom={setPrefFrom}
        prefReply={prefs.reply}
        setPrefReply={setPrefReply}
        prefSig={prefs.signature}
        setPrefSig={setPrefSig}
      />
    </MainLayout>
  )
}
