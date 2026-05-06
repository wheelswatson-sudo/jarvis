import type { RelationshipSnapshot } from '../lib/types'

export function HealthChart({
  snapshots,
}: {
  snapshots: RelationshipSnapshot[]
}) {
  if (snapshots.length === 0) {
    return <p className="text-sm text-zinc-500">No health snapshots yet.</p>
  }
  const sorted = [...snapshots].sort(
    (a, b) =>
      new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime(),
  )
  const W = 600
  const H = 120
  const PAD = 8
  const xs = sorted.map(
    (s, i) => PAD + (i * (W - 2 * PAD)) / Math.max(1, sorted.length - 1),
  )
  const ys = sorted.map((s) => {
    const v = s.health_score ?? 0
    const clamped = Math.max(0, Math.min(1, v))
    return H - PAD - clamped * (H - 2 * PAD)
  })
  const line = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`)
    .join(' ')
  // Build a closed area path for the gradient fill
  const area = [
    `M${xs[0].toFixed(1)},${(H - PAD).toFixed(1)}`,
    ...xs.map((x, i) => `L${x.toFixed(1)},${ys[i].toFixed(1)}`),
    `L${xs[xs.length - 1].toFixed(1)},${(H - PAD).toFixed(1)}`,
    'Z',
  ].join(' ')

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-32 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aiea-health-line" x1="0" y1="0" x2={W} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="50%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#e879f9" />
        </linearGradient>
        <linearGradient id="aiea-health-fill" x1="0" y1="0" x2="0" y2={H} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* baseline grid */}
      <line
        x1={PAD}
        x2={W - PAD}
        y1={H - PAD}
        y2={H - PAD}
        stroke="rgba(255,255,255,0.06)"
      />
      <path d={area} fill="url(#aiea-health-fill)" />
      <path
        d={line}
        fill="none"
        stroke="url(#aiea-health-line)"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r={2.4} fill="#c4b5fd" />
      ))}
    </svg>
  )
}
