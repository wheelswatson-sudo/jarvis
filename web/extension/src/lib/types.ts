export type Source = 'linkedin' | 'facebook'

export type ExtractedProfile = {
  source: Source
  url: string
  name: string | null
  headline: string | null
  title: string | null
  company: string | null
  location: string | null
  about: string | null
  profile_photo_url: string | null
  recent_posts: string[]
  current_city: string | null
  workplace: string | null
  life_events: string[]
}

export type ContactMatch = {
  id: string
  name: string
  company: string | null
  title: string | null
  linkedin: string | null
  personal_details: Record<string, unknown> | null
}

export type SidebarContext = {
  contact: {
    id: string
    name: string
    company: string | null
    title: string | null
    relationship_score: number | null
    next_follow_up: string | null
    last_interaction_at: string | null
    tier: number | null
  }
  health_label: string
  last_interaction_summary: string | null
  open_commitments: Array<{
    id: string
    description: string
    owner: 'me' | 'them'
    due_at: string | null
  }>
  next_follow_up: string | null
  detected_changes: Array<{
    field: string
    old: string | null
    new: string | null
  }>
}

export type StaleContact = {
  id: string
  name: string
  days_since: number | null
  social_url: string | null
  source: Source
}

export type Settings = {
  baseUrl: string
  token: string | null
}
