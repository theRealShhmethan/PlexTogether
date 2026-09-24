# PlexTogether — Architecture & Security Plan

Status: draft for v0.1 (2026-09-23). Research sources are listed at the end.

## 1. Goal

Two people in different places watch the same item from the host's Plex Media
Server (PMS) in their browsers, kept in sync. The PMS delivers the media; PlexTogether coordinates.

```
Host browser ──┐                      ┌── plex.tv (auth, server discovery)
               ├── PlexTogether server┤
Guest browser ─┘   (rooms, sync, WS)  └── (server-side calls only)

Host browser ────┐
                 ├── Plex Media Server (media, transcoding, subtitles)
Guest browser ───┘   ← see §4: how the guest is authorized is the open question
```

## 2. Plex authentication (implemented in v0.1)

Plex's current docs recommend **JWT authentication** using the **PIN flow**.
The older "legacy token" PIN flow still works but is labelled legacy. We use JWT:

1. The server generates an **Ed25519 key pair** for each login and keeps it in memory.
2. `POST https://clients.plex.tv/api/v2/pins` with `{ jwk, strong: true }` registers the public key.
3. The browser goes to `https://app.plex.tv/auth#?clientID=…&code=…&forwardUrl=…`.
   The host signs in **on plex.tv**; PlexTogether never sees their password.
4. After the redirect back, the server signs a short-lived device JWT
   (`aud: plex.tv`, `iss: <clientIdentifier>`, header `kid`/`alg: EdDSA`) and calls
   `GET /api/v2/pins/:id?deviceJWT=…`. `authToken` is the Plex JWT, valid for 7 days.
5. Refresh uses the nonce flow: `GET /auth/nonce` → signed JWT with `nonce` and `scope`
   → `POST /auth/token`. This happens lazily, less than 24 h before expiry.

**Plex quirk:** if the JWK isn't matched, Plex *silently* returns a long-lived legacy
token instead of a JWT (confirmed by Plex staff on the forum). We **refuse** non-JWT
tokens, so a broken setup fails loudly instead of quietly storing a weaker credential.

### Where secrets live

| Item | Location | Reaches a browser? |
| --- | --- | --- |
| Plex password | only ever typed into plex.tv | never seen by us |
| Plex JWT (full account access) | server memory (`src/lib/session/store.ts`) | **never** |
| Device private key | server memory, non-extractable | **never** |
| Session id (random 256-bit) | `pt_session` cookie, HttpOnly, SameSite=Lax, Secure in prod | yes, as an opaque id |
| Client identifier (not secret) | `pt_cid` cookie | yes |

Other controls: same-origin (`Origin`) checks on every POST route; `Referrer-Policy: no-referrer`;
`frame-ancestors 'none'`; Plex errors are logged without URLs or headers; responses are validated with zod;
the browser only receives an explicit allowlist of account fields (`toPublicUser`).

Sign-out deletes the JWT and key. Plex documents no revoke endpoint, so the orphaned JWT
lapses within 7 days (it can't be refreshed without the key). The host can revoke it
immediately under plex.tv → Account → Authorized Devices.

Everything is in memory: if the server restarts, the host signs in again. That's acceptable for v0.1.

## 3. The PMS token model: what the docs say

Every PMS request needs an `X-Plex-Token`. A browser `<video>` element can't set
headers, so for playback the token goes in the media URL's query string. **Any
browser that plays from PMS directly can read that token** (devtools, the network tab, JS).

The tokens available to the host:

| Token | Source | Scope |
| --- | --- | --- |
| Plex JWT | PIN flow | the whole plex.tv account **and** the host's PMS (docs: "any Plex.tv endpoint or your Plex Media Server instance") |
| Server `accessToken` | `GET clients.plex.tv/api/v2/resources` | for the server owner: admin on that PMS |
| Transient token | `POST /security/token?type=delegation&scope=all` on PMS | docs: *"the same access level as the caller's token"*, valid up to 48 h, destroyed on PMS restart. `delegation`/`all` are the **only** supported values |

Plex documents no token scoped to one item, one library, or read-only playback.

## 4. Finding: accountless guest playback directly from PMS is **not safely possible**

To play directly from PMS, the guest's browser must hold one of the tokens above.
Every one of them gives at least **admin access to the host's PMS** (all libraries,
settings, deleting content, managing shares). The Plex JWT also gives account access. A
48-hour admin transient token handed to a guest is exactly the "guest gains general access"
outcome the requirements forbid. An expiring room doesn't help, because the token outlives
the room and Plex offers no way to revoke a transient token before it expires.

**We are stopping here and will not implement guest playback in that form.** The host-side work
(Phases 2–5) doesn't depend on this decision, so it can go ahead.

