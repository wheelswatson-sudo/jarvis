import type { PipelineStage } from './types'

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

export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '—'
  const digits = raw.replace(/\D/g, '')
  // US numbers: +1XXXXXXXXXX or 1XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  // International: just add spaces for readability
  return raw
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
  if (t === 1)
    return 'bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/15 text-violet-200 ring-1 ring-inset ring-violet-500/30'
  if (t === 2)
    return 'bg-white/[0.06] text-zinc-200 ring-1 ring-inset ring-white/10'
  if (t === 3) return 'bg-white/[0.03] text-zinc-400 ring-1 ring-inset ring-white/[0.06]'
  return 'bg-white/[0.02] text-zinc-500 ring-1 ring-inset ring-white/[0.05]'
}

export function healthColor(score: number | null | undefined): string {
  if (score == null) return 'text-zinc-400'
  if (score >= 0.7) return 'text-emerald-300'
  if (score >= 0.4) return 'text-amber-300'
  return 'text-rose-300'
}

const PIPELINE_TONE: Record<PipelineStage, string> = {
  lead: 'bg-indigo-500/10 text-indigo-200 ring-1 ring-inset ring-indigo-500/30',
  warm: 'bg-violet-500/10 text-violet-200 ring-1 ring-inset ring-violet-500/30',
  active:
    'bg-fuchsia-500/15 text-fuchsia-100 ring-1 ring-inset ring-fuchsia-500/35',
  committed:
    'bg-gradient-to-br from-fuchsia-500/20 to-rose-500/15 text-rose-100 ring-1 ring-inset ring-fuchsia-400/40',
  closed: 'bg-emerald-500/10 text-emerald-200 ring-1 ring-inset ring-emerald-500/30',
  dormant: 'bg-white/[0.03] text-zinc-400 ring-1 ring-inset ring-white/[0.06]',
}

export function pipelineStageColor(s: PipelineStage | null | undefined): string {
  if (!s) return 'bg-white/[0.02] text-zinc-500 ring-1 ring-inset ring-white/[0.05]'
  return PIPELINE_TONE[s]
}

export function pipelineStageDot(s: PipelineStage | null | undefined): string {
  switch (s) {
    case 'lead':
      return 'bg-indigo-400 shadow-indigo-500/50'
    case 'warm':
      return 'bg-violet-400 shadow-violet-500/50'
    case 'active':
      return 'bg-fuchsia-400 shadow-fuchsia-500/50'
    case 'committed':
      return 'bg-rose-400 shadow-rose-500/50'
    case 'closed':
      return 'bg-emerald-400 shadow-emerald-500/50'
    case 'dormant':
      return 'bg-zinc-500 shadow-zinc-500/30'
    default:
      return 'bg-zinc-700'
  }
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
