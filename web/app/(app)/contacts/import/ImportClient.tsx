'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Field =
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'company'
  | 'title'
  | 'notes'
  | 'linkedin_url'
  | 'tier'
  | 'tags'
  | 'name' // virtual: split into first/last
  | 'ignore'

type ParsedContact = {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  company: string | null
  title: string | null
  notes: string | null
  linkedin_url: string | null
  tier: number | null
  tags: string[] | null
}

type ImportResult = {
  inserted: number
  skipped: number
  errors: { row: number; error: string }[]
  error?: string
}

const FIELD_LABEL: Record<Field, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  name: 'Full name (split)',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
  title: 'Title',
  notes: 'Notes',
  linkedin_url: 'LinkedIn',
  tier: 'Tier',
  tags: 'Tags',
  ignore: 'Skip column',
}

const FIELD_ORDER: Field[] = [
  'ignore',
  'first_name',
  'last_name',
  'name',
  'email',
  'phone',
  'company',
  'title',
  'notes',
  'linkedin_url',
  'tier',
  'tags',
]

function autoMapColumn(header: string): Field {
  const h = header.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  if (!h) return 'ignore'
  if (h === 'first name' || h === 'firstname' || h === 'first' || h === 'given name') return 'first_name'
  if (h === 'last name' || h === 'lastname' || h === 'last' || h === 'surname' || h === 'family name') return 'last_name'
  if (h === 'name' || h === 'full name' || h === 'contact name' || h === 'display name') return 'name'
  if (h === 'email' || h === 'email address' || h === 'e mail' || h === 'mail' || h === 'work email' || h === 'primary email') return 'email'
  if (h === 'phone' || h === 'phone number' || h === 'mobile' || h === 'mobile phone' || h === 'cell' || h === 'cell phone' || h === 'telephone') return 'phone'
  if (h === 'company' || h === 'organization' || h === 'organisation' || h === 'org' || h === 'employer' || h === 'account') return 'company'
  if (h === 'title' || h === 'job title' || h === 'role' || h === 'position') return 'title'
  if (h === 'notes' || h === 'note' || h === 'description' || h === 'comments' || h === 'comment') return 'notes'
  if (h === 'linkedin' || h === 'linkedin url' || h === 'linkedin profile' || h === 'linkedin link') return 'linkedin_url'
  if (h === 'tier') return 'tier'
  if (h === 'tags' || h === 'labels' || h === 'tag') return 'tags'
  return 'ignore'
}

// Minimal CSV parser — handles quoted fields, escaped quotes, CRLF/LF,
// and trailing newlines. Does not split on semicolons.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }
  // flush last cell/row if not empty
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''))
}

function splitName(full: string): { first: string | null; last: string | null } {
  const trimmed = full.trim()
  if (!trimmed) return { first: null, last: null }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: null }
  return {
    first: parts.slice(0, -1).join(' '),
    last: parts[parts.length - 1],
  }
}

function rowToContact(
  row: string[],
  mapping: Field[],
): ParsedContact {
  const c: ParsedContact = {
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    company: null,
    title: null,
    notes: null,
    linkedin_url: null,
    tier: null,
    tags: null,
  }
  for (let i = 0; i < mapping.length; i++) {
    const field = mapping[i]
    const raw = (row[i] ?? '').trim()
    if (!raw || field === 'ignore') continue
    if (field === 'name') {
      const { first, last } = splitName(raw)
      if (first && !c.first_name) c.first_name = first
      if (last && !c.last_name) c.last_name = last
      continue
    }
    if (field === 'tier') {
      const n = Number(raw)
      if (Number.isFinite(n) && [1, 2, 3].includes(Math.trunc(n))) {
        c.tier = Math.trunc(n)
      }
      continue
    }
    if (field === 'tags') {
      const parts = raw
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
      c.tags = parts.length ? parts : null
      continue
    }
    ;(c as Record<Field, unknown>)[field] = raw
  }
  return c
}

