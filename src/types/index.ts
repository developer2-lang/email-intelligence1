export type TabKey =
  | 'dashboard'
  | 'contacts'
  | 'campaigns'
  | 'followups'
  | 'sequences'
  | 'sequence-builder'
  | 'analytics'
  | 'settings'
  | 'template-editor'
  | 'template-library'
  | 'contact-types'
  | 'lead-search';

export type CampTabState = 'list' | 'compose' | 'templates' | 'followups'

export interface ApiState {
  lusha: boolean
  mailchimp: boolean
}

export interface StoredApiKeys {
  lusha: string
  mailchimp: string
}

export interface SenderPrefs {
  from: string
  reply: string
  signature: string
}

export type ToastType = 'success' | 'error' | 'info' | 'warn'

export interface ToastMessage {
  id: number
  text: string
  type: ToastType
}
