export type Tier = 1 | 2 | 3

export type Contact = {
  id: string
  user_id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  title: string | null
  linkedin: string | null
  tier: Tier | null
  tags: string[] | null
  ltv_estimate: number | null
  half_life_days: number | null
  sentiment_slope: number | null
  last_interaction_at: string | null
  created_at: string
  updated_at: string
}

export type Interaction = {
  id: string
  user_id: string
  contact_id: string
  channel: string | null
  direction: 'inbound' | 'outbound' | null
  summary: string | null
  body: string | null
  sentiment: number | null
  occurred_at: string
  created_at: string
}

export type CommitmentStatus = 'open' | 'done' | 'snoozed' | 'cancelled'

export type Commitment = {
  id: string
  user_id: string
  contact_id: string | null
  description: string
  due_at: string | null
  status: CommitmentStatus
  completed_at: string | null
  created_at: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export type Approval = {
  id: string
  user_id: string
  contact_id: string | null
  channel: string | null
  recipient: string | null
  draft: string
  context: string | null
  status: ApprovalStatus
  created_at: string
  decided_at: string | null
}

export type RelationshipSnapshot = {
  id: string
  user_id: string
  contact_id: string
  health_score: number | null
  half_life_days: number | null
  sentiment: number | null
  captured_at: string
}
