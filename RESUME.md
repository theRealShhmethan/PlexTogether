# Resume here

A hand-off note for picking up PlexTogether in a new chat. It covers where things stand, how the
project is deployed, which decisions matter, and what's left.

**To start a new session, paste this:**

> I'm continuing work on PlexTogether (this repo). Read `RESUME.md` first, then
> `docs/ARCHITECTURE.md` and `docs/DEPLOY-SYNOLOGY.md` as needed. Don't change the deployment
> approach or security model without asking me.

---

## Status (last updated 2026-09-25)

**Everything in the original plan is built, deployed, and verified.** The host (Ethan) and a
remote guest (Lexi), each on their own network, watched together in sync through
**https://ebsi.ddns.net**.

| Area | State |
| --- | --- |
| Plex sign-in, server discovery, library browsing, Continue Watching, Plex Home profiles | ✅ verified |
| Host playback (HLS through Plex's transcoder), resume points, progress saved to Plex | ✅ verified |
| Rooms, invite links, guest join, permissions panel (per-guest play/pause and seek) | ✅ verified |
| Sync: Start Together, shared control, clock sync, calm drift correction | ✅ verified |
| Buffering pauses the room ("Waiting for …"), coordinated resume, reconnect, rooms survive restarts | ✅ verified |
| Subtitles/audio (English chosen automatically), quality picker, change title, next episode, chat and reactions | ✅ built; mostly verified |
| Docker on the Synology NAS, HTTPS through Caddy, Let's Encrypt | ✅ live |

Tests: `npm run check` runs typecheck, lint and about 111 Vitest tests. All pass.

## Where it runs

- **Public URL:** https://ebsi.ddns.net (No-IP DDNS pointing at the home connection).
- **NAS:** Synology at LAN IP `10.5.0.60`. The code is in `/volume1/docker/plex-together`. SSH in as `ebsiadmin`.
- **Containers** (`docker compose --profile caddy`):
  - `plextogether`: the app, bound to `127.0.0.1:3000`.
  - `plextogether-caddy`: the HTTPS front on `8443`. It gets and renews its own Let's Encrypt
    certificate via **TLS-ALPN**.
  - Pi-hole and nebula-sync containers also run on the NAS. They're the dad's; leave them alone.
- **Router:** external **443 → 10.5.0.60:8443** (TCP). Port 80 isn't used, because **the ISP (Cox)
  blocks inbound 80**, so DSM's own Let's Encrypt / HTTP-01 challenge can't work.
- **`.env` on the NAS** (never committed) holds `APP_URL=https://ebsi.ddns.net`, `SESSION_SECRET`
  (unique to the NAS), `PUBLIC_HOST=ebsi.ddns.net` and `ACME_EMAIL`.
- **Update the NAS** (no Git needed on it):
  ```sh
  cd /volume1/docker/plex-together
  curl -L https://github.com/theRealShhmethan/PlexTogether/archive/refs/heads/main.tar.gz | tar xz --strip-components=1
  sudo docker compose --profile caddy up -d --build
  ```
- **Logs:** `sudo docker logs --tail 40 plextogether` and `sudo docker logs --tail 40 plextogether-caddy`.

### Hands off (it's the dad's NAS)
- **DSM's default certificate:** don't change it. His **VPN Server** uses it.
- **Existing DSM settings, DDNS entries and certificates:** don't modify or replace them. Add alongside them only.
- **The dad's Synology Account:** Ethan doesn't have that login.

## Accounts and access

- **Host:** Ethan signs in with his **dad's Plex account**, which is the Plex Home admin with **Plex Pass**
  and owns the "Synology-NAS" server. He then switches to **his own Plex Home profile** in the app.
- **Guests:** they use **their own Plex account**, and the library must be shared with it (Plex → Manage
  Library Access). The dad's Plex Pass covers their remote streaming.
- **Plex Remote Access:** must stay on, because viewers stream directly from Plex (port 32400).

## Local development (Windows laptop)

- Double-click `start-dev.bat`, or run `npm run dev`. That starts `tsx watch server.ts`, which serves
  Next.js plus the room WebSockets at http://localhost:3000.
- `.env.local` holds the laptop's own `SESSION_SECRET`. It's gitignored.
- To see the NAS server from the laptop, the laptop needs the home VPN (OpenVPN).
- Before committing: run `npm run check`, and `npm run build` for anything touching the server or Docker.

## Decisions and gotchas (don't re-litigate)

- **Plex sign-in uses the legacy PIN flow**, which is documented. Plex's recommended **JWT** flow works
  against plex.tv, but **PMS rejects JWT server tokens (401)**. That code is kept behind
  `PLEX_AUTH_MODE=jwt`. JWT and legacy need **different client identifiers**, because Plex refuses a legacy
  sign-in for an ID already registered for JWT.
- **Guest model = "Option A":** each viewer streams with their **own** Plex sign-in, and **nobody ever
  gets the host's token**. Accountless guests would need a token-holding gateway ("Option B"). That's
  undecided, and it would need its own security review. See `docs/ARCHITECTURE.md` §4.
- **Tokens never reach browsers.** The one exception is a short-lived **transient** PMS token for the
  viewer's own stream.
- **Plex transcode sessions stream in order,** so far seeks start a **new session with `offset`**, and the
  player tracks media time itself (custom controls).
- **Drift thresholds were tuned in testing:** ignore under 3 s; 3–8 s nudge the playback rate by 4%; over
  8 s reposition, at most once every 30 s. The original 250 ms / 2 s values made the NAS buffer constantly.
- **Viewers pick which Plex address to use from their own browser,** because PlexTogether on the NAS
  can't tell which address a remote viewer can reach.
- **Docker gotchas:**
  - `server.ts` is compiled by esbuild to `dist/server.cjs`, because tsx failed at runtime in Linux.
  - `.next` must be owned by the `node` user.
  - The build runs `chmod a+rX`, because files copied onto the NAS came out owner-only.
- **Persisted to `.data/`** (encrypted with `SESSION_SECRET`): sign-ins and rooms. Chat is memory-only.

## Ideas and TODO (priority order)

1. **Host allowlist + rate limiting.** The site is public now, so anyone could sign in with their own Plex
   account and host on the NAS. Limit hosting to named Plex accounts (e.g. a `HOST_ALLOWLIST` env), and
   rate-limit sign-in and join.
2. **Direct-stream tuning.** Plex's Generic profile still transcodes some audio (and sometimes H.264). A
   better client-profile augmentation would cut NAS load.
3. **Small polish:** poster art for guests in rooms, and Safari testing (not yet tested).
4. **Option B (accountless guests):** only if needed.

## Map of the code

- `server.ts`: custom server (Next.js plus room WebSockets on one port).
- `src/lib/plex/`: Plex API (auth, resources, library, playback, tracks, home profiles).
- `src/lib/rooms/`: room hub (state, sync anchor, permissions, chat), socket and protocol.
- `src/lib/sync/`: clock-offset and drift maths.
- `src/lib/session/`: sessions and encrypted persistence.
- `src/lib/servers/`: server selection, and playback route helpers (`viewer.ts`, `playbackRoutes.ts`).
- `src/components/`: UI. The player is under `player/` and the room under `room/`.
- `docs/ARCHITECTURE.md`: full design and security model. `docs/DEPLOY-SYNOLOGY.md`: deployment.
