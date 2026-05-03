// Google OAuth scopes — the single source of truth.
//
// Listed here as a pure constant (no server imports) so the login page can
// import it on the client. Keep this file dependency-free.

export const GOOGLE_OAUTH_SCOPES = [
  // Identity — Supabase needs these for the login itself.
  'openid',
  'email',
  'profile',
  // Gmail — read messages into the unified inbox.
  'https://www.googleapis.com/auth/gmail.readonly',
  // Contacts — People API sync.
  'https://www.googleapis.com/auth/contacts.readonly',
  // Calendar — read AND write so the EA can create / move events.
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Tasks — read AND write so the EA can manage the user's task list.
  'https://www.googleapis.com/auth/tasks',
] as const

export type GoogleOAuthScope = (typeof GOOGLE_OAUTH_SCOPES)[number]
