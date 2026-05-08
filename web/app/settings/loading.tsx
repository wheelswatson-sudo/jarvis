import { PageSkeleton } from '../../components/PageSkeleton'

export default function Loading() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#07070b] text-zinc-100">
      <div className="aiea-aurora-bg" aria-hidden="true" />
      <div className="aiea-grid pointer-events-none fixed inset-0 z-0 opacity-50" aria-hidden="true" />
      <div className="relative z-10 mx-auto max-w-3xl px-6 py-12">
        <PageSkeleton title="Loading settings" />
      </div>
    </div>
  )
}
