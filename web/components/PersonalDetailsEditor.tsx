'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '../lib/supabase/client'
import type { PersonalDetails } from '../lib/types'

type Props = {
  contactId: string
  initial: PersonalDetails | null
}

type CareerEntry = { role: string; company: string; years?: string | null }
type LifeEvent = { date?: string | null; event: string }

export function PersonalDetailsEditor({ contactId, initial }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  const init = initial ?? {}

  // About
  const [interests, setInterests] = useState<string[]>(init.interests ?? [])
  const [hobbies, setHobbies] = useState<string[]>(init.hobbies ?? [])
  const [notes, setNotes] = useState(init.notes ?? '')

  // Family
  const [spouse, setSpouse] = useState(init.spouse ?? '')
  const [kids, setKids] = useState<string[]>(init.kids ?? [])
  const [familyNotes, setFamilyNotes] = useState(init.family_notes ?? '')

  // Career
  const [career, setCareer] = useState<CareerEntry[]>(
    init.career_history?.map((c) => ({ ...c })) ?? [],
  )

  // Life events
  const [lifeEvents, setLifeEvents] = useState<LifeEvent[]>(
    init.life_events?.map((e) => ({ ...e })) ?? [],
  )

  // Preferences
  const [birthday, setBirthday] = useState(init.birthday ?? '')
  const [communicationStyle, setCommunicationStyle] = useState(
    init.communication_style ?? '',
  )

  function save() {
    const trimmedCareer = career.filter(
      (c) => c.role.trim() || c.company.trim(),
    )
    const trimmedEvents = lifeEvents.filter((e) => e.event.trim())

    // Re-fetch the current row inside the save transaction so the AIEA Layer 1
    // pipeline (relationship-merge, social-update, intelligence) doesn't lose
    // its writes if the form was open for a while. We only overwrite the
    // editor-owned keys; everything else (linkedin_url, emotional_trajectory,
    // topics_of_interest, etc.) is read fresh and preserved.
    start(async () => {
      setErr(null)
      const supabase = createClient()
      const { data: fresh, error: fetchErr } = await supabase
        .from('contacts')
        .select('personal_details')
        .eq('id', contactId)
        .maybeSingle()
      if (fetchErr) {
        console.error('[personal-details] refetch failed', fetchErr)
        setErr("Couldn't load latest details. Try again.")
        return
      }
      const current = (fresh?.personal_details ?? {}) as PersonalDetails
      const payload: PersonalDetails = {
        ...current,
        spouse: spouse.trim() || null,
        kids: kids.length > 0 ? kids : null,
        family_notes: familyNotes.trim() || null,
        interests: interests.length > 0 ? interests : null,
        hobbies: hobbies.length > 0 ? hobbies : null,
        career_history: trimmedCareer.length > 0 ? trimmedCareer : null,
        life_events: trimmedEvents.length > 0 ? trimmedEvents : null,
        notes: notes.trim() || null,
        birthday: birthday.trim() || null,
        communication_style: communicationStyle.trim() || null,
      }
      const { error } = await supabase
        .from('contacts')
        .update({ personal_details: payload })
        .eq('id', contactId)
      if (error) {
        console.error('[personal-details] save failed', error)
        setErr("Couldn't save. Try again or check your connection.")
        return
      }
      setEditing(false)
      router.refresh()
    })
  }

  if (!editing) return <ReadView details={init} onEdit={() => setEditing(true)} />

  return (
    <div className="space-y-6 text-sm">
      <Section label="About">
        <TagInput
          label="Interests"
          values={interests}
          onChange={setInterests}
          placeholder="Add an interest…"
        />
        <TagInput
          label="Hobbies"
          values={hobbies}
          onChange={setHobbies}
          placeholder="Add a hobby…"
        />
        <TextArea label="Notes" value={notes} onChange={setNotes} />
      </Section>

      <Section label="Family">
        <Field label="Spouse / partner" value={spouse} onChange={setSpouse} />
        <TagInput
          label="Kids"
          values={kids}
          onChange={setKids}
          placeholder="Add a kid's name…"
        />
        <TextArea
          label="Family notes"
          value={familyNotes}
          onChange={setFamilyNotes}
        />
      </Section>

      <Section label="Career">
        <CareerList entries={career} onChange={setCareer} />
      </Section>

      <Section label="Life events">
        <LifeEventList events={lifeEvents} onChange={setLifeEvents} />
      </Section>

      <Section label="Preferences">
        <Field
          label="Birthday"
          value={birthday}
          onChange={setBirthday}
          type="date"
        />
        <Field
          label="Communication style"
          value={communicationStyle}
          onChange={setCommunicationStyle}
          hint="e.g. prefers async, direct, formal"
        />
      </Section>

      {err && <p className="text-xs text-rose-300">{err}</p>}

      <div className="flex gap-2 pt-2">
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

function ReadView({
  details,
  onEdit,
}: {
  details: PersonalDetails
  onEdit: () => void
}) {
  const sections = [
    {
      label: 'About',
      rows: [
        details.interests?.length
          ? { k: 'Interests', v: details.interests.join(', ') }
          : null,
        details.hobbies?.length
          ? { k: 'Hobbies', v: details.hobbies.join(', ') }
          : null,
        details.notes ? { k: 'Notes', v: details.notes } : null,
      ].filter((r): r is { k: string; v: string } => r !== null),
    },
    {
      label: 'Family',
      rows: [
        details.spouse ? { k: 'Spouse', v: details.spouse } : null,
        details.kids?.length ? { k: 'Kids', v: details.kids.join(', ') } : null,
        details.family_notes ? { k: 'Notes', v: details.family_notes } : null,
      ].filter((r): r is { k: string; v: string } => r !== null),
    },
    {
      label: 'Career',
      rows:
        details.career_history?.map((c) => ({
          k: c.company || c.role,
          v: [c.role, c.company, c.years].filter(Boolean).join(' · '),
        })) ?? [],
    },
    {
      label: 'Life events',
      rows:
        details.life_events?.map((e) => ({
          k: e.date ?? '—',
          v: e.event,
        })) ?? [],
    },
    {
      label: 'Preferences',
      rows: [
        details.birthday ? { k: 'Birthday', v: details.birthday } : null,
        details.communication_style
          ? { k: 'Comms', v: details.communication_style }
          : null,
      ].filter((r): r is { k: string; v: string } => r !== null),
    },
  ]

  const hasAny = sections.some((s) => s.rows.length > 0)

  if (!hasAny) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-zinc-500">
          No personal details yet. Adding family, hobbies, and life events
          sharpens every meeting brief.
        </p>
        <button
          onClick={onEdit}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-violet-500/50 hover:text-white"
        >
          Add details
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5 text-sm">
      {sections.map(
        (s) =>
          s.rows.length > 0 && (
            <div key={s.label}>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
                {s.label}
              </div>
              <dl className="space-y-1.5">
                {s.rows.map((r, i) => (
                  <div key={i} className="flex gap-3">
                    <dt className="w-24 shrink-0 truncate text-xs text-zinc-500">
                      {r.k}
                    </dt>
                    <dd className="text-zinc-200">{r.v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ),
      )}
      <button
        onClick={onEdit}
        className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-violet-500/50 hover:text-white"
      >
        Edit details
      </button>
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <legend className="px-2 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </legend>
      {children}
    </fieldset>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  type?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {label}
        {hint && <span className="ml-2 normal-case text-zinc-600">{hint}</span>}
      </span>
      <input
        type={type}
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
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
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

function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  function commit() {
    const v = draft.trim()
    if (!v || values.includes(v)) {
      setDraft('')
      return
    }
    onChange([...values, v])
    setDraft('')
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-200 ring-1 ring-inset ring-white/[0.08]"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="text-zinc-500 transition-colors hover:text-rose-300"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!draft.trim()}
          className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-violet-500/50 hover:text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function CareerList({
  entries,
  onChange,
}: {
  entries: CareerEntry[]
  onChange: (v: CareerEntry[]) => void
}) {
  function update(i: number, patch: Partial<CareerEntry>) {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)))
  }
  function remove(i: number) {
    onChange(entries.filter((_, idx) => idx !== i))
  }
  function add() {
    onChange([...entries, { role: '', company: '', years: '' }])
  }

  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <p className="text-xs text-zinc-500">No career history yet.</p>
      )}
      {entries.map((e, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px_auto]"
        >
          <input
            value={e.role}
            onChange={(ev) => update(i, { role: ev.target.value })}
            placeholder="Role"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
          />
          <input
            value={e.company}
            onChange={(ev) => update(i, { company: ev.target.value })}
            placeholder="Company"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
          />
          <input
            value={e.years ?? ''}
            onChange={(ev) => update(i, { years: ev.target.value })}
            placeholder="Years"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-rose-500/40 hover:text-rose-300"
            aria-label="Remove role"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-violet-500/50 hover:text-white"
      >
        + Add role
      </button>
    </div>
  )
}

function LifeEventList({
  events,
  onChange,
}: {
  events: LifeEvent[]
  onChange: (v: LifeEvent[]) => void
}) {
  function update(i: number, patch: Partial<LifeEvent>) {
    onChange(events.map((e, idx) => (idx === i ? { ...e, ...patch } : e)))
  }
  function remove(i: number) {
    onChange(events.filter((_, idx) => idx !== i))
  }
  function add() {
    onChange([...events, { date: '', event: '' }])
  }

  return (
    <div className="space-y-2">
      {events.length === 0 && (
        <p className="text-xs text-zinc-500">No life events recorded.</p>
      )}
      {events.map((e, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_1fr_auto]"
        >
          <input
            type="date"
            value={e.date ?? ''}
            onChange={(ev) => update(i, { date: ev.target.value })}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
          />
          <input
            value={e.event}
            onChange={(ev) => update(i, { event: ev.target.value })}
            placeholder="What happened"
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-violet-500/50"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-rose-500/40 hover:text-rose-300"
            aria-label="Remove event"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-violet-500/50 hover:text-white"
      >
        + Add event
      </button>
    </div>
  )
}
