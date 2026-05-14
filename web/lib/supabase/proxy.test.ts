import { describe, expect, it } from 'vitest'
import { PUBLIC_EXACT_PATHS, PUBLIC_PATHS } from '@/lib/supabase/proxy'

// These routes intentionally bypass the session-cookie auth gate. If one of
// them disappears from the list, legitimate cron / extension / bridge calls
// will start being redirected to /login — a silent prod regression. This
// test pins the list so removals require an explicit edit here too.
describe('PUBLIC_PATHS', () => {
  it('includes the marketing landing page (exact match only)', () => {
    expect(PUBLIC_EXACT_PATHS.has('/')).toBe(true)
    // prefix-match would catch everything under '/'; that would defeat auth.
    expect(PUBLIC_PATHS).not.toContain('/')
  })

  it('includes all known unauthenticated entry points', () => {
    for (const path of [
      '/login',
      '/auth',
      '/api/health',
      '/api/intelligence/health',
      '/api/intelligence/analyze', // cron
      '/api/extension', // bearer-token auth
      '/api/imessage/sync', // local bridge, bearer-token auth
    ]) {
      expect(PUBLIC_PATHS).toContain(path)
    }
  })

  it('does NOT expose write-sensitive routes', () => {
    for (const path of [
      '/api/contacts',
      '/api/inbox',
      '/api/approvals',
      '/api/chat',
      '/home',
      '/settings',
    ]) {
      expect(PUBLIC_PATHS).not.toContain(path)
    }
  })
})
