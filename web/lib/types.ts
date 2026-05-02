export type Tier = 1 | 2 | 3

export const RELATIONSHIP_SCHEMA_VERSION = 1

export type CommitmentRecordStatus = 'pending' | 'completed' | 'overdue'

export type RelationshipCommitmentRecord = {
  action: string
  context?: string | null
  date_promised: string
  due?: string | null
  status: CommitmentRecordStatus
}

export type RelationshipMilestone = {
  date: string
  event: string
}

export type RelationshipSentimentPoint = {
  date: string
  sentiment: string
  score: number
}

export type RelationshipMeaningfulInteraction = {
  date: string
  channel: string
  summary: string
}

// Schema-grounded relationship memory. Stored inside personal_details (jsonb)
// so we can iterate without a column migration. New fields are optional;
// readers must tolerate older rows that don't have them.
export type PersonalDetails = {
  // Existing structured fields
  spouse?: string | null
  kids?: string[] | null
  family_notes?: string | null
  interests?: string[] | null
  hobbies?: string[] | null
  career_history?: { role: string; company: string; years?: string | null }[] | null
  life_events?: { date?: string | null; event: string }[] | null
  notes?: string | null

  // Social-monitoring fields (populated by the Chrome extension via the
  // /api/extension/* endpoints). Stored in personal_details JSONB so we
  // don't need a column migration.
  linkedin_url?: string | null
  facebook_url?: string | null
  linkedin_headline?: string | null
  linkedin_about?: string | null
  facebook_current_city?: string | null
  facebook_workplace?: string | null
  social_last_checked_at?: string | null

  // Import provenance
  import_source?: string | null
  birthday?: string | null
  google_resource_name?: string | null

  // ---- Schema-grounded relationship intelligence ----
  relationship_origin?: string | null
  key_milestones?: RelationshipMilestone[] | null
  topics_of_interest?: string[] | null
  communication_style?: string | null
  emotional_trajectory?: RelationshipSentimentPoint[] | null
  active_commitments_to_them?: RelationshipCommitmentRecord[] | null
  active_commitments_from_them?: RelationshipCommitmentRecord[] | null
  last_meaningful_interaction?: RelationshipMeaningfulInteraction | null
  reciprocity_score?: number | null
  schema_version?: number | null
}

export type Contact = {
  id: string
  user_id: string
  first_name: string | null
  last_name: string | null
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
  sentiment_trajectory: number | null
  reciprocity_ratio: number | null
  metrics_computed_at: string | null
  last_interaction_at: string | null
  personal_details: PersonalDetails | null
  relationship_score: number | null
  next_follow_up: string | null
  created_at: string
  updated_at: string
}

export type InteractionType =
  | 'call'
  | 'meeting'
  | 'email'
  | 'text'
  | 'in-person'
  | 'other'

export type ActionItem = {
  description: string
  owner: 'me' | 'them'
  due_date?: string | null
  completed?: boolean
}

export type Interaction = {
  id: string
  user_id: string
  contact_id: string
  channel: string | null
  direction: 'inbound' | 'outbound' | null
  type: InteractionType | null
  summary: string | null
  body: string | null
  sentiment: number | null
  key_points: string[]
  action_items: ActionItem[]
  follow_up_date: string | null
  transcript_data: Record<string, unknown> | null
  source: string | null
  occurred_at: string
  created_at: string
}

export type CommitmentStatus = 'open' | 'done' | 'snoozed' | 'cancelled'

export type CommitmentOwner = 'me' | 'them'

export type Commitment = {
  id: string
  user_id: string
  contact_id: string | null
  interaction_id?: string | null
  description: string
  notes?: string | null
  owner: CommitmentOwner
  due_at: string | null
  status: CommitmentStatus
  completed_at: string | null
  created_at: string
}

export type MeetingBrief = {
  who_they_are: string
  recent_context: string
  open_items: string[]
  suggested_talking_points: string[]
  relationship_health: string
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

export type PendingChangeStatus = 'pending' | 'approved' | 'rejected'

export type PendingChangeField =
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'company'
  | 'title'
  | 'linkedin'

export type PendingChange = {
  id: string
  user_id: string
  contact_id: string
  source: string
  field_name: string
  old_value: string | null
  new_value: string | null
  status: PendingChangeStatus
  created_at: string
  resolved_at: string | null
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

// ---------- Intelligence system ----------

export type EventType =
  | 'contact_viewed'
  | 'contact_updated'
  | 'outreach_sent'
  | 'commitment_created'
  | 'commitment_completed'
  | 'commitment_missed'
  | 'import_completed'
  | 'chat_query'
  | 'insight_dismissed'
  | 'insight_acted_on'

export type EventRow = {
  id: string
  user_id: string
  event_type: EventType
  contact_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type PatternType =
  | 'timing_preference'
  | 'engagement_pattern'
  | 'relationship_decay'
  | 'outreach_effectiveness'
  | 'contact_priority'

export type CapsuleStatus = 'emerging' | 'confirmed' | 'deployed' | 'stale'

export type ExperienceCapsule = {
  id: string
  user_id: string
  pattern_type: PatternType
  pattern_key: string
  pattern_data: Record<string, unknown>
  confidence_score: number
  sample_size: number
  status: CapsuleStatus
  first_observed_at: string
  last_confirmed_at: string
  updated_at: string
}

export type InsightStatus = 'pending' | 'acted_on' | 'dismissed' | 'expired'

export type IntelligenceInsight = {
  id: string
  user_id: string
  capsule_id: string | null
  insight_type: string
  insight_key: string
  title: string
  description: string
  priority: number
  status: InsightStatus
  metadata: Record<string, unknown>
  created_at: string
  acted_on_at: string | null
  expires_at: string | null
}

export type SystemHealthEventType =
  | 'analysis_run'
  | 'degradation_detected'
  | 'parameter_tuned'
  | 'rollback_triggered'
  | 'insight_generated'
  | 'capsule_promoted'
  | 'capsule_staled'
  | 'low_acceptance_rate'

export type SystemHealthEntry = {
  id: string
  event_type: SystemHealthEventType
  user_id: string | null
  details: Record<string, unknown>
  created_at: string
}
