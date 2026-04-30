export function HalfLifeGauge({
  days,
  max = 90,
}: {
  days: number | null | undefined
  max?: number
}) {
  if (days == null) {
    return <div className="h-1 w-full rounded-full bg-zinc-100" />
  }
  const pct = Math.max(0, Math.min(1, days / max))
  const color =
    pct >= 0.66 ? 'bg-emerald-500' : pct >= 0.33 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-100">
      <div className={`h-full ${color}`} style={{ width: `${pct * 100}%` }} />
    </div>
  )
}

export function SentimentSlope({
  slope,
}: {
  slope: number | null | undefined
}) {
  if (slope == null) return <span className="text-zinc-400">—</span>
  const arrow = slope > 0.05 ? '↑' : slope < -0.05 ? '↓' : '→'
  const color =
    slope > 0.05
      ? 'text-emerald-600'
      : slope < -0.05
        ? 'text-red-600'
        : 'text-zinc-500'
  return (
    <span className={`tabular-nums ${color}`}>
      {arrow} {slope.toFixed(2)}
    </span>
  )
}