A second constraint applies whatever design we choose. Since 2025-04-29, **remote video
playback of personal media** requires one of these: the **server admin has Plex Pass**,
**or** the viewer's account has Plex Pass or Remote Watch Pass. Plex currently enforces
this in its own apps and says "eventually all apps and platforms will be affected". We
should assume it applies to us, and not try to get around it.

### Secure alternatives

**A. Guest signs in with their own (free) Plex account — recommended first.**
The host shares a library with the guest through Plex's normal sharing, ideally a dedicated
"Watch Party" library or a label restriction. The guest opens the invite link and signs in
with Plex using the same PIN flow. Their token is limited by Plex to what was shared, and
they stream directly from PMS. There's still no *PlexTogether* account, and the room only
controls sync.
- ✅ Fully supported by Plex; guest access is enforced by Plex, not by us; no host token leaves the server.
- ❌ The guest needs a Plex account. Access lasts until the host un-shares (it doesn't expire with the room).
  Remote playback needs Plex Pass on the host's account, or Plex Pass/Remote Watch Pass on the guest's.

**B. Room-scoped media gateway (true accountless, later, opt-in).**
A small gateway runs *on the host's network* next to PMS and keeps the token server-side.
It exposes to guests **only** the HLS playlist, segments, and subtitles of the room's one item,
authorized by a short-lived room capability (HttpOnly cookie) that dies with the room.
Everything else is denied by a strict allowlist.
- ✅ No Plex account for the guest; access truly expires with the room.
- ❌ Video flows through the gateway (not the sync server). It needs a public HTTPS endpoint
  (port forward or tunnel) on the host's network. An allowlist bug is effectively an admin-token
  leak, so it needs careful review and tests. It must not be used to get around Plex's
  remote-playback requirement (only use it where the host has Plex Pass).

**C. Plex Home managed user.** Still a Plex identity, doesn't expire with the room, and needs
Plex Home. It adds nothing over A.

**Recommendation:** build the host side (Phases 2–5) now. Implement guest access via **A**
in Phase 6. Treat **B** as a separate, security-reviewed milestone, only if a guest account
turns out to be a real blocker. **Decision needed from the project owner before Phase 6.**

## 5. Host playback (Phase 5, planned)

The host's own browser plays from PMS using the server `accessToken` (not the plex.tv JWT),
which is equivalent to Plex Web. The token is scoped to that one server and is only given to
the host's authenticated session. It's never stored in `localStorage` and never sent over the
sync WebSocket. We'll use `/video/:/transcode/universal/decision` + `start.m3u8` (HLS; Chrome
needs hls.js, Safari is native) with a direct-play fallback for browser-compatible files, and
report progress via `/:/timeline`. We'll prefer `local`/HTTPS connections from `/resources`
and use `relay` only as a last resort.

## 6. Rooms & sync (Phases 6–8, planned)

- Room ids / invite tokens: 128+ bits from `crypto.randomBytes`, unguessable. Rooms are in memory
  and expire (e.g. 6 h, or when the host ends them).
- Transport: WebSocket (`ws`) on a custom Node server that also serves Next.js, since Next
  route handlers can't hold WebSockets. All messages are validated with zod, and **no tokens
  are ever sent in WS messages**.
- The host is authoritative. Messages: `PLAY{pos, at}`, `PAUSE{pos}`, `SEEK{pos}`, `STATE{pos, rate, buffering}`
  heartbeat about every 1 s, `READY`, `BUFFERING`. The server timestamps everything and estimates
  per-client clock offset (NTP-style ping) so positions can be compared.
- Drift correction (tunable): < 250 ms ignore · 250–750 ms nudge `playbackRate` ±3–5% ·
  750 ms–2 s rate-correct harder or soft seek · > 2 s hard seek.
- Buffering: a guest's `BUFFERING` → the server pauses the room ("Waiting for Lexi…") → when
  everyone is `READY`, the server sends `PLAY{pos, at: now+~1.5 s}` so all clients start at the same wall-clock time.
  Reconnects rejoin with a per-participant resume token and receive the current room state.

## 7. Deployment stance

v0.1 runs locally (`http://localhost:3000`) on the host's laptop. A remote guest needs
the app reachable over **HTTPS** (a tunnel or hosting), with `APP_URL` set to match. Because
the server holds the host's Plex JWT, the host should run their own instance. A shared
public instance would hold other people's tokens and is out of scope.

## Sources (checked 2026-09-23)

- Plex Media Server API docs, "Authenticating with Plex", "Talking to PMS", `POST /security/token`,
  `GET /security/resources` — https://developer.plex.tv/pms/ (spec v1.2.3)
- Plex forum, staff answer on the silent legacy-token fallback — https://forums.plex.tv/t/exchanging-pin-for-jwt-token/941120
- Requirements for Remote Playback of Personal Media — https://support.plex.tv/articles/requirements-for-remote-playback-of-personal-media/
