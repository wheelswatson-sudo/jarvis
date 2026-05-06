import type { Interaction } from '../lib/types'
import { formatRelative } from '../lib/format'

const TYPE_TONE: Record<string, { dot: string; text: string }> = {
  call: { dot: 'bg-indigo-400', text: 'text-indigo-300' },
  meeting: { dot: 'bg-violet-400', text: 'text-violet-300' },
  email: { dot: 'bg-fuchsia-400', text: 'text-fuchsia-300' },
  text: { dot: 'bg-pink-400', text: 'text-pink-300' },
  'in-person': { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  other: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
}

export function InteractionTimeline({
  interactions,
}: {
  interactions: Interaction[]
}) {
  if (interactions.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No interactions logged yet. Use &ldquo;Log interaction&rdquo; above to
        start the timeline.
      </p>
    )
  }
  return (
    <ul className="relative space-y-6 pl-1">
      {/* Vertical timeline rail */}
      <span
        aria-hidden="true"
        className="absolute left-[5px] top-2 bottom-2 w-px bg-gradient-to-b from-violet-500/50 via-white/[0.05] to-transparent"
      />
      {interactions.map((it) => {
        const t = it.type ?? it.channel ?? 'other'
        const tone = TYPE_TONE[t] ?? TYPE_TONE.other
        return (
          <li key={it.id} className="relative pl-7">
            <span
              className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-[#07070b] shadow-[0_0_10px_currentColor] ${tone.dot}`}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-[10px] uppercase tracking-[0.16em]">
              <span className={`font-medium ${tone.text}`}>
                {t}
                {it.direction ? ` · ${it.direction}` : ''}
              </span>
              <span className="text-zinc-500">{formatRelative(it.occurred_at)}</span>
            </div>
            {it.summary && (
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-200">
                {it.summary}
              </p>
            )}
            {it.key_points && it.key_points.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
                {it.key_points.slice(0, 5).map((kp, i) => (
                  <li key={i} className="leading-relaxed">
                    <span className="text-zinc-600">·</span> {kp}
                  </li>
                ))}
              </ul>
            )}
            {it.action_items && it.action_items.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {it.action_items.map((a, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ${
                      a.owner === 'me'
                        ? 'bg-indigo-500/10 text-indigo-200 ring-indigo-500/30'
                        : 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-500/30'
                    }`}
                  >
                    {a.owner === 'me' ? 'you' : 'they'} ·{' '}
                    {a.description.slice(0, 60)}
                  </span>
                ))}
              </div>
            )}
            {it.follow_up_date && (
              <p className="mt-2 text-xs text-zinc-500">
                Follow-up scheduled for{' '}
                <span className="text-zinc-300">
                  {new Date(it.follow_up_date).toLocaleDateString()}
                </span>
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
