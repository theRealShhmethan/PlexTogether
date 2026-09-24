# PlexTogether

A web-based replacement for Plex's Watch Together: two browsers play the same
item from your Plex Media Server, kept in sync over WebSockets. Plex handles the
media; PlexTogether handles rooms and synchronization.

## Status: v0.1: foundation + Plex sign-in

| Phase | Feature | Status |
| --- | --- | --- |
| 1 | Project foundation | ✅ done |
| 2 | Plex sign-in (PIN flow) | ✅ done — verified with a real account (Chrome, Windows) |
| 3 | Server discovery + connectivity check | ✅ implemented, **needs a real-server test** |
| 4 | Library browsing | ⏳ not started |
| 5 | Playback proof of concept | ⏳ not started |
| 6 | Rooms / invites | ⏳ blocked on a guest-access decision (see below) |
| 7 | Playback sync | ⏳ not started |
| 8 | Buffering / reconnect | ⏳ not started |

### ⚠️ Guest mode limitation

Plex's documented APIs have no token limited to a single item. Every token that
can play from your server is at least admin-level on it. So a guest **cannot**
stream directly from your server without either their own Plex account (with
something shared to it) or a separate media gateway that keeps the token
server-side. We won't give guests your token. The details and options are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#4-finding-accountless-guest-playback-directly-from-pms-is-not-safely-possible).

Plex also requires **Plex Pass** on the server owner's account, or Plex Pass / Remote
Watch Pass on the viewer's account, for remote video playback.

## Architecture

- **Next.js 16 (App Router) + TypeScript**, one Node process.
- Server-side Plex client in `src/lib/plex/` (auth, headers, response validation).
- In-memory session store in `src/lib/session/`. There's no database yet.
- Planned: a `ws` WebSocket server on the same process for rooms and sync.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full plan.

## Development

Requirements: Node.js 20.9+ (developed on 24), npm.

```bash
npm install
cp .env.example .env.local   # optional; defaults work for localhost
npm run dev                  # http://localhost:3000
```

Open **exactly** the URL in `APP_URL` (default `http://localhost:3000`, not
`127.0.0.1`). Sign-in POSTs are rejected if the origin doesn't match.

| Script | What it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm start` | production build / serve |
| `npm run typecheck` | generates Next route types, then runs `tsc` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run check` | typecheck + lint + tests |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | Public origin; used for the Plex return URL and CSRF origin checks |
| `PLEX_PRODUCT_NAME` | `PlexTogether` | Name shown in plex.tv → Authorized Devices |
| `PLEX_AUTH_MODE` | `legacy` | `legacy` or `jwt`. JWT is Plex's recommended method, but Plex Media Server currently rejects JWTs, so leave this on `legacy` for now |

There are no secrets in env today. Plex tokens are obtained at runtime and held only in server memory.

## Security model (short version)

- You sign in **on plex.tv**. PlexTogether never sees your password.
- Your Plex token and your servers' access tokens live **only in server memory**. The
  browser gets an opaque HttpOnly session cookie. Tokens never go into HTML, JS,
  URLs, `localStorage`, logs, or (later) WebSocket messages.
- Sign-in uses Plex's documented **legacy** PIN flow. Plex's newer JWT method is
  implemented (`PLEX_AUTH_MODE=jwt`), but Plex Media Server currently rejects JWT
  tokens. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#2-plex-authentication-implemented-in-v01).
- A server's token is only sent after that address proves it's the expected server (`/identity`).
- POST routes require a same-origin `Origin` header.
- Sign out discards the token, but legacy tokens **stay valid on plex.tv** until revoked
  (Plex has no documented revoke API). To revoke, remove "PlexTogether" under
  plex.tv → Account → Authorized Devices.
- Restarting the server signs everyone out (sessions are in memory).

## Supported browsers

Target: host on Chrome/Edge (Windows), guest on Chrome (macOS). Safari is desirable but not yet tested.

## Current limitations

- Sign-in and server selection only. No browsing, playback, rooms, or sync yet.
- Connectivity is checked from the PlexTogether server, not the browser. On localhost these are the same machine; once hosted elsewhere, Phase 5 will also need a browser-side check.
- Sessions are lost on restart. Single process only.
- Remote guests need the app served over HTTPS at a public URL. Localhost only works for testing on your own machine.

## Roadmap

Phases 3 → 8 above, in order. The guest-access design (Option A: guest uses a
Plex account with a shared library, vs. Option B: a room-scoped media gateway)
must be decided before Phase 6.
