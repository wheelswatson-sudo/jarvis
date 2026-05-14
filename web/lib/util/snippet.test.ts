import { describe, expect, it } from 'vitest'
import { makeSnippet } from '@/lib/util/snippet'

describe('makeSnippet', () => {
  it('collapses whitespace and trims for plain text (iMessage path)', () => {
    expect(makeSnippet('  hey   there\n\n  buddy  ')).toBe('hey there buddy')
  })

  it('strips HTML tags when stripHtml=true (Gmail path)', () => {
    expect(
      makeSnippet('<p>Hello <b>world</b></p><br/>cheers', { stripHtml: true }),
    ).toBe('Hello world cheers')
  })

  it('does NOT strip HTML by default — iMessage bodies shouldn\'t be touched', () => {
    expect(makeSnippet('<p>literal text</p>')).toBe('<p>literal text</p>')
  })

  it('caps output at 140 chars', () => {
    const body = 'a'.repeat(500)
    expect(makeSnippet(body).length).toBe(140)
  })
})
