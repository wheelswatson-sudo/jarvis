'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'

const TOKENS = {
  navy: '#0a1628',
  deep: '#111d33',
  blue: '#4f8cff',
  purple: '#a78bfa',
  text: '#e4e9f2',
  muted: '#8a95a9',
} as const

export default function LandingPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Set html/body bg to navy while this page is mounted; restore on unmount.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      bodyColor: body.style.color,
    }
    html.style.background = TOKENS.navy
    body.style.background = TOKENS.navy
    body.style.color = TOKENS.text
    return () => {
      html.style.background = prev.htmlBg
      body.style.background = prev.bodyBg
      body.style.color = prev.bodyColor
    }
  }, [])

  // Scroll-driven parallax: write progress to CSS vars on the root.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let raf = 0
    const update = () => {
      raf = 0
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
      const sp = Math.min(1, Math.max(0, window.scrollY / max))
      root.style.setProperty('--sp', sp.toFixed(4))
      root.style.setProperty('--sy', `${window.scrollY}`)
    }
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // Constellation canvas — drifts continuously, intensifies with scroll.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    let width = 0
    let height = 0

    type Node = {
      x: number
      y: number
      vx: number
      vy: number
      r: number
      depth: number // 0 (back) → 1 (front), drives parallax + size
      hue: 'blue' | 'purple'
      twinklePhase: number
    }
    let nodes: Node[] = []

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    const targetCount = () => {
      // Scale node count to viewport area.
      const area = width * height
      return Math.round(Math.min(180, Math.max(60, area / 14000)))
    }

    const seed = () => {
      const n = targetCount()
      nodes = []
      for (let i = 0; i < n; i++) {
        const depth = Math.random()
        nodes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.18 * (0.5 + depth),
          vy: (Math.random() - 0.5) * 0.18 * (0.5 + depth),
          r: 0.6 + depth * 1.8,
          depth,
          hue: Math.random() < 0.55 ? 'blue' : 'purple',
          twinklePhase: Math.random() * Math.PI * 2,
        })
      }
    }

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === width && h === height) return
      width = w
      height = h
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let raf = 0
    let last = performance.now()

    const step = (now: number) => {
      raf = requestAnimationFrame(step)
      const dt = Math.min(48, now - last)
      last = now

      const sp = Math.min(
        1,
        Math.max(0, window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)),
      )

      // Constellation peaks around the middle of the page and fades toward
      // the bottom so the pricing card stays clean. Ramps up over [0, 0.5],
      // holds, then fades over [0.6, 1.0] to a 0.3 floor.
      const ramp = Math.min(1, sp / 0.5)
      const fade = sp <= 0.6 ? 1 : Math.max(0.3, 1 - (sp - 0.6) * 1.75)
      const intensity = ramp * fade

      // Connection threshold — grows modestly, then fades.
      const baseDist = 110
      const dist = baseDist + Math.min(0.5, sp) * 60
      const dist2 = dist * dist

      // Background gradient — subtle radial, dampened past mid-page.
      const grad = ctx.createRadialGradient(
        width * (0.5 + Math.sin(now / 8000) * 0.05),
        height * (0.4 + sp * 0.2),
        0,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.85,
      )
      grad.addColorStop(0, `rgba(79, 140, 255, ${0.05 + intensity * 0.05})`)
      grad.addColorStop(0.55, `rgba(167, 139, 250, ${0.025 + intensity * 0.035})`)
      grad.addColorStop(1, 'rgba(10, 22, 40, 0)')
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, width, height)

      // Drift + draw nodes.
      const speedMul = reduceMotion ? 0 : 1
      for (const n of nodes) {
        n.x += n.vx * (dt / 16) * speedMul
        n.y += n.vy * (dt / 16) * speedMul
        // Gentle wraparound w/ small margin so they don't pop.
        const margin = 40
        if (n.x < -margin) n.x = width + margin
        if (n.x > width + margin) n.x = -margin
        if (n.y < -margin) n.y = height + margin
        if (n.y > height + margin) n.y = -margin
      }

      // Parallax offset for the whole field (subtle depth shift on scroll).
      const py = -sp * 60

      // Lines first (under nodes).
      ctx.lineWidth = 1
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 > dist2) continue
          const t = 1 - d2 / dist2
          // Strength scaled by intensity so lines thin out near the bottom.
          const strength = t * (0.12 + intensity * 0.4) * fade
          if (strength <= 0) continue
          // Mix the two accent hues based on average depth + a touch of scroll.
          const mix = (a.depth + b.depth) / 2
          const useBlue = mix < 0.5 + (1 - sp) * 0.1
          const color = useBlue ? '79, 140, 255' : '167, 139, 250'
          ctx.strokeStyle = `rgba(${color}, ${strength.toFixed(3)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y + py * a.depth)
          ctx.lineTo(b.x, b.y + py * b.depth)
          ctx.stroke()
        }
      }

      // Nodes on top.
      for (const n of nodes) {
        n.twinklePhase += 0.012 * (0.5 + n.depth)
        const tw = 0.65 + Math.sin(n.twinklePhase) * 0.25
        const baseAlpha = (0.35 + n.depth * 0.45) * tw * (0.55 + intensity * 0.45) * fade
        const color = n.hue === 'blue' ? '79, 140, 255' : '167, 139, 250'
        // Halo — fades with the rest near the bottom.
        const haloR = n.r * (3 + Math.min(0.5, sp) * 2)
        const halo = ctx.createRadialGradient(n.x, n.y + py * n.depth, 0, n.x, n.y + py * n.depth, haloR)
        halo.addColorStop(0, `rgba(${color}, ${(baseAlpha * 0.6).toFixed(3)})`)
        halo.addColorStop(1, `rgba(${color}, 0)`)
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(n.x, n.y + py * n.depth, haloR, 0, Math.PI * 2)
        ctx.fill()
        // Core
        ctx.fillStyle = `rgba(${color}, ${Math.min(1, baseAlpha + 0.25).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(n.x, n.y + py * n.depth, n.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // Reveal-on-scroll for sections marked with [data-reveal].
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('[data-reveal]')
    if (!('IntersectionObserver' in window) || els.length === 0) {
      els.forEach((el) => el.setAttribute('data-revealed', 'true'))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.setAttribute('data-revealed', 'true')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <div ref={rootRef} className="landing">
      <style>{styles}</style>

      {/* Backstop — fixed full-viewport solid navy, behind all other layers */}
      <div className="landing__backstop" aria-hidden="true" />

      {/* Constellation canvas — fixed full-viewport, behind everything */}
      <canvas ref={canvasRef} className="landing__canvas" aria-hidden="true" />

      {/* Mid-depth accent blobs — slower than scroll for parallax depth */}
      <div className="landing__blobs" aria-hidden="true">
        <div className="blob blob--blue" />
        <div className="blob blob--purple" />
        <div className="blob blob--blue blob--alt" />
      </div>

      {/* Sticky nav */}
      <nav className="landing__nav">
        <div className="landing__nav-inner">
          <Link href="/landing" className="landing__logo" aria-label="AIEA">
            <span className="landing__logo-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="landing__logo-text">AIEA</span>
          </Link>
          <div className="landing__nav-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
          </div>
          <Link href="/login" className="landing__cta landing__cta--sm">
            Get Early Access
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing__hero">
        <div className="landing__hero-inner" data-reveal>
          <div className="landing__pill">
            <span className="landing__pill-dot" /> Private beta · invitation only
          </div>
          <h1 className="landing__h1">
            Your relationships deserve
            <br />
            <span className="landing__grad">an executive assistant.</span>
          </h1>
          <p className="landing__lede">
            AIEA is the intelligence layer that watches your calendar, inbox, and tasks —
            then quietly keeps the people who matter from slipping through the cracks.
          </p>
          <p className="landing__proof">
            Built by a founder who manages 500+ key relationships.
          </p>
          <div className="landing__hero-cta">
            <Link href="/login" className="landing__cta">
              Get Early Access
            </Link>
            <a href="#how" className="landing__cta-ghost">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
        <div className="landing__hero-scroll" aria-hidden="true">
          <span />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="landing__section">
        <div className="landing__section-head" data-reveal>
          <span className="landing__eyebrow">Capabilities</span>
          <h2 className="landing__h2">A quiet intelligence behind every interaction.</h2>
          <p className="landing__sub">
            Six surfaces, one connected brain. Each pulls signal from the others.
          </p>
        </div>
        <div className="landing__grid">
          {FEATURES.map((f, i) => (
            <article
              key={f.title}
              className="glass landing__feature"
              data-reveal
              style={{ ['--stagger' as string]: `${i * 70}ms` }}
            >
              <div className="landing__feature-icon" aria-hidden="true">
                {f.icon}
              </div>
              <h3 className="landing__feature-title">{f.title}</h3>
              <p className="landing__feature-body">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="landing__section landing__section--how">
        <div className="landing__section-head" data-reveal>
          <span className="landing__eyebrow">How it works</span>
          <h2 className="landing__h2">Three steps. Then it disappears into the background.</h2>
        </div>
        <ol className="landing__steps">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="glass landing__step"
              data-reveal
              style={{ ['--stagger' as string]: `${i * 120}ms` }}
            >
              <div className="landing__step-num">{String(i + 1).padStart(2, '0')}</div>
              <h3 className="landing__step-title">{s.title}</h3>
              <p className="landing__step-body">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Pricing */}
      <section id="pricing" className="landing__section">
        <div className="landing__section-head" data-reveal>
          <span className="landing__eyebrow">Pricing</span>
          <h2 className="landing__h2">One plan while we&rsquo;re in beta.</h2>
          <p className="landing__sub">
            Founder pricing locks in for life. Cancel any time.
          </p>
        </div>
        <div className="landing__pricing-wrap" data-reveal>
          <div className="glass landing__price-card">
            <div className="landing__price-eyebrow">AIEA · Beta</div>
            <div className="landing__price-row">
              <span className="landing__price-amount">$50</span>
              <span className="landing__price-per">/ month</span>
            </div>
            <ul className="landing__price-list">
              <li>Unlimited contacts, commitments, and threads</li>
              <li>Real-time Google Workspace sync</li>
              <li>Daily briefings + relationship pulse</li>
              <li>Inbox triage with draft suggestions</li>
              <li>Direct line to the founders</li>
            </ul>
            <Link href="/login" className="landing__cta landing__cta--block">
              Get Early Access
            </Link>
            <p className="landing__price-foot">
              Founder seats are limited while we tune the model on real workflows.
            </p>
          </div>
        </div>
      </section>

      {/* Beta banner CTA */}
      <section className="landing__banner-wrap" data-reveal>
        <div className="glass landing__banner">
          <div>
            <div className="landing__banner-eyebrow">Private beta</div>
            <h3 className="landing__banner-h">
              Stop missing the people who matter.
            </h3>
            <p className="landing__banner-sub">
              Connect Google in 60 seconds. AIEA does the rest.
            </p>
          </div>
          <Link href="/login" className="landing__cta landing__cta--lg">
            Get Early Access
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing__footer">
        <div className="landing__footer-inner">
          <div className="landing__logo">
            <span className="landing__logo-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="landing__logo-text">AIEA</span>
          </div>
          <div className="landing__footer-links">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <Link href="/login">Sign in</Link>
          </div>
          <div className="landing__footer-meta">
            © {new Date().getFullYear()} AIEA · Relationship intelligence
          </div>
        </div>
      </footer>
    </div>
  )
}

const FEATURES: { title: string; body: string; icon: React.ReactNode }[] = [
  {
    title: 'Calendar Sync',
    body:
      'Two-way Google Calendar sync with conflict detection, prep notes, and meeting context pulled from every prior interaction.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    title: 'Tasks & Commitments',
    body:
      'Every promise you make — extracted from email and meetings, tracked to completion, surfaced before they go overdue.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 12.5l4 4 10-10" />
        <path d="M3.5 17.5h11" />
      </svg>
    ),
  },
  {
    title: 'Email Intelligence',
    body:
      'Inbox triage with priority scoring keyed to your network. Drafts written in your voice. Never sent without your nod.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
        <path d="M3.5 7.5l8.5 6 8.5-6" />
      </svg>
    ),
  },
  {
    title: 'Contact Profiles',
    body:
      'A living dossier per relationship: history, half-life, predicted LTV, and the next move that keeps it warm.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="9" r="3.5" />
        <path d="M5 19c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />
      </svg>
    ),
  },
  {
    title: 'Daily Briefings',
    body:
      'A two-minute morning read: who you owe, who’s gone cold, what to say, and the single move that matters most.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M5 7h14M5 12h14M5 17h9" />
      </svg>
    ),
  },
  {
    title: 'Network Intelligence',
    body:
      'Map who connects to who in your network. Spot warm introductions, identify influence patterns, and find the shortest path to any contact.',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="5" cy="6" r="2" />
        <circle cx="19" cy="6" r="2" />
        <circle cx="12" cy="13" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="19" r="2" />
        <path d="M6.5 7.5L11 12M17.5 7.5L13 12M11.5 14.5L7 18M12.5 14.5L17 18" />
      </svg>
    ),
  },
]

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Connect Google',
    body:
      'One OAuth click. AIEA reads your calendar, mail, contacts, and tasks. No data leaves your account without your say.',
  },
  {
    title: 'AIEA Syncs',
    body:
      'In the background, your network is mapped: relationships, commitments, half-lives, and the patterns that hint at what’s next.',
  },
  {
    title: 'Get Briefed',
    body:
      'Every morning — and any time you ask — AIEA hands you the shortlist of what to do, who to reach, and what to say.',
  },
]

