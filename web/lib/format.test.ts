import { describe, expect, it } from 'vitest'
import {
  contactName,
  formatCurrency,
  formatDate,
  formatPhone,
  formatRelative,
  tierLabel,
} from '@/lib/format'

describe('formatRelative', () => {
  it('returns em-dash for null / undefined / invalid', () => {
    expect(formatRelative(null)).toBe('—')
    expect(formatRelative(undefined)).toBe('—')
    expect(formatRelative('not-a-date')).toBe('—')
  })

  it('bucketizes recent timestamps into minutes / hours / days', () => {
    const now = Date.now()
    expect(formatRelative(new Date(now - 30 * 1000).toISOString())).toBe('just now')
    expect(formatRelative(new Date(now - 5 * 60 * 1000).toISOString())).toBe('5m ago')
    expect(formatRelative(new Date(now - 3 * 60 * 60 * 1000).toISOString())).toBe('3h ago')
    expect(formatRelative(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())).toBe('2d ago')
  })
})

describe('formatPhone', () => {
  it('formats US 10-digit and 11-digit numbers', () => {
    expect(formatPhone('5551234567')).toBe('(555) 123-4567')
    expect(formatPhone('15551234567')).toBe('+1 (555) 123-4567')
    expect(formatPhone('+1-555-123-4567')).toBe('+1 (555) 123-4567')
  })

  it('falls back to raw string for non-US lengths', () => {
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958')
  })

  it('returns em-dash for empty input', () => {
    expect(formatPhone(null)).toBe('—')
    expect(formatPhone('')).toBe('—')
  })
})

describe('formatCurrency', () => {
  it('uses M / k suffixes at thresholds', () => {
    expect(formatCurrency(2_500_000)).toBe('$2.5M')
    expect(formatCurrency(15_000)).toBe('$15.0k')
    expect(formatCurrency(750)).toBe('$750')
  })

  it('returns em-dash for nullish, $0 for zero', () => {
    expect(formatCurrency(null)).toBe('—')
    expect(formatCurrency(undefined)).toBe('—')
    expect(formatCurrency(0)).toBe('$0')
  })
})

describe('formatDate', () => {
  it('returns em-dash for invalid input', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate('garbage')).toBe('—')
  })

  it('renders a non-empty locale string for valid ISO', () => {
    expect(formatDate('2026-01-15T00:00:00Z').length).toBeGreaterThan(0)
  })
})

describe('contactName', () => {
  it('prefers full name over email', () => {
    expect(contactName({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('Ada Lovelace')
    expect(contactName({ first_name: 'Ada', email: 'a@x.com' })).toBe('Ada')
  })

  it('falls back to email, then "Unknown"', () => {
    expect(contactName({ email: 'noname@x.com' })).toBe('noname@x.com')
    expect(contactName({})).toBe('Unknown')
    expect(contactName(null)).toBe('Unknown')
  })
})

describe('tierLabel', () => {
  it('maps 1/2/3 to T1/T2/T3 and everything else to em-dash', () => {
    expect(tierLabel(1)).toBe('T1')
    expect(tierLabel(2)).toBe('T2')
    expect(tierLabel(3)).toBe('T3')
    expect(tierLabel(null)).toBe('—')
    expect(tierLabel(99)).toBe('—')
  })
})
