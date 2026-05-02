export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const sec = Math.round(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatCurrency(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${Math.round(n).toLocaleString()}`
}

export function formatPercent(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n * 100)}%`
}

export function tierLabel(t: number | null | undefined): string {
  if (t === 1) return 'T1'
  if (t === 2) return 'T2'
  if (t === 3) return 'T3'
  return '—'
}

export function tierColor(t: number | null | undefined): string {
  if (t === 1) return 'bg-zinc-900 text-white'
  if (t === 2) return 'bg-zinc-200 text-zinc-700'
  if (t === 3) return 'bg-zinc-100 text-zinc-500'
  return 'bg-zinc-100 text-zinc-400'
}

export function healthColor(score: number | null | undefined): string {
  if (score == null) return 'text-zinc-400'
  if (score >= 0.7) return 'text-emerald-600'
  if (score >= 0.4) return 'text-amber-600'
  return 'text-red-600'
}

export function contactName(
  c: {
    first_name?: string | null
    last_name?: string | null
    email?: string | null
  } | null | undefined,
): string {
  if (!c) return 'Unknown'
  const composed = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
  if (composed) return composed
  if (c.email) return c.email
  return 'Unknown'
}