function isEmpty(c: ParsedContact): boolean {
  return (
    !c.first_name &&
    !c.last_name &&
    !c.email &&
    !c.phone &&
    !c.company
  )
}

export function ImportClient() {
  const [tab, setTab] = useState<'csv' | 'manual'>('csv')
  return (
    <div>
      <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1 sm:inline-flex">
        <TabButton
          active={tab === 'csv'}
          onClick={() => setTab('csv')}
          label="CSV upload"
        />
        <TabButton
          active={tab === 'manual'}
          onClick={() => setTab('manual')}
          label="Add manually"
        />
      </div>

      <div className="mt-6">
        {tab === 'csv' ? <CsvImport /> : <ManualAdd />}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-full rounded-lg px-4 py-2 text-sm font-medium transition-all sm:w-auto ${
        active
          ? 'aiea-cta text-white'
          : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl aiea-glass p-6 sm:p-8">{children}</div>
  )
}

function CsvImport() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filename, setFilename] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Field[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [dragging, setDragging] = useState(false)

  const previewContacts = useMemo(
    () => rows.map((r) => rowToContact(r, mapping)),
    [rows, mapping],
  )

  const validCount = useMemo(
    () => previewContacts.filter((c) => !isEmpty(c)).length,
    [previewContacts],
  )
  const skipCount = previewContacts.length - validCount

  function handleFile(file: File) {
    setParseError(null)
    setResult(null)
    setHeaders([])
    setRows([])
    setMapping([])
    setFilename(file.name)
    const reader = new FileReader()
    reader.onerror = () => setParseError('Failed to read file.')
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '')
        const parsed = parseCsv(text)
        if (parsed.length === 0) {
          setParseError('CSV is empty.')
          return
        }
        const rawHeaders = parsed[0].map((h) => h.trim())
        const dataRows = parsed.slice(1)
        setHeaders(rawHeaders)
        setRows(dataRows)
        setMapping(rawHeaders.map(autoMapColumn))
      } catch (err) {
        setParseError(
          err instanceof Error
            ? `Could not parse CSV: ${err.message}`
            : 'Could not parse CSV.',
        )
      }
    }
    reader.readAsText(file)
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // allow re-selecting same file
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  function reset() {
    setFilename(null)
    setHeaders([])
    setRows([])
    setMapping([])
    setParseError(null)
    setResult(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  async function submit() {
    if (validCount === 0) return
    setSubmitting(true)
    setResult(null)
    try {
      const contacts = previewContacts.filter((c) => !isEmpty(c))
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts }),
      })
      let raw: Partial<ImportResult> = {}
      try {
        raw = (await res.json()) as Partial<ImportResult>
      } catch {
        // server returned a non-JSON body (e.g. HTML error page)
      }
      const fallbackError = !res.ok
        ? res.status === 401
          ? 'Your session expired. Refresh the page and sign in again.'
          : `Import failed (HTTP ${res.status}).`
        : undefined
      const normalized: ImportResult = {
        inserted: typeof raw.inserted === 'number' ? raw.inserted : 0,
        skipped: typeof raw.skipped === 'number' ? raw.skipped : 0,
        errors: Array.isArray(raw.errors) ? raw.errors : [],
        error: raw.error ?? fallbackError,
      }
      setResult(normalized)
      if (res.ok && normalized.inserted > 0) {
        router.refresh()
      }
    } catch (err) {
      setResult({
        inserted: 0,
        skipped: 0,
        errors: [],
        error: err instanceof Error ? err.message : 'Import failed.',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Panel>
      {!filename && !result && (
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
            dragging
              ? 'border-violet-400 bg-violet-500/5'
              : 'border-white/10 bg-white/[0.02] hover:border-violet-400/50 hover:bg-violet-500/5'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={onPick}
          />
          <div className="rounded-full bg-gradient-to-br from-indigo-500/20 via-violet-500/20 to-fuchsia-500/20 p-4 ring-1 ring-inset ring-white/10">
            <UploadGlyph />
          </div>
          <div className="mt-4 text-base font-medium text-zinc-100">
            Drop a CSV here or click to browse
          </div>
          <div className="mt-1 text-sm text-zinc-500">
            We&apos;ll auto-detect columns like Name, Email, Phone, Company.
          </div>
        </label>
      )}

      {parseError && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {parseError}
          </div>
          <button
            type="button"
            onClick={reset}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Try a different file
          </button>
        </div>
      )}

      {filename && !result && !parseError && headers.length === 0 && (
        <div className="flex items-center justify-center gap-3 rounded-xl border border-white/5 bg-zinc-950/40 px-6 py-12 text-sm text-zinc-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-violet-400" />
          Reading {filename}…
        </div>
      )}

      {filename && !result && headers.length > 0 && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-zinc-100">
                {filename}
              </div>
              <div className="text-xs text-zinc-500">
                {rows.length} row{rows.length === 1 ? '' : 's'} · {validCount}{' '}
                ready to import
                {skipCount > 0 ? ` · ${skipCount} will be skipped` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={reset}
              className="text-xs text-zinc-500 hover:text-zinc-200"
            >
              Choose a different file
            </button>
          </div>

          <div>
            <h3 className="text-sm font-medium text-zinc-200">
              Column mapping
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              Adjust how each CSV column maps onto a contact field.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {headers.map((h, i) => (
                <div
                  key={`${h}-${i}`}
                  className="flex items-center gap-3 rounded-lg border border-white/5 bg-zinc-950/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-200">
                      {h || <span className="text-zinc-500">(blank)</span>}
                    </div>
                    <div className="truncate text-[11px] text-zinc-500">
                      e.g. {(rows[0]?.[i] ?? '').trim() || '—'}
                    </div>
                  </div>
                  <select
                    value={mapping[i] ?? 'ignore'}
                    onChange={(e) => {
                      const next = [...mapping]
                      next[i] = e.target.value as Field
                      setMapping(next)
                    }}
                    className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-xs text-zinc-100 outline-none transition-colors focus:border-violet-500/50"
                  >
                    {FIELD_ORDER.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-zinc-200">Preview</h3>
            <p className="mt-1 text-xs text-zinc-500">
              First {Math.min(rows.length, 8)} of {rows.length} rows.
            </p>
            <div className="mt-3 overflow-hidden rounded-lg border border-white/5">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-white/5 text-sm">
                  <thead className="bg-zinc-900/80 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">First</th>
                      <th className="px-3 py-2 font-medium">Last</th>
                      <th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 font-medium">Phone</th>
                      <th className="px-3 py-2 font-medium">Company</th>
                      <th className="px-3 py-2 font-medium">Title</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 bg-zinc-950/40 text-zinc-300">
                    {previewContacts.slice(0, 8).map((c, i) => {
                      const empty = isEmpty(c)
                      return (
                        <tr
                          key={i}
                          className={empty ? 'opacity-40' : ''}
                          title={empty ? 'will be skipped — no name/email/phone/company' : undefined}
                        >
                          <Cell>{c.first_name}</Cell>
                          <Cell>{c.last_name}</Cell>
                          <Cell mono>{c.email}</Cell>
                          <Cell mono>{c.phone}</Cell>
                          <Cell>{c.company}</Cell>
                          <Cell>{c.title}</Cell>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/5 pt-5">
            <button
              type="button"
              onClick={reset}
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || validCount === 0}
              className="inline-flex items-center gap-2 rounded-lg aiea-cta px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting
                ? 'Importing…'
                : `Import ${validCount} contact${validCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <ResultPanel result={result} onReset={reset} />
      )}
    </Panel>
  )
}

function Cell({
  children,
  mono,
}: {
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-2 ${mono ? 'font-mono text-xs' : ''}`}
    >
      {children || <span className="text-zinc-600">—</span>}
    </td>
  )
}

function ResultPanel({
  result,
  onReset,
}: {
  result: ImportResult
  onReset: () => void
}) {
  const ok = !result.error && result.inserted > 0
  const errors = Array.isArray(result.errors) ? result.errors : []
  return (
    <div className="space-y-5">
      <div
        className={`rounded-xl px-5 py-4 ring-1 ring-inset ${
          ok
            ? 'bg-emerald-500/10 ring-emerald-400/30'
            : 'bg-rose-500/10 ring-rose-400/30'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`grid h-8 w-8 place-items-center rounded-full ${
              ok ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'
            }`}
          >
            {ok ? '✓' : '!'}
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-100">
              {ok
                ? `Imported ${result.inserted} contact${result.inserted === 1 ? '' : 's'}`
                : 'Import did not complete'}
            </div>
            <div className="text-xs text-zinc-400">
              {result.skipped > 0 &&
                `${result.skipped} row${result.skipped === 1 ? '' : 's'} skipped. `}
              {result.error && <span>{result.error}</span>}
            </div>
          </div>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-xl border border-white/5 bg-zinc-950/40 p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Skipped rows
          </div>
          <ul className="mt-2 space-y-1 text-sm text-zinc-300">
            {errors.slice(0, 20).map((e, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span className="text-zinc-500">Row {e.row}</span>
                <span className="text-right text-zinc-300">{e.error}</span>
              </li>
            ))}
            {errors.length > 20 && (
              <li className="text-xs text-zinc-500">
                and {errors.length - 20} more…
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-violet-400/50 hover:text-white"
        >
          Import another file
        </button>
      </div>
    </div>
  )
}

function ManualAdd() {
  const router = useRouter()
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    company: '',
    title: '',
    notes: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSubmit =
    !!form.first_name.trim() ||
    !!form.last_name.trim() ||
    !!form.email.trim() ||
    !!form.phone.trim() ||
    !!form.company.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    setSuccess(false)
    try {
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contacts: [
            {
              first_name: form.first_name.trim() || null,
              last_name: form.last_name.trim() || null,
              email: form.email.trim() || null,
              phone: form.phone.trim() || null,
              company: form.company.trim() || null,
              title: form.title.trim() || null,
              notes: form.notes.trim() || null,
            },
          ],
        }),
      })
      let data: Partial<ImportResult> = {}
      try {
        data = (await res.json()) as Partial<ImportResult>
      } catch {
        // non-JSON response
      }
      if (!res.ok || (data.inserted ?? 0) === 0) {
        const fallback =
          res.status === 401
            ? 'Your session expired. Refresh the page and sign in again.'
            : !res.ok
              ? `Could not save contact (HTTP ${res.status}).`
              : 'Could not save contact.'
        setError(data.error || fallback)
        return
      }
      setSuccess(true)
      setForm({
        first_name: '',
        last_name: '',
        email: '',
        phone: '',
        company: '',
        title: '',
        notes: '',
      })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="First name"
            value={form.first_name}
            onChange={(v) => setForm({ ...form, first_name: v })}
            autoFocus
          />
          <Input
            label="Last name"
            value={form.last_name}
            onChange={(v) => setForm({ ...form, last_name: v })}
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(v) => setForm({ ...form, email: v })}
          />
          <Input
            label="Phone"
            type="tel"
            value={form.phone}
            onChange={(v) => setForm({ ...form, phone: v })}
          />
          <Input
            label="Company"
            value={form.company}
            onChange={(v) => setForm({ ...form, company: v })}
          />
          <Input
            label="Title"
            value={form.title}
            onChange={(v) => setForm({ ...form, title: v })}
          />
        </div>

        <div>
          <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
            Notes
          </label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
            className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/50"
            placeholder="How you met, what they care about, anything you want to remember…"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            Contact saved. Add another, or head back to the dashboard.
          </div>
        )}

        <div className="flex justify-end border-t border-white/5 pt-5">
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-2 rounded-lg aiea-cta px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Saving…' : 'Save contact'}
          </button>
        </div>
      </form>
    </Panel>
  )
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
  autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        className="mt-1.5 w-full rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-colors focus:border-violet-500/50"
      />
    </label>
  )
}

function UploadGlyph() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-violet-200"
    >
      <path d="M12 16V4" />
      <path d="m6 10 6-6 6 6" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}
