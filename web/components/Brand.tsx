export function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'text-2xl' : 'text-lg'
  return (
    <span className={`${cls} font-medium tracking-tight`}>
      jarvis<span className="text-zinc-300">.</span>
    </span>
  )
}
