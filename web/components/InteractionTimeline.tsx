import type { Interaction } from '../lib/types'
import { formatRelative } from '../lib/format'

const TYPE_DOT: Record<string, string> = {
  call: 'bg-indigo-400',
  meeting: 'bg-violet-400',
  email: 'bg-fuchsia-400',
  text: 'bg-pink-400',
  'in-person': 'bg-emerald-400',
  other: 'bg-zinc-500',
}

export function InteractionTimeline({
  interactions,
}: {
  interactions: Interaction[]
}) {
  if (interactions.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        No interactions logged yet. Use “Log interaction” above to start the
        timeline.
      </p>
    )
  }
  return (
    <ul className="space-y-5">
      {interactions.map((it) => {
        const t = it.type ?? it.channel ?? 'other'
        const dot = TYPE_DOT[t] ?? TYPE_DOT.other
        return (
          <li key={it.id} className="relative pl-6">
            <span
              className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${dot}`}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-zinc-500">
              <span className="font-medium uppercase tracking-wide text-zinc-400">
                {t}
                {it.direction ? ` · ${it.direction}` : ''}
              </span>
              <span>{formatRelative(it.occurred_at)}</span>
            </div>
            {it.summary && (
              <p className="mt-1 text-sm text-zinc-200">{it.summary}</p>
            )}
            {it.key_points && it.key_points.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
                {it.key_points.slice(0, 5).map((kp, i) => (
                  <li key={i}>· {kp}</li>
                ))}
              </ul>
            )}
            {it.action_items && it.action_items.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {it.action_items.map((a, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      a.owner === 'me'
                        ? 'border-violet-500/40 bg-violet-500/10 text-violet-200'
                        : 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200'
                    }`}
                  >
                    {a.owner === 'me' ? 'you' : 'they'} · {a.description.slice(0, 60)}
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
