// Shared loading skeleton for app routes. Renders gradient placeholders
// shaped like the typical PageHeader + section layout so the page never
// flashes blank during server-component data fetches.

export function PageSkeleton({
  title = 'Loading…',
}: {
  title?: string
}) {
  return (
    <div className="space-y-8 animate-pulse" aria-busy="true" aria-live="polite">
      <div className="space-y-3">
        <div className="h-4 w-24 rounded-full bg-white/[0.05]" />
        <div className="h-9 w-72 max-w-full rounded-lg bg-gradient-to-r from-indigo-500/15 via-violet-500/15 to-fuchsia-500/15" />
        <div className="h-4 w-64 max-w-full rounded-full bg-white/[0.04]" />
        <span className="sr-only">{title}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="h-28 rounded-2xl bg-white/[0.03]" />
        <div className="h-28 rounded-2xl bg-white/[0.03]" />
        <div className="h-28 rounded-2xl bg-white/[0.03]" />
      </div>
      <div className="h-64 rounded-2xl bg-white/[0.03]" />
    </div>
  )
}
