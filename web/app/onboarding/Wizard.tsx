'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Brand } from '../../components/Brand'

type Step = 0 | 1 | 2 | 3
type Tier = 1 | 2 | 3

const PLACEHOLDER_PRIORITIES = [
  'Sarah Chen',
  'David Park',
  'Maya Rodriguez',
  'James Whitfield',
  'Priya Anand',
  'Marcus Bell',
  'Anna Kowalski',
  'Daniel Voss',
  'Elena Marchetti',
  'Theo Nakamura',
]

const STEPS = ['Welcome', 'Contacts', 'Priorities', 'Ready'] as const

export function Wizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(0)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [contactsConnected, setContactsConnected] = useState(false)
  const [tiers, setTiers] = useState<Record<string, Tier>>({})
  const [submitting, setSubmitting] = useState(false)
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const goNext = () => {
    setDirection(1)
    setStep((s) => Math.min(3, s + 1) as Step)
  }
  const goBack = () => {
    setDirection(-1)
    setStep((s) => Math.max(0, s - 1) as Step)
  }

  async function finish() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contactsConnected,
          priorities: tiers,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Something went wrong')
      }
      startTransition(() => {
        router.replace('/')
        router.refresh()
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 pt-8 sm:px-12">
        <div className="text-zinc-100">
          <Brand />
        </div>
        <StepDots current={step} />
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-12">
        <div className="relative w-full max-w-2xl">
          <Screen visible={step === 0} direction={direction}>
            <WelcomeScreen onNext={goNext} />
          </Screen>
          <Screen visible={step === 1} direction={direction}>
            <ContactsScreen
              connected={contactsConnected}
              onConnect={() => setContactsConnected(true)}
              onNext={goNext}
              onBack={goBack}
            />
          </Screen>
          <Screen visible={step === 2} direction={direction}>
            <PrioritiesScreen
              tiers={tiers}
              setTiers={setTiers}
              onNext={goNext}
              onBack={goBack}
            />
          </Screen>
          <Screen visible={step === 3} direction={direction}>
            <ReadyScreen
              onBack={goBack}
              onFinish={finish}
              submitting={submitting}
              error={error}
            />
          </Screen>
        </div>
      </main>

      <footer className="px-6 pb-8 text-center text-xs text-zinc-600 sm:px-12">
        {STEPS[step]} · Step {step + 1} of {STEPS.length}
      </footer>
    </div>
  )
}

