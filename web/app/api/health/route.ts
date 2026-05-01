import { NextResponse } from 'next/server'
import { createClient } from '../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

type ComponentStatus = 'operational' | 'degraded' | 'down'

type ComponentResult = {
  name: string
  status: ComponentStatus
  latency_ms: number
  last_checked: string
  details?: string
}

const DEGRADED_LATENCY_MS = 1500
const FETCH_TIMEOUT_MS = 5000

async function timed<T>(
  name: string,
  fn: () => Promise<{ status: ComponentStatus; details?: string }>,
): Promise<ComponentResult> {
  const start = performance.now()
  let status: ComponentStatus = 'down'
  let details: string | undefined
  try {
    const result = await fn()
    status = result.status
    details = result.details
  } catch (err) {
    status = 'down'
    details = err instanceof Error ? err.message : 'Unknown error'
  }
  const latency_ms = Math.round(performance.now() - start)
  if (status === 'operational' && latency_ms > DEGRADED_LATENCY_MS) {
    status = 'degraded'
    details = details ?? `High latency (${latency_ms}ms)`
  }
  return {
    name,
    status,
    latency_ms,
    last_checked: new Date().toISOString(),
    details,
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timer)
  }
}

function selfBaseUrl(request: Request): string {
  const fromVercel = process.env.VERCEL_URL
  if (fromVercel) return `https://${fromVercel}`
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString()

  const database = await timed('Database (Supabase)', async () => {
    const supabase = await createClient()
    const { error } = await supabase.from('contacts').select('id').limit(1)
    if (error) {
      return { status: 'down' as ComponentStatus, details: error.message }
    }
    return { status: 'operational' as ComponentStatus }
  })

  const auth = await timed('Auth (Supabase Auth)', async () => {
    const supabase = await createClient()
    const { error } = await supabase.auth.getUser()
    if (error && error.status && error.status >= 500) {
      return { status: 'down' as ComponentStatus, details: error.message }
    }
    return { status: 'operational' as ComponentStatus }
  })

  const api = await timed('API (self-ping)', async () => {
    const res = await fetchWithTimeout(`${selfBaseUrl(request)}/api/health/ping`)
    if (!res.ok) {
      return {
        status: 'down' as ComponentStatus,
        details: `HTTP ${res.status}`,
      }
    }
    return { status: 'operational' as ComponentStatus }
  })

  const edgeFunctions = await timed('Edge Functions', async () => {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!supaUrl) {
      return {
        status: 'down' as ComponentStatus,
        details: 'NEXT_PUBLIC_SUPABASE_URL not set',
      }
    }
    const res = await fetchWithTimeout(`${supaUrl}/functions/v1/`, {
      method: 'GET',
    })
    if (res.status >= 500) {
      return {
        status: 'down' as ComponentStatus,
        details: `HTTP ${res.status}`,
      }
    }
    return { status: 'operational' as ComponentStatus }
  })

  const components: ComponentResult[] = [database, auth, api, edgeFunctions]

  let overall: ComponentStatus = 'operational'
  if (components.some((c) => c.status === 'down')) overall = 'down'
  else if (components.some((c) => c.status === 'degraded')) overall = 'degraded'

  const httpStatus = overall === 'down' ? 503 : 200

  return NextResponse.json(
    {
      status: overall,
      components,
      timestamp: startedAt,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
    },
    {
      status: httpStatus,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  )
}
