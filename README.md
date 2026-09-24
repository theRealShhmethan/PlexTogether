# PlexTogether

A web-based replacement for Plex's Watch Together: two browsers play the same
item from your Plex Media Server, kept in sync over WebSockets. Plex handles the
media; PlexTogether handles rooms and synchronization.

## Status: v0.1: foundation + Plex sign-in

| Phase | Feature | Status |
| --- | --- | --- |
| 1 | Project foundation | ✅ done |
| 2 | Plex sign-in (PIN flow) | ✅ done — verified with a real account (Chrome, Windows) |
| 3 | Server discovery + connectivity check | ✅ done — verified against a real PMS (Synology, 1.42.1) |
| 4 | Library browsing, Continue Watching, search, pick an item; Plex Home profile switching | ✅ done — verified against a real PMS |
| 5 | Playback proof of concept (host, HLS via Plex's transcoder, progress saved to Plex) | ✅ implemented, **needs a real-server test** |
| 6 | Rooms: invite link, join with a name, participants, ready, end, expiry | ✅ done — verified with two browsers |
| 7 | Playback sync: Start Together, shared play/pause/seek with per-guest permissions, clock sync, drift correction | ✅ implemented, **needs a two-browser test** (first test found the seek stall, now fixed) |
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
- `server.ts`: a custom Node server (run with `tsx`) that serves Next.js **and** the room WebSockets (`/ws/rooms/<id>`, via `ws`) on one port. Next.js route handlers can't hold WebSockets. Room state is in memory (`src/lib/rooms/hub.ts`).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full plan.

## Development

Requirements: Node.js 20.9+ (developed on 24), npm.

```bash
npm install
cp .env.example .env.local   # then set SESSION_SECRET (see below) to stay signed in across restarts
npm run dev                  # http://localhost:3000
```

On Windows you can instead double-click **`start-dev.bat`**, or run it from cmd. It starts the dev server from the project folder and opens the browser.

Open **exactly** the URL in `APP_URL` (default `http://localhost:3000`, not
`127.0.0.1`). Sign-in POSTs are rejected if the origin doesn't match.

| Script | What it does |
| --- | --- |
| `npm run dev` | dev server (Next.js + room WebSockets; restarts when `server.ts` or room code changes) |
| `npm run build`, then `npm start` | production build, then serve |
| `npm run typecheck` | generates Next route types, then runs `tsc` |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run check` | typecheck + lint + tests |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3000` | Public origin; used for the Plex return URL and CSRF origin checks |
| `PLEX_PRODUCT_NAME` | `PlexTogether` | Name shown in plex.tv → Authorized Devices |
| `SESSION_SECRET` | *(unset)* | **Secret.** 32 random bytes (base64). When set, sign-ins, including the selected Plex Home profile, server and pick, are saved **encrypted** so a restart doesn't sign you out. Unset means memory only. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `SESSION_STORE_PATH` | `.data/sessions.enc.json` | Where the encrypted sessions are saved (gitignored) |
| `PLEX_AUTH_MODE` | `legacy` | `legacy` or `jwt`. JWT is Plex's recommended method, but Plex Media Server currently rejects JWTs, so leave this on `legacy` for now |

`SESSION_SECRET` is the only secret. Keep it in `.env.local`, which is gitignored. Plex tokens are obtained at sign-in, not configured.

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
- With `SESSION_SECRET` set, sessions are saved to `.data/` encrypted with AES-256-GCM, so that file contains no readable tokens. Without it, sessions are memory-only and a restart signs you out. Anyone with both the `.data/` file **and** `.env.local` could read the tokens, so keep the laptop account secure.

## Supported browsers

Target: host on Chrome/Edge (Windows), guest on Chrome (macOS). Safari is desirable but not yet tested.

## Current limitations

- Sign-in, server selection and library browsing only. No playback, rooms, or sync yet.
- Posters are fetched through PlexTogether (`/api/plex/image`, allowlisted Plex image paths only) so the server token never reaches the browser.
- Connectivity is checked from the PlexTogether server, not the browser. On localhost these are the same machine; once hosted elsewhere, Phase 5 will also need a browser-side check.
- Single process only. JWT-mode sessions aren't saved across restarts. Rooms are memory-only, so a restart ends them.
- Remote guests need the app served over HTTPS at a public URL. Localhost only works for testing on your own machine.

## Roadmap

Phases 3 → 8 above, in order. The guest-access design (Option A: guest uses a
Plex account with a shared library, vs. Option B: a room-scoped media gateway)
must be decided before Phase 6.
