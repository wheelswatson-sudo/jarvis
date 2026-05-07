// In-memory per-(user, route) rate limiter.
//
// CAVEAT: Vercel runs each lambda invocation in a fresh process most of the
// time, so this only protects against bursts within a warm container — it
// will NOT enforce a true global limit across the fleet. It's a baseline
// guardrail to keep an authenticated user from accidentally (or maliciously)
// burning through OpenAI/Anthropic/Apollo quota in a single warm container.
// Upgrade to Upstash/Redis/Vercel KV when we add a backing store.

import { NextResponse } from 'next/server'

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

// Cap the map so a stream of bot traffic with random user IDs can't grow
// memory unbounded. When we exceed the cap we drop the oldest reset entries.
const MAX_BUCKETS = 10_000

function gcIfNeeded() {
  if (buckets.size <= MAX_BUCKETS) return
  const now = Date.now()
  // First pass: drop already-expired entries.
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k)
  }
  if (buckets.size <= MAX_BUCKETS) return
  // Second pass: hard cap by deleting the earliest-resetting entries.
  const sorted = [...buckets.entries()].sort(
    (a, b) => a[1].resetAt - b[1].resetAt,
  )
  const toDelete = sorted.length - MAX_BUCKETS
  for (let i = 0; i < toDelete; i++) buckets.delete(sorted[i]![0])
}

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
}

/**
 * Fixed-window counter. `key` should namespace by route AND user, e.g.
 * `chat:${userId}` so different routes have independent budgets.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  gcIfNeeded()
  const now = Date.now()
  const existing = buckets.get(key)
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs }
    buckets.set(key, fresh)
    return { allowed: true, limit, remaining: limit - 1, resetAt: fresh.resetAt }
  }
  if (existing.count >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt: existing.resetAt }
  }
  existing.count++
  return {
    allowed: true,
    limit,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  }
}

/**
 * Convenience wrapper: returns either null (allowed — keep going) or a 429
 * NextResponse with the standard rate-limit headers attached.
 */
export function rateLimitOr429(
  key: string,
  limit: number,
  windowMs: number,
): NextResponse | null {
  const res = checkRateLimit(key, limit, windowMs)
  const headers = {
    'X-RateLimit-Limit': String(res.limit),
    'X-RateLimit-Remaining': String(res.remaining),
    'X-RateLimit-Reset': String(Math.floor(res.resetAt / 1000)),
  }
  if (res.allowed) return null
  const retryAfter = Math.max(1, Math.ceil((res.resetAt - Date.now()) / 1000))
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      code: 'rate_limit_exceeded',
      retry_after_seconds: retryAfter,
    },
    {
      status: 429,
      headers: { ...headers, 'Retry-After': String(retryAfter) },
    },
  )
}

// Standard limits per minute. Tune as we observe usage.
export const LIMITS = {
  CHAT: { limit: 30, windowMs: 60_000 },
  CONTACT_BRIEF: { limit: 20, windowMs: 60_000 },
  CONTACT_ENRICH: { limit: 30, windowMs: 60_000 },
  GMAIL_SYNC: { limit: 6, windowMs: 60_000 },
} as const
