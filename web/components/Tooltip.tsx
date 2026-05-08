'use client'

import { useId, useState, type ReactNode } from 'react'

type Side = 'top' | 'bottom' | 'left' | 'right'

const SIDE_CLS: Record<Side, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
}

// Lightweight, no-deps tooltip. Works on hover (desktop) and on tap/focus
// (mobile + keyboard). The tooltip is a sibling div with absolute positioning
// — keep parent containers `relative` so it anchors correctly.
export function Tooltip({
  content,
  children,
  side = 'top',
  className = '',
}: {
  content: ReactNode
  children: ReactNode
  side?: Side
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className={`relative inline-flex ${className}`}>
      <span
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // Tap-to-toggle for touch devices. Don't swallow click on real
          // buttons — only toggle when our HelpDot is the trigger.
          if ((e.target as HTMLElement).dataset.tooltipTrigger === 'true') {
            setOpen((v) => !v)
          }
        }}
        className="inline-flex"
      >
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none absolute z-50 w-max max-w-[18rem] rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-[11px] leading-relaxed text-zinc-200 shadow-lg shadow-black/40 backdrop-blur-md transition-opacity duration-150 ${SIDE_CLS[side]} ${open ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden={!open}
      >
        {content}
      </span>
    </span>
  )
}

// Small "?" affordance the user can hover or tap to reveal an explainer.
// Use next to jargon like "half-life", "tier", "LTV", "sentiment slope".
export function HelpDot({
  content,
  side = 'top',
  label = 'What is this?',
}: {
  content: ReactNode
  side?: Side
  label?: string
}) {
  return (
    <Tooltip content={content} side={side}>
      <button
        type="button"
        data-tooltip-trigger="true"
        aria-label={label}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-[8px] font-semibold leading-none text-zinc-400 transition-colors hover:border-violet-400/60 hover:text-violet-200"
      >
        ?
      </button>
    </Tooltip>
  )
}
