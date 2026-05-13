// Fail-loud env validation. Imported by instrumentation.ts so missing
// required vars crash the server at boot instead of silently 401-ing,
// returning 503, or producing the kind of "why is this dead" debug session
// that ate Chris Cravens' beta.
//
// Two tiers:
//   - REQUIRED_ALWAYS: app cannot function without these. Throw everywhere.
//   - REQUIRED_IN_PRODUCTION: feature-gated in dev (CRON, SMS webhook), but
//     production must have them. Throw on Vercel, warn locally.
//
// Build-time (`next build`) is skipped — Vercel injects env at runtime, and
// builds happen on machines that may not have the full secret set.

const REQUIRED_ALWAYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const

const REQUIRED_IN_PRODUCTION = [
  'CRON_SECRET',
  'SMS_GATEWAY_WEBHOOK_SECRET',
] as const

type RequiredKey =
  | (typeof REQUIRED_ALWAYS)[number]
  | (typeof REQUIRED_IN_PRODUCTION)[number]

function isMissing(name: string): boolean {
  const v = process.env[name]
  return v === undefined || v.trim() === ''
}

export function validateEnv(): { missing: RequiredKey[]; warned: string[] } {
  // Skip during `next build` — Vercel runs build without runtime secrets
  // injected, and the build output references env vars without needing
  // their values. We still validate at server-start via instrumentation.ts.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { missing: [], warned: [] }
  }

  const isProd =
    process.env.VERCEL_ENV === 'production' ||
    (process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV)

  const missing: RequiredKey[] = []
  const warned: string[] = []

  for (const key of REQUIRED_ALWAYS) {
    if (isMissing(key)) missing.push(key)
  }

  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!isMissing(key)) continue
    if (isProd) {
      missing.push(key)
    } else {
      warned.push(key)
    }
  }

  if (warned.length > 0) {
    console.warn(
      `[env] missing feature-gated vars (ok in dev, required in prod): ${warned.join(', ')}`,
    )
  }

  if (missing.length > 0) {
    const lines = [
      `[env] Missing required environment variables:`,
      ...missing.map((k) => `  - ${k}`),
      ``,
      `See .env.example for the full list. On Vercel, add via:`,
      `  vercel env add <NAME> production --value "..." --yes`,
    ]
    throw new Error(lines.join('\n'))
  }

  return { missing, warned }
}

// Validate at module load. Any import of this file (including from
// instrumentation.ts) triggers the check. Idempotent — env is static
// per-process so re-running is a no-op.
validateEnv()
