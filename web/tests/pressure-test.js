#!/usr/bin/env node
/* eslint-disable */
// Pressure test for the proxy auth flow.
//
// Scenarios:
//   1. Anonymous request to /api/health and /api/health/ping should NOT be
//      auth-gated (no redirect to /login, no 5xx).
//   2. Request to a protected page with a malformed sb-auth-token cookie must
//      not crash the proxy. The proxy should treat the bad cookie as
//      unauthenticated and redirect to /login.
//   3. Mixed adversarial cookie values (truncated JWTs, junk base64, oversize
//      payloads) hammered against several routes — none should produce a true
//      5xx (500/502/504). /api/health may legitimately return 503 when a
//      downstream component is reported as down, so 503 from /api/health is
//      excluded from the 5xx tally.
//
// Boots `next dev` itself if no server is already listening on PORT.

const { spawn } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')

const PORT = Number(process.env.PORT || 3000)
const BASE = process.env.PRESSURE_TARGET || `http://127.0.0.1:${PORT}`
const ITERATIONS = Number(process.env.PRESSURE_ITER || 25)
const READY_TIMEOUT_MS = 90_000

const MALFORMED_COOKIES = [
  'sb-access-token=not-a-jwt',
  'sb-access-token=eyJhbGciOiJIUzI1NiJ9.PAYLOAD_TRUNCATED',
  'sb-refresh-token=' + 'A'.repeat(8192),
  'sb-auth-token=%7B%22access_token%22%3A%22broken',
  'sb-auth-token=base64:' + Buffer.from('{not json').toString('base64'),
  'sb-' + Buffer.from('XYZ').toString('hex') + '-auth-token=garbage',
  '__Host-sb-auth-token={"unterminated":',
]

const PATHS_REQUIRING_AUTH = ['/', '/onboarding', '/dashboard']
const PATHS_PUBLIC = ['/api/health', '/api/health/ping']

async function isUp() {
  try {
    const res = await fetch(`${BASE}/api/health/ping`, { cache: 'no-store' })
    return res.status < 500 || res.status === 503
  } catch {
    return false
  }
}

async function waitForReady(deadline) {
  while (Date.now() < deadline) {
    if (await isUp()) return true
    await sleep(500)
  }
  return false
}

function startServer() {
  const proc = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: __dirname + '/..',
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', () => {})
  return proc
}

async function fetchOnce(path, cookie) {
  const headers = cookie ? { cookie } : {}
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers,
      redirect: 'manual',
      cache: 'no-store',
    })
    return { status: res.status, ok: true }
  } catch (err) {
    return { status: 0, ok: false, error: String(err) }
  }
}

function isFiveXX(path, status) {
  // /api/health intentionally returns 503 when a component is reported down.
  // That is not a proxy bug, so we exclude it from the 5xx tally.
  if (path === '/api/health' && status === 503) return false
  return status >= 500 && status < 600
}

async function run() {
  const fiveXX = []
  const summary = {
    publicHealth: { ok: 0, redirected: 0, fiveXX: 0, other: 0 },
    malformedCookieProtected: { ok: 0, redirected: 0, fiveXX: 0, other: 0 },
    malformedCookieHealth: { ok: 0, redirected: 0, fiveXX: 0, other: 0 },
  }

  // 1. Anonymous health checks must succeed without auth gate.
  for (let i = 0; i < ITERATIONS; i++) {
    for (const path of PATHS_PUBLIC) {
      const r = await fetchOnce(path, null)
      const bucket = summary.publicHealth
      if (isFiveXX(path, r.status)) {
        bucket.fiveXX++
        fiveXX.push({ scenario: 'publicHealth', path, status: r.status })
      } else if (r.status >= 300 && r.status < 400) {
        bucket.redirected++
        fiveXX.push({
          scenario: 'publicHealth-unexpectedRedirect',
          path,
          status: r.status,
        })
      } else if (r.status >= 200 && r.status < 300) bucket.ok++
      else bucket.other++
    }
  }

  // 2. Malformed cookies on protected routes — proxy should redirect, not 5xx.
  for (let i = 0; i < ITERATIONS; i++) {
    const cookie = MALFORMED_COOKIES[i % MALFORMED_COOKIES.length]
    for (const path of PATHS_REQUIRING_AUTH) {
      const r = await fetchOnce(path, cookie)
      const bucket = summary.malformedCookieProtected
      if (isFiveXX(path, r.status)) {
        bucket.fiveXX++
        fiveXX.push({
          scenario: 'malformedCookieProtected',
          path,
          status: r.status,
          cookie,
        })
      } else if (r.status >= 300 && r.status < 400) bucket.redirected++
      else if (r.status >= 200 && r.status < 300) bucket.ok++
      else bucket.other++
    }
  }

  // 3. Malformed cookies on health routes — proxy must not crash, and the
  //    health route itself must remain reachable.
  for (let i = 0; i < ITERATIONS; i++) {
    const cookie = MALFORMED_COOKIES[i % MALFORMED_COOKIES.length]
    for (const path of PATHS_PUBLIC) {
      const r = await fetchOnce(path, cookie)
      const bucket = summary.malformedCookieHealth
      if (isFiveXX(path, r.status)) {
        bucket.fiveXX++
        fiveXX.push({
          scenario: 'malformedCookieHealth',
          path,
          status: r.status,
          cookie,
        })
      } else if (r.status >= 300 && r.status < 400) {
        bucket.redirected++
        fiveXX.push({
          scenario: 'malformedCookieHealth-unexpectedRedirect',
          path,
          status: r.status,
          cookie,
        })
      } else if (r.status >= 200 && r.status < 300) bucket.ok++
      else bucket.other++
    }
  }

  return { fiveXX, summary }
}

;(async () => {
  let server
  let owned = false

  if (!(await isUp())) {
    console.log(`[pressure-test] no server on ${BASE}; spawning next dev…`)
    server = startServer()
    owned = true
    const ready = await waitForReady(Date.now() + READY_TIMEOUT_MS)
    if (!ready) {
      console.error('[pressure-test] dev server failed to become ready')
      if (server) server.kill('SIGTERM')
      process.exit(2)
    }
    // Warm-up compile of each route we'll hit, so first-hit compile errors
    // show up here rather than as flakes inside the tally.
    for (const p of [...PATHS_PUBLIC, ...PATHS_REQUIRING_AUTH]) {
      await fetchOnce(p, null)
    }
  } else {
    console.log(`[pressure-test] reusing existing server at ${BASE}`)
  }

  let exitCode = 0
  try {
    const { fiveXX, summary } = await run()
    console.log('[pressure-test] summary:')
    console.log(JSON.stringify(summary, null, 2))
    if (fiveXX.length > 0) {
      console.error(`[pressure-test] FAIL — ${fiveXX.length} bad responses:`)
      for (const f of fiveXX.slice(0, 20)) console.error('  ', f)
      exitCode = 1
    } else {
      console.log('[pressure-test] PASS — 0 5xx errors')
    }
  } catch (err) {
    console.error('[pressure-test] threw:', err)
    exitCode = 3
  } finally {
    if (owned && server) {
      server.kill('SIGTERM')
      await sleep(200)
    }
  }
  process.exit(exitCode)
})()
