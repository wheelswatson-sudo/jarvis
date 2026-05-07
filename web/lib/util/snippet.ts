// Shared snippet builder for the unified `messages` table. Two channels
// today: Gmail (HTML bodies — strip tags before whitespace collapse) and
// iMessage (plain text — skip the HTML pass). The same 140-char target
// is used everywhere so the inbox UI's snippet column lines up across
// channels.

const SNIPPET_LEN = 140

export function makeSnippet(
  body: string,
  opts: { stripHtml?: boolean } = {},
): string {
  const stripped = opts.stripHtml === true
    ? body.replace(/<[^>]+>/g, ' ')
    : body
  return stripped.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN)
}
