// Tuning knobs for the intelligence system. Centralized so the engine
// itself is purely declarative and the parameters are easy to monitor /
// adjust from the self-tuning loop.

export const CONFIDENCE_PROMOTION_THRESHOLD = 0.45
export const CONFIDENCE_DECAY_THRESHOLD = 0.3
export const SAMPLE_SIZE_PROMOTION_THRESHOLD = 5

// Insight expiry window — pending insights older than this auto-expire.
export const INSIGHT_EXPIRY_DAYS = 14

// Acceptance-rate self-tuning. If acceptance drops below this fraction over
// the configured lookback window, the engine emits fewer insights per run.
export const LOW_ACCEPTANCE_THRESHOLD = 0.2
export const ACCEPTANCE_LOOKBACK_DAYS = 30

// Pattern-specific thresholds.
export const RELATIONSHIP_DECAY = {
  // A T1 contact untouched for >2x its observed cadence is a decay signal.
  cadenceMultiplier: 2,
  // Hard floor — anything past 60d for a key contact is stale.
  hardFloorDays: 60,
} as const

export const TIMING = {
  // Minimum sample size to consider a day-of-week or hour-bucket pattern.
  minOutreachSamples: 6,
  // The strongest day must beat the average by this much to be a real signal.
  liftThreshold: 1.5,
} as const

export const ENGAGEMENT = {
  // Two contacts engaged with on the same day at least this many times = cluster.
  coOccurrenceThreshold: 3,
  // Maximum cluster size to surface — above this, the cluster is too generic.
  maxClusterSize: 6,
} as const

export const COMMITMENT = {
  // Minimum samples in each commitment-type bucket before comparing rates.
  minSamplesPerBucket: 3,
  // Difference in completion rate that's worth surfacing.
  rateDeltaThreshold: 0.25,
} as const

export const PRIORITY = {
  // Top N contacts to surface as auto-priority capsules.
  topN: 10,
  // Recency, frequency, diversity weights.
  weights: {
    frequency: 0.45,
    recency: 0.35,
    diversity: 0.2,
  },
} as const

// Rolling window sizes (in days).
export const WINDOWS = {
  short: 7,
  medium: 30,
  long: 90,
} as const
