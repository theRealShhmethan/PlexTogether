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

Both of Plex's documented sign-in methods use a **PIN flow**. The host signs in **on
plex.tv** (`https://app.plex.tv/auth#?clientID=…&code=…&forwardUrl=…`), and PlexTogether
reads the token off the claimed PIN. We never see the password. Set the method with `PLEX_AUTH_MODE`.

### Default: `legacy` ("Traditional Token Authentication")

1. `POST https://plex.tv/api/v2/pins?strong=true` creates a PIN.
2. The browser goes to the Plex auth app, and Plex redirects back to `/auth/callback`.
3. `GET https://plex.tv/api/v2/pins/:id` returns `authToken` once the PIN is claimed.

The token is **long-lived**: it doesn't expire until revoked.

### Optional: `jwt` (Plex's recommended method, currently unusable)

Plex's docs recommend JWT auth. The server generates an Ed25519 key pair and registers it
with `POST clients.plex.tv/api/v2/pins { jwk, strong: true }`. After sign-in, it exchanges a
signed device JWT for a 7-day Plex JWT, refreshed via the nonce flow. The code is complete
and tested, and it works against plex.tv (verified 2026-09-23).

**Why it isn't the default: Plex Media Server rejects JWTs.** When `/resources` is called
with a JWT, it returns JWT server tokens too, and PMS answers every authenticated request with
**401**. We saw this on PMS 1.42.1 (`remote https: token rejected`, `relay https: token rejected`,
after `/identity` confirmed the right server). Other developers have reported it since
2025-12 with no staff answer
([forum thread](https://forums.plex.tv/t/question-on-https-clients-plex-tv-api-v2-resources-and-jwt-authentication/934478)).
This contradicts the docs' statement that the JWT works against "your Plex Media Server
instance". One workaround reported on the forum, getting legacy server tokens from the
undocumented `/api/v2/devices` endpoint, is **not** used here. It's undocumented, and a legacy
server token is just as long-lived as the legacy user token. Using the documented legacy flow
is simpler and no less secure.

**Plex quirk (JWT mode):** if the JWK isn't matched, Plex *silently* returns a legacy token
(confirmed by Plex staff). In JWT mode we refuse it, so a broken setup fails loudly.

### Where secrets live

| Item | Location | Reaches a browser? |
| --- | --- | --- |
| Plex password | only ever typed into plex.tv | never seen by us |
| plex.tv token (full account access) | server memory (`src/lib/session/store.ts`) | **never** |
| Plex Home profile token (after switching profile) | server memory | **never** |
| Per-server `accessToken`s from `/resources` | server memory | **never** (Phase 5 will need one in the host's browser; see §5) |
| Device private key (JWT mode) | server memory, non-extractable | **never** |
| Session id (random 256-bit) | `pt_session` cookie, HttpOnly, SameSite=Lax, Secure in prod | yes, as an opaque id |
| Client identifier (not secret) | `pt_cid_legacy` / `pt_cid_jwt` cookie (one per auth mode; Plex refuses legacy sign-in for an id registered as a JWT device) | yes |

Other controls: same-origin (`Origin`) checks on every POST route; `Referrer-Policy: no-referrer`;
`frame-ancestors 'none'`; Plex errors are logged without URLs or headers; responses are validated with zod;
the browser only receives an explicit allowlist of fields (`toPublicUser`, `toPublicServer`).
Before any server token is sent to a connection, `/identity` must return the expected machine id.

**Sign-out** discards the token, but Plex documents no revoke endpoint, so **a discarded legacy
token stays valid on plex.tv**. It's held only in memory (or encrypted on disk, see below), so this only matters if the server
process was compromised while you were signed in. To revoke it for certain, remove
"PlexTogether" under plex.tv → Account → Authorized Devices. (A discarded JWT lapses within 7 days.)

### Plex Home profiles

If the signed-in account is a Plex Home admin, the host can switch to another Home profile
(for example their own profile under a parent's account). That profile's token then replaces
the account token for server discovery, browsing and (later) playback. That means its own watch
history applies, and a managed profile's library restrictions apply too. The account token is
kept only to list and switch profiles.

**Undocumented:** `GET /api/v2/home/users` and `POST /api/v2/home/users/{id}/switch` aren't in
Plex's official docs. They're what Plex's own apps use, and python-plexapi relies on them.
Response shapes are validated loosely (`src/lib/plex/home.ts`). A profile PIN is forwarded to
plex.tv over HTTPS and never stored or logged.

### Saved sessions

Sessions live in memory. If `SESSION_SECRET` (32 random bytes, in `.env.local`) is set, they're also saved to
`SESSION_STORE_PATH` (default `.data/sessions.enc.json`, gitignored) with **AES-256-GCM**.
The file is written atomically and re-read at startup. That includes the account token, the active
Home profile and its token, and the selected server (with its token) and item. The server-list cache
isn't saved, and pending logins never are. A tampered file, or a changed or removed key, means the
file is ignored and everyone signs in again. JWT-mode sessions aren't saved, because their device
key is deliberately non-extractable. Sessions last 30 days. Threat model: the file alone is useless,
but the file **plus** `.env.local` reveals the tokens, so both rely on the host machine's account security.

## 3. The PMS token model: what the docs say

Every PMS request needs an `X-Plex-Token`. A browser `<video>` element can't set
headers, so for playback the token goes in the media URL's query string. **Any
browser that plays from PMS directly can read that token** (devtools, the network tab, JS).

The tokens available to the host:

| Token | Source | Scope |
| --- | --- | --- |
| plex.tv token (legacy or JWT) | PIN flow | the whole plex.tv account (legacy tokens also work on the host's PMS; JWTs currently don't, see §2) |
| Server `accessToken` | `GET clients.plex.tv/api/v2/resources` | for a server you own: admin on that PMS. For a server shared with you: limited to what was shared |
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

## 5. Host playback (Phase 5, proof of concept)

The host's own browser has to hold a PMS token to play (it goes in the media URLs). Rather than the
long-lived server `accessToken`, we plan to give the host's browser a **transient token**
(`POST /security/token`, max 48 h, dies on PMS restart). It has the same access, but a leak
expires on its own. (Plex Web likewise holds a server token in the browser.) It is scoped to that one server and is only given to
the host's authenticated session. It's never stored in `localStorage` and never sent over the
sync WebSocket. **As built:** the server calls `/video/:/transcode/universal/decision` and then hands the player the
`start.m3u8` URL (no token in it) plus a transient token. The player (hls.js) adds that token only to
requests for the Plex server's own origin (`withToken`). We always request HLS with direct
stream allowed. Compatible video and audio are copied (remuxed), and anything else is transcoded to
H.264/AAC (Generic profile plus an `add-transcode-target` augmentation). Subtitles are burned in for
now. True direct play of the original file isn't used yet. The player's time equals media time
(resume uses hls.js `startPosition`, not Plex's `offset`), which Phase 7 sync relies on. Progress
goes to `/:/timeline` via our server every 10 s and on every state change, which updates Plex's
resume point and watched status. Only the watch-party pick can be started, and only the current
session can report. We'll prefer `local`/HTTPS connections from `/resources`
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
