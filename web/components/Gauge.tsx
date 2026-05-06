export function HalfLifeGauge({
  days,
  max = 90,
}: {
  days: number | null | undefined
  max?: number
}) {
  if (days == null) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.04]" />
    )
  }
  const pct = Math.max(0, Math.min(1, days / max))
  const fill =
    pct >= 0.66
      ? 'from-emerald-400 to-teal-400'
      : pct >= 0.33
        ? 'from-amber-400 to-fuchsia-400'
        : 'from-rose-500 to-fuchsia-500'
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
      <div
        className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${fill} shadow-[0_0_8px_rgba(139,92,246,0.45)] transition-[width] duration-500`}
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  )
}

export function SentimentSlope({
  slope,
}: {
  slope: number | null | undefined
}) {
  if (slope == null) return <span className="text-zinc-600">—</span>
  const arrow = slope > 0.05 ? '↑' : slope < -0.05 ? '↓' : '→'
  const cls =
    slope > 0.05
      ? 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30'
      : slope < -0.05
        ? 'text-rose-300 bg-rose-500/10 ring-rose-500/30'
        : 'text-zinc-400 bg-white/[0.03] ring-white/10'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums ring-1 ring-inset ${cls}`}
    >
      {arrow} {slope.toFixed(2)}
    </span>
  )
}
