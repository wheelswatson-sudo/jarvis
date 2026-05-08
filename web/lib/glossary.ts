// Single source of truth for jargon explanations.
// Every place that surfaces "tier", "half-life", "LTV", "sentiment slope"
// should pull copy from here so the app speaks with one voice.

export const TIER_GLOSSARY = {
  T1: {
    label: 'Inner circle',
    description:
      'Closest 5-15 people. Family, co-founders, key investors, top customers. AIEA nudges hardest if any cool down.',
  },
  T2: {
    label: 'Important',
    description:
      'Strong relationships you want to keep warm — advisors, partners, frequent collaborators. Surfaced when they go quiet.',
  },
  T3: {
    label: 'Maintain',
    description:
      'People worth touching base with quarterly. Light-touch reminders only.',
  },
} as const

export const TIER_HELP_TEXT =
  'Tier 1 = closest 5-15 (family, co-founders, top customers). Tier 2 = important (advisors, partners). Tier 3 = quarterly check-ins. AIEA nudges harder for higher tiers.'

export const HALF_LIFE_HELP =
  'How long a relationship stays warm without contact. Higher = healthier. Below 21 days means the relationship is cooling.'

export const SENTIMENT_SLOPE_HELP =
  'Direction of recent interactions. ↑ = warming, ↓ = cooling, → = steady. Based on tone of recent messages and meetings.'

export const NETWORK_HEALTH_HELP =
  'Average warmth of your network, scaled 0-100%. Higher = more relationships are in good shape.'

export const LTV_HELP =
  'Predicted lifetime value of the relationship — what AIEA estimates this person is worth to you over time, based on role, history, and engagement.'

export const COMMITMENT_HELP =
  'A promise you made (you owe) or someone made to you (they owe). AIEA tracks these so nothing slips.'

export const APPROVALS_HELP =
  'When Google Contacts or Apollo wants to overwrite a field you edited, the change waits here for your approval.'
