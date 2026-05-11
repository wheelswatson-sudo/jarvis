// Dev-only preview for OutboundVelocity.
import { notFound } from 'next/navigation'
import { OutboundVelocity } from '../../../components/OutboundVelocity'
import type { OutboundVelocity as VelocityData } from '../../../lib/intelligence/outbound-velocity'

const SPIKING: VelocityData = {
  this_week_count: 32,
  baseline_avg_per_week: 18,
  ratio: 1.78,
  direction: 'spiking',
}
const STEADY: VelocityData = {
  this_week_count: 17,
  baseline_avg_per_week: 18.5,
  ratio: 0.92,
  direction: 'steady',
}
const SLOWING: VelocityData = {
  this_week_count: 6,
  baseline_avg_per_week: 18,
  ratio: 0.33,
  direction: 'slowing',
}
const NO_BASELINE: VelocityData = {
  this_week_count: 4,
  baseline_avg_per_week: null,
  ratio: null,
  direction: 'no_baseline',
}

export default function VelocityPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-violet-400">
            Dev preview
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Outbound velocity
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Spiking / steady / slowing / no-baseline-yet.
          </p>
        </header>
        <Variant label="Spiking"><OutboundVelocity velocity={SPIKING} /></Variant>
        <Variant label="Steady"><OutboundVelocity velocity={STEADY} /></Variant>
        <Variant label="Slowing"><OutboundVelocity velocity={SLOWING} /></Variant>
        <Variant label="No baseline yet"><OutboundVelocity velocity={NO_BASELINE} /></Variant>
      </div>
    </main>
  )
}

function Variant({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </div>
      {children}
    </div>
  )
}
