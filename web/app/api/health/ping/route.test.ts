import { describe, expect, it } from 'vitest'
import { GET } from './route'

describe('GET /api/health/ping', () => {
  it('returns a 200 with the expected shape and no-store caching', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store, max-age=0')

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.timestamp).toBe('string')
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow()
    // commit + env are read from Vercel env vars and may be null locally —
    // we only assert the keys exist so a future refactor that drops them
    // (and breaks dashboards) fails loudly.
    expect(body).toHaveProperty('commit')
    expect(body).toHaveProperty('env')
  })
})
