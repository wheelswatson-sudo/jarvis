import type { ContactMomentum } from '../lib/intelligence/contact-momentum'

const SVG_W = 220
const SVG_H = 48
const PADDING_Y = 4

export function RelationshipMomentum({ momentum }: { momentum: ContactMomentum }) {
  if (momentum.sample_count < 2) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          Momentum
        </div>
        <p className="mt-1.5 text-xs text-zinc-500">
          {momentum.sample_count === 0
            ? 'No score history yet. The first snapshot lands after the next cron run.'
            : 'Only one snapshot so far — need at least two to plot a trend.'}
        </p>
      </div>
    )
  }

  const compositePoints = momentum.series
    .map((p) => p.composite)
    .filter((v): v is number => v !== null)
  if (compositePoints.length < 2) {
    return null
  }

  const sparkline = buildSparklinePath(momentum.series.map((p) => p.composite))
  const delta = momentum.delta_30d
  const deltaPct = delta == null ? null : Math.round(delta * 100)
  const currentPct =
    momentum.current_composite == null
      ? null
      : Math.round(momentum.current_composite * 100)

  const deltaCls =
    deltaPct == null
      ? 'text-zinc-400'
      : deltaPct > 0
        ? 'text-emerald-300'
        : deltaPct < 0
          ? 'text-amber-300'
          : 'text-zinc-400'
  const deltaArrow = deltaPct == null ? '' : deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '·'
  const strokeCls =
    deltaPct == null || deltaPct === 0
      ? 'stroke-violet-300'
      : deltaPct > 0
        ? 'stroke-emerald-300'
        : 'stroke-amber-300'

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
          Momentum
        </div>
        <div className="text-[10px] text-zinc-500">
          {momentum.sample_count} snapshots · last 90d
        </div>
      </div>

      <div className="mt-2 flex items-center gap-4">
        <svg
          width={SVG_W}
          height={SVG_H}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="shrink-0"
          aria-label="Composite score sparkline"
        >
          <path
            d={sparkline.areaPath}
            className={`${strokeCls} opacity-20`}
            fill="currentColor"
            stroke="none"
          />
          <path
            d={sparkline.linePath}
            className={strokeCls}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {sparkline.lastPoint && (
            <circle
              cx={sparkline.lastPoint.x}
              cy={sparkline.lastPoint.y}
              r={2.5}
              className={`${strokeCls} fill-current`}
            />
          )}
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-medium tabular-nums text-zinc-100">
              {currentPct == null ? '—' : `${currentPct}%`}
            </span>
            {deltaPct != null && (
              <span className={`text-sm tabular-nums ${deltaCls}`}>
                {deltaArrow} {Math.abs(deltaPct)}%
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500">
            {deltaPct == null
              ? 'Composite score, sparkline shows last 90d.'
              : `Composite score, ${deltaPct >= 0 ? 'up' : 'down'} ${Math.abs(deltaPct)}% over the last 30 days.`}
          </div>
        </div>
      </div>
    </div>
  )
}

// Map the composite series to SVG coordinates. NULLs are skipped — the path
// uses moveTo+lineTo so gaps in the data become visual gaps, not phantom
// drops to zero.
function buildSparklinePath(values: (number | null)[]): {
  linePath: string
  areaPath: string
  lastPoint: { x: number; y: number } | null
} {
  const points: Array<{ x: number; y: number } | null> = []
  const n = values.length
  if (n === 0) return { linePath: '', areaPath: '', lastPoint: null }
  const innerH = SVG_H - PADDING_Y * 2
  // Composite is 0-1; clamp to keep numerical glitches from escaping the box.
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v == null || !Number.isFinite(v)) {
      points.push(null)
      continue
    }
    const x = n === 1 ? SVG_W / 2 : (i / (n - 1)) * SVG_W
    const clamped = Math.max(0, Math.min(1, v))
    const y = SVG_H - PADDING_Y - clamped * innerH
    points.push({ x, y })
  }

  // Build the line path with explicit M segments around nulls.
  let linePath = ''
  let lastNonNull: { x: number; y: number } | null = null
  let pendingMove = true
  for (const p of points) {
    if (p == null) {
      pendingMove = true
      continue
    }
    linePath += `${pendingMove ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)} `
    pendingMove = false
    lastNonNull = p
  }
  linePath = linePath.trim()

  // Area path mirrors the line back to the baseline for the soft fill.
  const baseline = SVG_H - PADDING_Y / 2
  let areaPath = ''
  let inSegment = false
  let segmentStartX: number | null = null
  let segmentEndX: number | null = null
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p == null) {
      if (inSegment && segmentStartX != null && segmentEndX != null) {
        areaPath += `L${segmentEndX.toFixed(2)},${baseline.toFixed(2)} L${segmentStartX.toFixed(2)},${baseline.toFixed(2)} Z `
        inSegment = false
        segmentStartX = null
        segmentEndX = null
      }
      continue
    }
    if (!inSegment) {
      areaPath += `M${p.x.toFixed(2)},${p.y.toFixed(2)} `
      segmentStartX = p.x
      inSegment = true
    } else {
      areaPath += `L${p.x.toFixed(2)},${p.y.toFixed(2)} `
    }
    segmentEndX = p.x
  }
  if (inSegment && segmentStartX != null && segmentEndX != null) {
    areaPath += `L${segmentEndX.toFixed(2)},${baseline.toFixed(2)} L${segmentStartX.toFixed(2)},${baseline.toFixed(2)} Z`
  }

  return { linePath, areaPath: areaPath.trim(), lastPoint: lastNonNull }
}
