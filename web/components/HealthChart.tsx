import type { RelationshipSnapshot } from '../lib/types'

export function HealthChart({
  snapshots,
}: {
  snapshots: RelationshipSnapshot[]
}) {
  if (snapshots.length === 0) {
    return (
      <p className="text-sm text-zinc-400">No health snapshots yet.</p>
    )
  }
  const sorted = [...snapshots].sort(
    (a, b) =>
      new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime(),
  )
  const W = 600
  const H = 120
  const PAD = 8
  const xs = sorted.map(
    (s, i) =>
      PAD + (i * (W - 2 * PAD)) / Math.max(1, sorted.length - 1),
  )
  const ys = sorted.map((s) => {
    const v = s.health_score ?? 0
    const clamped = Math.max(0, Math.min(1, v))
    return H - PAD - clamped * (H - 2 * PAD)
  })
  const path = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-32 w-full"
      preserveAspectRatio="none"
    >
      <line
        x1={PAD}
        x2={W - PAD}
        y1={H - PAD}
        y2={H - PAD}
        stroke="rgb(228 228 231)"
      />
      <path d={path} fill="none" stroke="rgb(24 24 27)" strokeWidth={1.5} />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r={2.5} fill="rgb(24 24 27)" />
      ))}
    </svg>
  )
}