const styles = `
  .landing {
    --navy: ${TOKENS.navy};
    --deep: ${TOKENS.deep};
    --blue: ${TOKENS.blue};
    --purple: ${TOKENS.purple};
    --text: ${TOKENS.text};
    --muted: ${TOKENS.muted};
    --sp: 0;
    color: var(--text);
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(79,140,255,0.10), transparent 60%),
      radial-gradient(80% 60% at 100% 30%, rgba(167,139,250,0.08), transparent 65%),
      radial-gradient(80% 60% at 0% 70%, rgba(79,140,255,0.06), transparent 65%),
      linear-gradient(180deg, var(--navy) 0%, var(--deep) 100%);
    min-height: 100vh;
    position: relative;
    overflow-x: hidden;
    font-feature-settings: 'ss01','cv11';
  }
  .landing * { box-sizing: border-box; }
  .landing a { color: inherit; text-decoration: none; }

  .landing__backstop {
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(79,140,255,0.10), transparent 60%),
      radial-gradient(80% 60% at 100% 30%, rgba(167,139,250,0.08), transparent 65%),
      radial-gradient(80% 60% at 0% 70%, rgba(79,140,255,0.06), transparent 65%),
      linear-gradient(180deg, var(--navy) 0%, var(--deep) 100%);
  }
  .landing__canvas {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 0;
    opacity: 0.95;
  }

  /* Mid-depth blobs — parallax via translate3d driven by --sp */
  .landing__blobs {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    overflow: hidden;
  }
  .blob {
    position: absolute;
    width: 60vmax;
    height: 60vmax;
    border-radius: 50%;
    filter: blur(90px);
    opacity: 0.35;
    will-change: transform;
  }
  .blob--blue {
    background: radial-gradient(circle, rgba(79,140,255,0.55) 0%, rgba(79,140,255,0) 65%);
    top: -20vmax;
    left: -15vmax;
    transform: translate3d(0, calc(var(--sp) * 30vh), 0);
  }
  .blob--purple {
    background: radial-gradient(circle, rgba(167,139,250,0.55) 0%, rgba(167,139,250,0) 65%);
    top: 40vh;
    right: -20vmax;
    transform: translate3d(0, calc(var(--sp) * -40vh), 0);
  }
  .blob--alt {
    width: 45vmax;
    height: 45vmax;
    top: 120vh;
    left: 30vw;
    opacity: 0.28;
    transform: translate3d(calc(var(--sp) * -20vw), calc(var(--sp) * 20vh), 0);
  }

  /* Foreground content above canvas + blobs */
  .landing > nav,
  .landing > section,
  .landing > footer { position: relative; z-index: 2; }

  /* Nav */
  .landing__nav {
    position: sticky;
    top: 0;
    z-index: 50;
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    background: linear-gradient(180deg, rgba(10,22,40,0.72), rgba(10,22,40,0.45));
    border-bottom: 1px solid rgba(228,233,242,0.06);
  }
  .landing__nav-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 18px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  .landing__logo { display: inline-flex; align-items: center; gap: 10px; }
  .landing__logo-mark {
    position: relative;
    width: 22px;
    height: 22px;
    display: inline-block;
  }
  .landing__logo-mark > span {
    position: absolute;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--blue), var(--purple));
    box-shadow: 0 0 10px rgba(79,140,255,0.55);
  }
  .landing__logo-mark > span:nth-child(1) { width: 7px; height: 7px; top: 0; left: 0; }
  .landing__logo-mark > span:nth-child(2) { width: 5px; height: 5px; top: 9px; right: 0; opacity: 0.85; }
  .landing__logo-mark > span:nth-child(3) { width: 4px; height: 4px; bottom: 0; left: 6px; opacity: 0.7; }
  .landing__logo-text {
    font-weight: 600;
    letter-spacing: 0.18em;
    font-size: 14px;
  }
  .landing__nav-links {
    display: none;
    gap: 28px;
    font-size: 14px;
    color: var(--muted);
  }
  .landing__nav-links a { transition: color .2s ease; }
  .landing__nav-links a:hover { color: var(--text); }
  @media (min-width: 760px) { .landing__nav-links { display: flex; } }

  /* CTAs */
  .landing__cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 18px;
    border-radius: 999px;
    font-size: 14px;
    font-weight: 500;
    color: white;
    background: linear-gradient(135deg, var(--blue), var(--purple));
    box-shadow:
      0 10px 30px -8px rgba(79,140,255,0.55),
      inset 0 1px 0 rgba(255,255,255,0.18);
    transition: transform .2s ease, box-shadow .2s ease, filter .2s ease;
    white-space: nowrap;
  }
  .landing__cta:hover { transform: translateY(-1px); filter: brightness(1.08); }
  .landing__cta--sm { padding: 9px 14px; font-size: 13px; }
  .landing__cta--lg { padding: 14px 22px; font-size: 15px; }
  .landing__cta--block { display: flex; width: 100%; padding: 14px 18px; }
  .landing__cta-ghost {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    color: var(--muted);
    font-size: 14px;
    border-radius: 999px;
    transition: color .2s ease, background .2s ease;
  }
  .landing__cta-ghost:hover { color: var(--text); background: rgba(255,255,255,0.04); }

  /* Hero */
  .landing__hero {
    min-height: calc(100vh - 64px);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 16px 24px 64px;
    position: relative;
  }
  .landing__hero-inner {
    max-width: 880px;
    transform: translate3d(0, calc(var(--sp) * -60px), 0);
    will-change: transform;
  }
  .landing__pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(228,233,242,0.10);
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .landing__pill-dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--blue);
    box-shadow: 0 0 10px var(--blue);
    animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }
  .landing__h1 {
    margin: 22px 0 18px;
    font-size: clamp(40px, 7vw, 80px);
    line-height: 1.02;
    letter-spacing: -0.025em;
    font-weight: 600;
  }
  .landing__grad {
    background: linear-gradient(120deg, #ffffff 0%, var(--blue) 35%, var(--purple) 75%, #ffffff 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer 8s ease-in-out infinite;
  }
  @keyframes shimmer {
    0%,100% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
  }
  .landing__lede {
    margin: 0 auto;
    max-width: 620px;
    color: var(--muted);
    font-size: clamp(15px, 1.5vw, 18px);
    line-height: 1.6;
  }
  .landing__proof {
    margin: 14px auto 0;
    color: rgba(138, 149, 169, 0.7);
    font-size: 13px;
    letter-spacing: 0.01em;
  }
  .landing__hero-cta {
    margin-top: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .landing__hero-scroll {
    position: absolute;
    bottom: 32px;
    left: 50%;
    transform: translateX(-50%);
    width: 22px;
    height: 36px;
    border-radius: 12px;
    border: 1px solid rgba(228,233,242,0.18);
    opacity: calc(1 - var(--sp) * 4);
    transition: opacity .2s linear;
  }
  .landing__hero-scroll > span {
    position: absolute;
    left: 50%;
    top: 6px;
    width: 2px;
    height: 6px;
    background: var(--text);
    border-radius: 2px;
    transform: translateX(-50%);
    animation: scrollHint 1.8s ease-in-out infinite;
  }
  @keyframes scrollHint {
    0% { opacity: 0; transform: translate(-50%, 0); }
    50% { opacity: 1; }
    100% { opacity: 0; transform: translate(-50%, 14px); }
  }

  /* Sections */
  .landing__section {
    max-width: 1200px;
    margin: 0 auto;
    padding: 56px 24px;
  }
  .landing__section--how { padding-top: 24px; padding-bottom: 40px; }
  .landing__section-head { max-width: 720px; margin: 0 auto 36px; text-align: center; }
  .landing__eyebrow {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(79,140,255,0.10);
    color: var(--blue);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    border: 1px solid rgba(79,140,255,0.22);
  }
  .landing__h2 {
    margin: 18px 0 12px;
    font-size: clamp(28px, 4vw, 44px);
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-weight: 600;
  }
  .landing__sub { color: var(--muted); font-size: 16px; line-height: 1.6; }

  /* Glass cards */
  .glass {
    position: relative;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
    border: 1px solid rgba(228,233,242,0.08);
    border-radius: 20px;
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    box-shadow:
      0 1px 0 rgba(255,255,255,0.05) inset,
      0 30px 60px -30px rgba(0,0,0,0.5);
  }
  .glass::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    background: linear-gradient(135deg, rgba(79,140,255,0.4), rgba(167,139,250,0.0) 40%, rgba(167,139,250,0.4) 100%);
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
    opacity: 0.55;
    pointer-events: none;
  }

  /* Features grid */
  .landing__grid {
    display: grid;
    gap: 18px;
    grid-template-columns: 1fr;
  }
  @media (min-width: 720px) { .landing__grid { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 1080px) { .landing__grid { grid-template-columns: repeat(3, 1fr); } }
  .landing__feature {
    padding: 28px;
    transition: transform .35s ease;
  }
  .landing__feature:hover { transform: translateY(-3px); }
  .landing__feature-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    color: var(--blue);
    background: linear-gradient(135deg, rgba(79,140,255,0.18), rgba(167,139,250,0.18));
    border: 1px solid rgba(79,140,255,0.22);
  }
  .landing__feature-title { margin: 18px 0 8px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  .landing__feature-body { color: var(--muted); font-size: 14.5px; line-height: 1.6; }

  /* Steps */
  .landing__steps {
    list-style: none;
    margin: 0; padding: 0;
    display: grid;
    gap: 18px;
    grid-template-columns: 1fr;
    counter-reset: step;
  }
  @media (min-width: 900px) { .landing__steps { grid-template-columns: repeat(3, 1fr); } }
  .landing__step { padding: 32px 28px; }
  .landing__step-num {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.18em;
    background: linear-gradient(135deg, var(--blue), var(--purple));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .landing__step-title { margin: 12px 0 8px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .landing__step-body { color: var(--muted); font-size: 14.5px; line-height: 1.6; }

  /* Pricing */
  .landing__pricing-wrap { display: flex; justify-content: center; }
  .landing__price-card {
    width: 100%;
    max-width: 460px;
    padding: 40px 36px 32px;
    text-align: left;
  }
  .landing__price-eyebrow {
    color: var(--blue);
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .landing__price-row { display: flex; align-items: baseline; gap: 8px; margin: 12px 0 8px; }
  .landing__price-amount {
    font-size: 56px;
    font-weight: 600;
    letter-spacing: -0.03em;
    background: linear-gradient(135deg, #ffffff, var(--blue));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .landing__price-per { color: var(--muted); font-size: 15px; }
  .landing__price-list {
    list-style: none;
    padding: 0;
    margin: 18px 0 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .landing__price-list li {
    position: relative;
    padding-left: 24px;
    color: var(--text);
    font-size: 14.5px;
    line-height: 1.5;
  }
  .landing__price-list li::before {
    content: '';
    position: absolute;
    left: 0; top: 7px;
    width: 14px; height: 9px;
    border-left: 2px solid var(--blue);
    border-bottom: 2px solid var(--blue);
    transform: rotate(-45deg);
    border-bottom-left-radius: 2px;
  }
  .landing__price-foot {
    margin-top: 14px;
    color: var(--muted);
    font-size: 12.5px;
    text-align: center;
  }

  /* Banner CTA */
  .landing__banner-wrap { padding: 24px 24px 72px; max-width: 1200px; margin: 0 auto; }
  .landing__banner {
    padding: 36px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    align-items: flex-start;
    background:
      linear-gradient(135deg, rgba(79,140,255,0.18), rgba(167,139,250,0.10) 60%, rgba(255,255,255,0.02));
  }
  @media (min-width: 720px) {
    .landing__banner { flex-direction: row; align-items: center; justify-content: space-between; padding: 44px 48px; }
  }
  .landing__banner-eyebrow {
    color: var(--blue); font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 600;
  }
  .landing__banner-h { margin: 8px 0 6px; font-size: clamp(22px, 3vw, 30px); letter-spacing: -0.015em; font-weight: 600; }
  .landing__banner-sub { color: var(--muted); font-size: 15px; }

  /* Footer */
  .landing__footer {
    border-top: 1px solid rgba(228,233,242,0.06);
    padding: 36px 24px 60px;
    background: rgba(10,22,40,0.55);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .landing__footer-inner {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    color: var(--muted);
    font-size: 13px;
  }
  .landing__footer-links { display: flex; gap: 22px; }
  .landing__footer-links a:hover { color: var(--text); }
  .landing__footer-meta { font-size: 12.5px; }

  /* Reveal animations */
  [data-reveal] {
    opacity: 0;
    transform: translate3d(0, 24px, 0);
    transition:
      opacity .9s ease var(--stagger, 0ms),
      transform .9s cubic-bezier(.2,.8,.2,1) var(--stagger, 0ms);
  }
  [data-reveal][data-revealed='true'] {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }

  @media (prefers-reduced-motion: reduce) {
    [data-reveal] { opacity: 1; transform: none; transition: none; }
    .landing__hero-inner { transform: none; }
    .blob { transform: none !important; }
    .landing__pill-dot,
    .landing__hero-scroll > span { animation: none; }
    .landing__grad { animation: none; }
  }
`
