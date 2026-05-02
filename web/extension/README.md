# Relationship Intelligence — Chrome Extension

Manifest V3 Chrome extension that surfaces RI context on LinkedIn and Facebook
profiles and lets Watson log social signals back to the RI database.

## Build

```sh
cd web/extension
npm install
npm run build
```

The build emits `dist/`. To load it in Chrome:

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select `web/extension/dist`

## Connect

Open the popup and paste:

- **RI instance URL** — defaults to `https://relationship-intelligence-blue.vercel.app`
- **Auth token** — your Supabase access token. Grab it from the RI app via
  DevTools → Application → Cookies → `sb-*-auth-token` (the `access_token`
  field inside the JSON value), or via `supabase.auth.getSession()` in the
  console.

The extension calls `/api/extension/*` on the configured instance with that
token in the `Authorization: Bearer <token>` header.

## Architecture

- `src/background.ts` — service worker. Owns network calls, stores settings,
  refreshes the action badge with the count of stale contacts.
- `src/content/linkedin.ts` — runs on `linkedin.com/in/*`. Extracts profile
  fields, asks the background SW to match against contacts, renders the
  sidebar.
- `src/content/facebook.ts` — runs on `facebook.com/*`. Same flow.
- `src/content/sidebar.ts` + `sidebar.css` — shared sidebar UI (zinc-950
  base, indigo/violet accents).
- `src/popup/` — settings, contacts-needing-attention list, quick search.
- `src/lib/` — types, message protocol, storage, API client.

## API endpoints

Implemented in `web/app/api/extension/`:

- `GET /api/extension/ping` — auth check.
- `GET /api/extension/match?url=<social_url>&name=<optional>` — returns the
  matching contact (or null) for a given social URL. Matches by
  `personal_details.linkedin_url` / `facebook_url` first, then
  `contacts.linkedin`, then case-insensitive name fallback.
- `GET /api/extension/context/[id]` — relationship health, last interaction,
  open commitments, next follow-up — everything the sidebar needs.
- `POST /api/extension/social-update` — stores extracted profile fields into
  `contacts.personal_details`, logs an interaction, stages detected job /
  company changes into `pending_changes`.
- `GET /api/extension/stale` — contacts with a social URL who haven't been
  contacted in the last 30 days, ordered by tier then staleness.
- `GET /api/extension/search?q=…` — name / title / company ilike search.

All endpoints accept `Authorization: Bearer <supabase_access_token>` and
return CORS-permissive headers so the SW's fetch from `chrome-extension://`
works.

## Schema

No migration. The extension uses `personal_details` JSONB convention:

- `personal_details.linkedin_url` — canonical LinkedIn URL.
- `personal_details.facebook_url` — canonical Facebook URL.
- `personal_details.linkedin_headline` — last-seen LinkedIn headline.
- `personal_details.linkedin_about` — LinkedIn about-section snapshot.
- `personal_details.facebook_current_city` — last-seen "Lives in" value.
- `personal_details.facebook_workplace` — last-seen "Works at" value.
- `personal_details.social_last_checked_at` — ISO timestamp of last
  extension capture.

Detected job / company changes are NOT auto-applied to `contacts.title` /
`contacts.company`; they're staged into `pending_changes` for review.
