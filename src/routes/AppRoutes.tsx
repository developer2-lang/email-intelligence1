import type { RefObject } from 'react'
import type { ApiState, CampTabState, StoredApiKeys, TabKey } from '../types'
import type { ActivityItem, EngagedContact } from '../services/dashboardService'
import AnalyticsTab from '../pages/AnalyticsTab'
import CampaignsTab from '../pages/CampaignsTab'
import ContactTypesTab from '../pages/ContactTypesTab'
import ContactsTab from '../pages/ContactsTab'
import DashboardTab from '../pages/DashboardTab'
import FollowupsTab from '../pages/FollowupsTab'
import SequenceBuilderTab from '../pages/SequenceBuilderTab'
import SequencesTab from '../pages/SequencesTab'
import SettingsTab from '../pages/SettingsTab'
import TemplateEditorTab from '../pages/TemplateEditorTab'
import TemplatesPage from '../pages/TemplatesPage'
import LeadSearch from '../pages/LeadSearch'

export interface AppRoutesProps {
  activeTab: TabKey
  contacts: any[]
  campaigns: any[]
  sequences: any[]
  apiState: ApiState
  storedApiKeys: StoredApiKeys
  onPersistContacts: (contacts: any[]) => void
  onPersistCampaigns: (campaigns: any[]) => void
  onPersistSequences: (sequences: any[]) => void
  onPersistApiKeys: (keys: StoredApiKeys) => void
  onNavigate: (tab: TabKey) => void
  onToast: (msg: string, type?: string) => void
  isUploadModalOpen: boolean
  setIsUploadModalOpen: (open: boolean) => void
  campTabState: CampTabState
  setCampTabState: (state: CampTabState) => void
  selectedAudienceEmails?: string[]
  onClearSelectedAudienceEmails?: () => void
  onQueueSelectedContacts?: (emails: string[]) => void
  chart1Ref: RefObject<HTMLCanvasElement | null>
  activityFeed: ActivityItem[]
  enrolledContactsCount: number
  topEngaged: EngagedContact[]
  dashboardLoading: boolean
  dashboardError: string | null
  onRetryDashboard: () => void
  isSyncing: boolean
  triggerMailchimpSync: () => void
  prefFrom: string
  setPrefFrom: (val: string) => void
  prefReply: string
  setPrefReply: (val: string) => void
  prefSig: string
  setPrefSig: (val: string) => void
}

export default function AppRoutes(props: AppRoutesProps) {
  switch (props.activeTab) {
    case 'dashboard':
      return (
        <DashboardTab
          contacts={props.contacts}
          campaigns={props.campaigns}
          activeSequencesCount={props.sequences.filter((s) => s.status === 'active').length}
          enrolledContactsCount={props.enrolledContactsCount}
          activityFeed={props.activityFeed}
          topEngaged={props.topEngaged}
          loading={props.dashboardLoading}
          error={props.dashboardError}
          onRetry={props.onRetryDashboard}
          chart1Ref={props.chart1Ref}
          onNavigate={props.onNavigate}
        />
      )

    case 'contacts':
      return (
        <ContactsTab
          contacts={props.contacts}
          apiState={props.apiState}
          onPersistContacts={props.onPersistContacts}
          onToast={props.onToast}
          onNavigate={props.onNavigate}
          isUploadModalOpen={props.isUploadModalOpen}
          setIsUploadModalOpen={props.setIsUploadModalOpen}
          onQueueSelectedContacts={props.onQueueSelectedContacts}
        />
      )

    case 'campaigns':
      return (
        <CampaignsTab
          campaigns={props.campaigns}
          contacts={props.contacts}
          onPersistCampaigns={props.onPersistCampaigns}
          onToast={props.onToast}
          campTabState={props.campTabState}
          setCampTabState={props.setCampTabState}
          selectedAudienceEmails={props.selectedAudienceEmails}
          onClearSelectedAudienceEmails={props.onClearSelectedAudienceEmails}
        />
      )

    case 'followups':
      return (
        <FollowupsTab
          campaigns={props.campaigns}
          onPersistCampaigns={props.onPersistCampaigns}
          onToast={props.onToast}
          onNavigate={props.onNavigate}
        />
      )

    case 'sequences':
      return (
        <SequencesTab
          onPersistSequences={props.onPersistSequences}
          onToast={props.onToast}
        />
      )

    case 'sequence-builder':
      return (
        <SequenceBuilderTab
          onNavigate={props.onNavigate}
          onToast={props.onToast}
        />
      )

    case 'analytics':
      return (
        <AnalyticsTab
          onToast={props.onToast}
          onNavigate={props.onNavigate}
        />
      )

    case 'template-editor':
      return <TemplateEditorTab onToast={props.onToast} onNavigate={props.onNavigate} />

    case 'template-library':
      return <TemplatesPage onNavigate={props.onNavigate} onToast={props.onToast} />

    case 'settings':
      return (
        <SettingsTab
          contacts={props.contacts}
          apiState={props.apiState}
          storedApiKeys={props.storedApiKeys}
          onPersistApiKeys={props.onPersistApiKeys}
          onPersistContacts={props.onPersistContacts}
          onToast={props.onToast}
          isSyncing={props.isSyncing}
          triggerMailchimpSync={props.triggerMailchimpSync}
          prefFrom={props.prefFrom}
          setPrefFrom={props.setPrefFrom}
          prefReply={props.prefReply}
          setPrefReply={props.setPrefReply}
          prefSig={props.prefSig}
          setPrefSig={props.setPrefSig}
        />
      )

    case 'contact-types':
      return <ContactTypesTab onToast={props.onToast} />

    case 'lead-search':
      return <LeadSearch />

    default:
      return null
  }
}
