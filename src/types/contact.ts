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
  phone?: string | null
  contact_no?: string | null
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
  phone?: string | null
  contact_no?: string | null
}
