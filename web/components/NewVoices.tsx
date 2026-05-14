import Link from 'next/link'
import type { NewVoice, NewVoiceKind } from '../lib/intelligence/new-voices'
import { Card, SectionHeader } from './cards'
import { HelpDot } from './Tooltip'

const KIND_META: Record<NewVoiceKind, { chip: string; eyebrow: string }> = {
  brand_new: {
    chip: 'bg-sky-500/10 text-sky-200 ring-sky-500/30',
    eyebrow: 'New voice',
  },
  reemerging: {
    chip: 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-500/30',
    eyebrow: 'Re-emerging',
  },
}

export function NewVoices({ voices }: { voices: NewVoice[] }) {
  if (voices.length === 0) return null
  return (
    <section className="animate-fade-up">
      <SectionHeader
        eyebrow="Inbound"
        title={
          <span className="inline-flex items-center gap-2">
            New voices in your inbox{' '}
            <span className="text-zinc-600 font-normal">({voices.length})</span>
            <HelpDot content="First inbound from someone you haven't heard from (or have never heard from). Easy to miss in a busy inbox — a thoughtful, fast acknowledgment tells them you noticed." />
          </span>
        }
        subtitle="People who just (re-)appeared in your inbound — easy to miss."
      />
      <div className="grid gap-3 aiea-stagger">
        {voices.map((voice) => (
          <VoiceCard key={voice.id} voice={voice} />
        ))}
      </div>
    </section>
  )
}

function VoiceCard({ voice }: { voice: NewVoice }) {
  const meta = KIND_META[voice.kind]
  const whenLabel =
    voice.days_ago === 0
      ? 'Today'
      : voice.days_ago === 1
        ? 'Yesterday'
        : `${voice.days_ago}d ago`
  return (
    <Link href={voice.href} className="group block">
      <Card interactive>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${meta.chip}`}
              >
                {meta.eyebrow}
              </span>
              <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                {whenLabel}
              </span>
              {voice.tier != null && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · T{voice.tier}
                </span>
              )}
              {voice.gap_days != null && (
                <span className="text-[10px] tabular-nums text-zinc-500">
                  · {voice.gap_days}d silent
                </span>
              )}
            </div>
            <p className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
              {voice.contact_name}
            </p>
            <p className="line-clamp-1 text-xs text-zinc-500">
              "{voice.subject || voice.snippet || '(no preview)'}"
            </p>
          </div>
          <span className="shrink-0 self-center text-[11px] font-medium text-violet-300 transition-colors group-hover:text-violet-200">
            Reply →
          </span>
        </div>
      </Card>
    </Link>
  )
}