function StepDots({ current }: { current: Step }) {
  return (
    <div className="flex items-center gap-1.5">
      {STEPS.map((_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all duration-500 ${
            i === current
              ? 'w-8 bg-indigo-400'
              : i < current
                ? 'w-1.5 bg-indigo-400/60'
                : 'w-1.5 bg-zinc-700'
          }`}
        />
      ))}
    </div>
  )
}

function Screen({
  visible,
  direction,
  children,
}: {
  visible: boolean
  direction: 1 | -1
  children: React.ReactNode
}) {
  return (
    <div
      aria-hidden={!visible}
      className={`transition-all duration-500 ease-out ${
        visible
          ? 'pointer-events-auto relative translate-x-0 opacity-100'
          : `pointer-events-none absolute inset-0 opacity-0 ${
              direction === 1 ? '-translate-x-6' : 'translate-x-6'
            }`
      }`}
    >
      {children}
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────
   Screen 1 — Welcome
   ─────────────────────────────────────────────────────────────────────── */

function WelcomeScreen({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <div className="mb-8 flex justify-center">
        <div className="relative">
          <div className="absolute inset-0 animate-pulse rounded-full bg-indigo-500/30 blur-2xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/20 to-violet-500/10 shadow-[0_0_60px_-15px_rgba(99,102,241,0.6)]">
            <SparkleIcon className="h-9 w-9 text-indigo-300" />
          </div>
        </div>
      </div>

      <h1 className="text-balance text-4xl font-medium tracking-tight text-white sm:text-5xl">
        Welcome to{' '}
        <span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
          Relationship Intelligence
        </span>
      </h1>

      <p className="mx-auto mt-5 max-w-lg text-balance text-base leading-relaxed text-zinc-400 sm:text-lg">
        Jarvis monitors your relationships, tracks commitments, and tells you
        who needs attention — before it&rsquo;s too late.
      </p>

      <div className="mt-10 flex flex-col items-center gap-3">
        <PrimaryButton onClick={onNext}>
          Get started
          <ArrowRight className="ml-2 h-4 w-4" />
        </PrimaryButton>
        <p className="text-xs text-zinc-600">Takes about 90 seconds.</p>
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────
   Screen 2 — Connect contacts
   ─────────────────────────────────────────────────────────────────────── */

function ContactsScreen({
  connected,
  onConnect,
  onNext,
  onBack,
}: {
  connected: boolean
  onConnect: () => void
  onNext: () => void
  onBack: () => void
}) {
  return (
    <div className="text-center">
      <h2 className="text-balance text-3xl font-medium tracking-tight text-white sm:text-4xl">
        Connect your contacts
      </h2>
      <p className="mx-auto mt-4 max-w-md text-balance text-zinc-400">
        Jarvis builds a private graph of who you talk to, when, and how warm
        the relationship is. Nothing leaves your account.
      </p>

      <div className="mt-10">
        <ContactGraph active={connected} />
      </div>

      <div className="mt-10 flex flex-col items-center gap-3">
        {connected ? (
          <>
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckIcon className="h-4 w-4" />
              Ready to sync
            </div>
            <PrimaryButton onClick={onNext}>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" />
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton onClick={onConnect}>
            <LinkIcon className="mr-2 h-4 w-4" />
            Connect contacts
          </PrimaryButton>
        )}
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Back
        </button>
      </div>
    </div>
  )
}

function ContactGraph({ active }: { active: boolean }) {
  const nodes = useMemo(
    () => [
      { x: 50, y: 50, r: 14, label: 'You', main: true },
      { x: 14, y: 22, r: 8 },
      { x: 86, y: 22, r: 9 },
      { x: 18, y: 78, r: 7 },
      { x: 84, y: 78, r: 10 },
      { x: 50, y: 12, r: 7 },
      { x: 50, y: 88, r: 8 },
      { x: 28, y: 50, r: 6 },
      { x: 72, y: 50, r: 6 },
    ],
    [],
  )

  return (
    <div className="relative mx-auto h-64 w-full max-w-md">
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="nodeGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a5b4fc" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* edges */}
        {nodes.slice(1).map((n, i) => (
          <line
            key={`edge-${i}`}
            x1={50}
            y1={50}
            x2={n.x}
            y2={n.y}
            stroke={active ? '#6366f1' : '#3f3f46'}
            strokeWidth={0.3}
            strokeOpacity={active ? 0.6 : 0.4}
            className="transition-all duration-700"
            style={{
              strokeDasharray: 100,
              strokeDashoffset: active ? 0 : 100,
              transitionDelay: `${i * 60}ms`,
            }}
          />
        ))}

        {/* nodes */}
        {nodes.map((n, i) => (
          <g
            key={`node-${i}`}
            className="transition-all duration-700"
            style={{
              opacity: active ? 1 : n.main ? 1 : 0.3,
              transitionDelay: `${i * 80}ms`,
            }}
          >
            {n.main && (
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r * 1.6}
                fill="url(#nodeGlow)"
                className="origin-center animate-pulse"
              />
            )}
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r / 2}
              fill={n.main ? '#a5b4fc' : active ? '#818cf8' : '#52525b'}
              stroke={n.main ? '#c7d2fe' : 'none'}
              strokeWidth={n.main ? 0.4 : 0}
              className="transition-colors duration-700"
            />
          </g>
        ))}
      </svg>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────
   Screen 3 — Priorities
   ─────────────────────────────────────────────────────────────────────── */

const TIER_COPY: Record<Tier, { name: string; desc: string; color: string }> = {
  1: {
    name: 'Tier 1',
    desc: 'Inner circle',
    color: 'from-indigo-500 to-violet-500',
  },
  2: {
    name: 'Tier 2',
    desc: 'Important',
    color: 'from-sky-500 to-indigo-500',
  },
  3: {
    name: 'Tier 3',
    desc: 'Maintain',
    color: 'from-zinc-500 to-zinc-600',
  },
}

function PrioritiesScreen({
  tiers,
  setTiers,
  onNext,
  onBack,
}: {
  tiers: Record<string, Tier>
  setTiers: (next: Record<string, Tier>) => void
  onNext: () => void
  onBack: () => void
}) {
  function setTier(name: string, tier: Tier | null) {
    if (tier == null) {
      const next = { ...tiers }
      delete next[name]
      setTiers(next)
    } else {
      setTiers({ ...tiers, [name]: tier })
    }
  }

  const selectedCount = Object.keys(tiers).length

  return (
    <div>
      <div className="text-center">
        <h2 className="text-balance text-3xl font-medium tracking-tight text-white sm:text-4xl">
          Set your priorities
        </h2>
        <p className="mx-auto mt-4 max-w-md text-balance text-zinc-400">
          Pick 5–10 people who matter most. Jarvis nudges harder when these
          relationships go cold.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        {(Object.keys(TIER_COPY) as unknown as Tier[]).map((t) => (
          <div
            key={t}
            className="rounded-xl border border-white/5 bg-white/[0.03] p-3 text-center"
          >
            <div
              className={`mx-auto mb-2 h-2 w-8 rounded-full bg-gradient-to-r ${TIER_COPY[t].color}`}
            />
            <div className="text-xs font-medium text-white">
              {TIER_COPY[t].name}
            </div>
            <div className="text-xs text-zinc-500">{TIER_COPY[t].desc}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 max-h-[340px] overflow-y-auto rounded-xl border border-white/5 bg-white/[0.02]">
        {PLACEHOLDER_PRIORITIES.map((name, i) => {
          const current = tiers[name]
          return (
            <div
              key={name}
              className={`flex items-center justify-between border-white/5 px-4 py-3 ${
                i !== PLACEHOLDER_PRIORITIES.length - 1 ? 'border-b' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <Avatar name={name} active={!!current} />
                <div className="text-sm font-medium text-zinc-100">{name}</div>
              </div>
              <div className="flex items-center gap-1">
                {([1, 2, 3] as Tier[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTier(name, current === t ? null : t)}
                    className={`h-7 w-9 rounded-md text-xs font-medium transition-all ${
                      current === t
                        ? `bg-gradient-to-r ${TIER_COPY[t].color} text-white shadow-lg shadow-indigo-500/20`
                        : 'border border-white/5 bg-white/[0.02] text-zinc-500 hover:border-white/20 hover:text-zinc-200'
                    }`}
                  >
                    T{t}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Back
        </button>
        <div className="text-xs text-zinc-500">
          <span className={selectedCount > 0 ? 'text-zinc-200' : ''}>
            {selectedCount}
          </span>{' '}
          assigned
        </div>
        <PrimaryButton onClick={onNext} disabled={selectedCount === 0}>
          Continue
          <ArrowRight className="ml-2 h-4 w-4" />
        </PrimaryButton>
      </div>
    </div>
  )
}

function Avatar({ name, active }: { name: string; active: boolean }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
  return (
    <div
      className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
        active
          ? 'bg-gradient-to-br from-indigo-500/40 to-violet-500/30 text-white ring-1 ring-indigo-300/40'
          : 'bg-white/5 text-zinc-400 ring-1 ring-white/5'
      }`}
    >
      {initials}
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────
   Screen 4 — Ready
   ─────────────────────────────────────────────────────────────────────── */

function ReadyScreen({
  onBack,
  onFinish,
  submitting,
  error,
}: {
  onBack: () => void
  onFinish: () => void
  submitting: boolean
  error: string | null
}) {
  const [animateIn, setAnimateIn] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setAnimateIn(true), 60)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="text-center">
      <div className="mb-8 flex justify-center">
        <div className="relative">
          <div className="absolute inset-0 animate-pulse rounded-full bg-emerald-500/30 blur-2xl" />
          <div
            className={`relative flex h-20 w-20 items-center justify-center rounded-full border border-emerald-400/20 bg-gradient-to-br from-emerald-500/30 to-emerald-700/10 shadow-[0_0_60px_-15px_rgba(16,185,129,0.7)] transition-all duration-700 ${
              animateIn ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
            }`}
          >
            <CheckIcon className="h-9 w-9 text-emerald-300" />
          </div>
        </div>
      </div>

      <h2 className="text-balance text-4xl font-medium tracking-tight text-white sm:text-5xl">
        You&rsquo;re all set
      </h2>
      <p className="mx-auto mt-4 max-w-md text-balance text-zinc-400">
        Here&rsquo;s what Jarvis will start doing for you tomorrow.
      </p>

      <div className="mx-auto mt-10 grid max-w-lg gap-3 sm:grid-cols-3">
        <FeaturePill
          icon={<SunriseIcon />}
          title="Morning brief"
          desc="Who needs you today"
        />
        <FeaturePill
          icon={<BellIcon />}
          title="Smart nudges"
          desc="Before it goes cold"
        />
        <FeaturePill
          icon={<ListIcon />}
          title="Commitments"
          desc="Nothing slips"
        />
      </div>

      {error && (
        <div className="mx-auto mt-6 max-w-md rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="mt-10 flex flex-col items-center gap-3">
        <PrimaryButton onClick={onFinish} disabled={submitting}>
          {submitting ? 'Setting up…' : 'Go to dashboard'}
          {!submitting && <ArrowRight className="ml-2 h-4 w-4" />}
        </PrimaryButton>
        {!submitting && (
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Back
          </button>
        )}
      </div>
    </div>
  )
}

function FeaturePill({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode
  title: string
  desc: string
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/10">
      <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-300">
        {icon}
      </div>
      <div className="text-sm font-medium text-white">{title}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{desc}</div>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────────────────
   Primitives
   ─────────────────────────────────────────────────────────────────────── */

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group relative inline-flex items-center justify-center overflow-hidden rounded-full bg-white px-6 py-3 text-sm font-medium text-zinc-900 shadow-[0_0_30px_-5px_rgba(255,255,255,0.4)] transition-all duration-200 hover:shadow-[0_0_40px_-5px_rgba(255,255,255,0.6)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
    >
      <span className="absolute inset-0 -z-10 bg-gradient-to-r from-white via-zinc-100 to-white opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      {children}
    </button>
  )
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3l1.9 5.5L19.5 10l-5.6 1.5L12 17l-1.9-5.5L4.5 10l5.6-1.5z" />
      <path d="M19 4l.7 2L21.5 7l-1.8.5L19 9l-.7-1.5L16.5 7l1.8-1z" />
    </svg>
  )
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
    </svg>
  )
}

function SunriseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 18a5 5 0 0 0-10 0" />
      <line x1="12" y1="2" x2="12" y2="9" />
      <line x1="4.22" y1="10.22" x2="5.64" y2="11.64" />
      <line x1="1" y1="18" x2="3" y2="18" />
      <line x1="21" y1="18" x2="23" y2="18" />
      <line x1="18.36" y1="11.64" x2="19.78" y2="10.22" />
      <line x1="23" y1="22" x2="1" y2="22" />
      <polyline points="8 6 12 2 16 6" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}
