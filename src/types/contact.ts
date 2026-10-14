export interface Contact {
  id: string
  name: string
  email: string
  company: string
  designation: string
  industry: string
  city: string
  type: string
  category: string
  notes: string
  lastContacted: string
  engagement: number
  enriched: boolean
  phone?: string
  phone_1?: string
  phone_2?: string
  createdAt?: string
}

export interface ContactRow {
  id: string
  full_name: string
  email: string
  company: string
  designation: string | null
  industry: string | null
  city: string | null
  contact_type: string | null
  company_category: string | null
  notes: string | null
  created_at: string | null
  phone_1?: string | null
  phone_2?: string | null
}

export interface ContactInput {
  full_name: string
  email: string
  company: string
  designation?: string | null
  industry?: string | null
  city?: string | null
  contact_type?: string
  company_category?: string
  notes?: string | null
  // Legacy form callers are normalized to phone_1 by contactsService.
  phone?: string | null
  phone_1?: string | null
  phone_2?: string | null
}
