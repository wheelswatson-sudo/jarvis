'use client'

import { useEffect, useState } from 'react'

// Server-rendered greeting would use the server's timezone (UTC on Vercel),
// so "Good morning" would fire at random hours for the user. Render
// client-side once after mount; show a neutral fallback during SSR/hydration
// so the eyebrow never flashes the wrong greeting.
function fromHour(h: number): string {
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Working late'
}

export function Greeting({ fallback = 'Today' }: { fallback?: string }) {
  const [text, setText] = useState(fallback)
  useEffect(() => {
    // Hydration-safe: client read-only effect, won't render-loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(fromHour(new Date().getHours()))
  }, [])
  return <>{text}</>
}
