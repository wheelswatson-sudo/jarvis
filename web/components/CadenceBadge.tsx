import { CADENCE_TONE, getCadenceInfo } from '../lib/contacts/cadence'
import type { Tier } from '../lib/types'

type Props = {
  tier: Tier | null | undefined
  lastInteractionAt: string | null | undefined
  variant?: 'full' | 'compact'
}

export function CadenceBadge({ tier, lastInteractionAt, variant = 'full' }: Props) {
  const info = getCadenceInfo(tier, lastInteractionAt)
  if (info.state === 'unknown') return null

  const tone = CADENCE_TONE[info.state]

  if (variant === 'compact') {
    let label: string
    if (info.state === 'overdue') {
      label =
        info.daysSinceLast == null
          ? 'Overdue'
          : `${info.daysSinceLast}d overdue`
    } else if (info.state === 'approaching') {
      label = 'Due soon'
    } else if (info.state === 'new') {
      label = 'New'
    } else {
      label = 'On cadence'
    }
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.badge}`}
      >
        <span className={`h-1 w-1 rounded-full ${tone.dot}`} aria-hidden="true" />
        {label}
      </span>
    )
  }

  let detail: string
  if (info.daysSinceLast == null) {
    detail = info.state === 'new' ? 'Not yet contacted' : 'No contact yet'
  } else if (info.state === 'overdue') {
    detail = `${info.daysSinceLast}d since last contact · target ${info.cadenceDays}d`
  } else {
    detail = `${info.daysSinceLast}d since last · target ${info.cadenceDays}d`
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium ${tone.badge}`}
      >
        <span className={`h-1 w-1 rounded-full ${tone.dot}`} aria-hidden="true" />
        {tone.label}
      </span>
      {info.cadenceLabel && (
        <span className="text-[11px] text-zinc-500">{info.cadenceLabel}</span>
      )}
      <span className="text-[11px] text-zinc-600">·</span>
      <span className="text-[11px] text-zinc-500">{detail}</span>
    </div>
  )
}
