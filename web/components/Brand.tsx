type Size = 'sm' | 'md' | 'lg'

const SIZE_CLS: Record<Size, { wrap: string; mark: string; word: string }> = {
  sm: { wrap: 'gap-1.5', mark: 'h-5 w-5 text-[10px]', word: 'text-sm' },
  md: { wrap: 'gap-2', mark: 'h-6 w-6 text-[11px]', word: 'text-base' },
  lg: { wrap: 'gap-3', mark: 'h-9 w-9 text-sm', word: 'text-2xl' },
}

export function Brand({
  size = 'md',
  showWordmark = true,
}: {
  size?: Size
  showWordmark?: boolean
}) {
  const cls = SIZE_CLS[size]
  return (
    <span className={`inline-flex items-center ${cls.wrap}`}>
      <span
        className={`relative inline-flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/30 via-violet-500/25 to-fuchsia-500/30 ring-1 ring-inset ring-white/15 ${cls.mark}`}
        aria-hidden="true"
      >
        <span className="absolute inset-0 rounded-lg bg-gradient-to-br from-white/[0.08] to-transparent" />
        <BrandGlyph />
      </span>
      {showWordmark && (
        <span
          className={`font-semibold tracking-tight aiea-gradient-text ${cls.word}`}
        >
          AIEA
        </span>
      )}
    </span>
  )
}

function BrandGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="url(#aiea-grad)"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="relative h-[60%] w-[60%]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aiea-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stopColor="#a5b4fc" />
          <stop offset="50%" stopColor="#c4b5fd" />
          <stop offset="100%" stopColor="#f5d0fe" />
        </linearGradient>
      </defs>
      {/* Sparkle / spark — ascending diagonals */}
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  )
}
