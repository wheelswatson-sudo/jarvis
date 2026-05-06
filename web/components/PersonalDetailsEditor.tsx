'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import type { PersonalDetails } from '../lib/types'

type Props = {
  contactId: string
  initial: PersonalDetails | null
}

function arrToText(arr: string[] | null | undefined): string {
  return arr && arr.length > 0 ? arr.join(', ') : ''
}
function textToArr(s: string): string[] | null {
  const out = s
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
  return out.length > 0 ? out : null
}

export function PersonalDetailsEditor({ contactId, initial }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const init = initial ?? {}
  const [spouse, setSpouse] = useState(init.spouse ?? '')
  const [kids, setKids] = useState(arrToText(init.kids))
  const [familyNotes, setFamilyNotes] = useState(init.family_notes ?? '')
  const [interests, setInterests] = useState(arrToText(init.interests))
  const [hobbies, setHobbies] = useState(arrToText(init.hobbies))
  const [career, setCareer] = useState(
    init.career_history
      ? init.career_history.map((c) => `${c.role} @ ${c.company}`).join('\n')
      : '',
  )
  const [lifeEvents, setLifeEvents] = useState(
    init.life_events ? init.life_events.map((e) => e.event).join('\n') : '',
  )
  const [notes, setNotes] = useState(init.notes ?? '')

  function save() {
    const careerHistory = career
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [role, company] = line.split('@').map((s) => s.trim())
        return { role: role || line, company: company || '' }
      })
    const events = lifeEvents
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((event) => ({ event }))

    const payload: PersonalDetails = {
      spouse: spouse.trim() || null,
      kids: textToArr(kids),
      family_notes: familyNotes.trim() || null,
      interests: textToArr(interests),
      hobbies: textToArr(hobbies),
      career_history: careerHistory.length > 0 ? careerHistory : null,
      life_events: events.length > 0 ? events : null,
      notes: notes.trim() || null,
    }
    start(async () => {
      setErr(null)
      const supabase = createClient()
      const { error } = await supabase
        .from('contacts')
        .update({ personal_details: payload })
        .eq('id', contactId)
      if (error) {
        setErr(error.message)
        return
      }
      setEditing(false)
      router.refresh()
    })
  }

  if (!editing) {
    const hasAny =
      init.spouse ||
      (init.kids && init.kids.length > 0) ||
      init.family_notes ||
      (init.interests && init.interests.length > 0) ||
      (init.hobbies && init.hobbies.length > 0) ||
      (init.career_history && init.career_history.length > 0) ||
      (init.life_events && init.life_events.length > 0) ||
      init.notes

    return (
      <div className="space-y-4 text-sm">
        {!hasAny ? (
          <p className="text-zinc-500">
            No personal details yet. Adding family, hobbies, and life events
            sharpens every meeting brief.
          </p>
        ) : (
          <dl className="space-y-3">
            {init.spouse && <Row label="Spouse" value={init.spouse} />}
            {init.kids && init.kids.length > 0 && (
              <Row label="Kids" value={init.kids.join(', ')} />
            )}
            {init.family_notes && (
              <Row label="Family" value={init.family_notes} />
            )}
            {init.interests && init.interests.length > 0 && (
              <Row label="Interests" value={init.interests.join(', ')} />
            )}
            {init.hobbies && init.hobbies.length > 0 && (
              <Row label="Hobbies" value={init.hobbies.join(', ')} />
            )}
            {init.career_history && init.career_history.length > 0 && (
              <Row
                label="Career"
                value={init.career_history
                  .map((c) => `${c.role} @ ${c.company}`)
                  .join(' · ')}
              />
            )}
            {init.life_events && init.life_events.length > 0 && (
              <Row
                label="Life events"
                value={init.life_events.map((e) => e.event).join(' · ')}
              />
            )}
            {init.notes && <Row label="Notes" value={init.notes} />}
          </dl>
        )}
        <button
          onClick={() => setEditing(true)}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-violet-500/50 hover:text-white"
        >
          {hasAny ? 'Edit details' : 'Add details'}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3 text-sm">
      <Field label="Spouse" value={spouse} onChange={setSpouse} />
      <Field
        label="Kids (comma-separated)"
        value={kids}
        onChange={setKids}
      />
      <Field
        label="Family notes"
        value={familyNotes}
        onChange={setFamilyNotes}
      />
      <Field
        label="Interests"
        value={interests}
        onChange={setInterests}
        hint="comma-separated"
      />
      <Field
        label="Hobbies"
        value={hobbies}
        onChange={setHobbies}
        hint="comma-separated"
      />
      <TextArea
        label="Career history"
        value={career}
        onChange={setCareer}
        hint="one per line — “Role @ Company”"
      />
      <TextArea
        label="Life events"
        value={lifeEvents}
        onChange={setLifeEvents}
        hint="one per line"
      />
      <TextArea label="Notes" value={notes} onChange={setNotes} />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={pending}
          className="rounded-lg aiea-cta px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => setEditing(false)}
          disabled={pending}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-xs text-zinc-300 transition-colors hover:border-white/[0.18]"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="text-zinc-200">{value}</dd>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        {label}
        {hint && <span className="ml-2 normal-case text-zinc-600">{hint}</span>}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
      />
    </label>
  )
}

function TextArea({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        {label}
        {hint && <span className="ml-2 normal-case text-zinc-600">{hint}</span>}
      </span>
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
      />
    </label>
  )
}
