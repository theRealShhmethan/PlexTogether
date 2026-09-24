# Running PlexTogether on a Synology NAS

This puts PlexTogether in a Docker container on the NAS and serves it over **HTTPS** on your
own domain through DSM's reverse proxy, so you and your guests can open it from anywhere.

```
Browser ──HTTPS──▶ DSM reverse proxy (443, Let's Encrypt) ──▶ PlexTogether container (localhost:3000)
Browser ──────────────────────────── video ────────────────▶ Plex Media Server (Plex remote access)
```

Video still streams **directly from Plex** to each viewer. PlexTogether only handles sign-in, rooms and sync.

## Before you start

- **DSM 7.2 or later**, with **Container Manager** installed (Package Center).
- **A domain that points at your home**, e.g. a Synology DDNS name like `yourname.synology.me`
  (Control Panel → External Access → DDNS) or your own domain.
- **Router port forwarding** to the NAS for **443** (HTTPS). Forward **80** too while Let's Encrypt issues
  the certificate.
- **Plex Remote Access** turned on for the Plex server (Plex → Settings → Remote Access shows
  "Fully accessible outside your network"). Viewers outside your home stream from Plex directly.

In the examples below, replace `watch.yourname.synology.me` with your address.

## 1. Put the code on the NAS

The easiest way is **File Station**. On GitHub, open the repository → **Code → Download ZIP**, and
extract it into a folder such as `/docker/plextogether`, so that `docker-compose.yml` is directly
inside it.

If you have SSH enabled, you can instead run:

```sh
cd /volume1/docker
git clone https://github.com/theRealShhmethan/PlexTogether.git plextogether
```

## 2. Create the settings file (`.env`)

In the `plextogether` folder, create a file named **`.env`**. File Station → Create → Create
file works. Put this in it:

```ini
APP_URL=https://watch.yourname.synology.me
SESSION_SECRET=<paste a generated secret here>
```

- `APP_URL` must be **exactly** the address people will type: `https://`, no trailing slash, and include
  the port if you don't use 443 (e.g. `https://yourname.synology.me:8443`).
- `SESSION_SECRET` encrypts saved sign-ins and watch parties. Generate one on your PC with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
  or over SSH on the NAS with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
  **Keep it private** and never commit it. Changing it later signs everyone out.

## 3. Build and start the container

Container Manager → **Project** → **Create**:

- **Project name:** `plextogether`
- **Path:** the `plextogether` folder
- **Source:** "Use existing docker-compose.yml"

Then click **Next → Done**. The first build takes a few minutes. When it finishes, the
`plextogether` container shows **Running**, and it's listening on the NAS itself at
`http://localhost:3000`. It isn't reachable from outside yet, and it isn't meant to be.

## 4. Get a certificate

Control Panel → **Security → Certificate → Add → Add a new certificate → Get a certificate from
Let's Encrypt**. Enter your domain (e.g. `watch.yourname.synology.me`) and your email.

With a Synology DDNS name, the certificate can also cover subdomains.

## 5. Add the reverse proxy (HTTPS → container)

Control Panel → **Login Portal → Advanced → Reverse Proxy → Create**:

| | |
| --- | --- |
| Reverse proxy name | PlexTogether |
| **Source:** protocol / hostname / port | HTTPS / `watch.yourname.synology.me` / 443 |
| **Destination:** protocol / hostname / port | HTTP / `localhost` / 3000 |

On the **Custom Header** tab choose **Create → WebSocket**. It adds the `Upgrade` and
`Connection` headers. **Rooms don't work without this.**

Save. Then, in Control Panel → Security → Certificate → **Settings**, assign your Let's Encrypt
certificate to the **PlexTogether** reverse-proxy entry.

## 6. Try it

Open `https://watch.yourname.synology.me`, click **Host a watch party**, and sign in with Plex.
Choose your server and pick something. Then create a watch party and send the invite link.

Your guest opens the link, types a name, and signs in with **their own Plex account**. That account
needs access to your library: share it from Plex → Settings → Manage Library Access. See
[ARCHITECTURE.md](ARCHITECTURE.md) §4 for why.

## Updating

- **If you used the ZIP:** download the new ZIP and replace the files, but **keep your `.env`**.
- **If you used git:** run `git pull` in the folder.

Then, in Container Manager → Project → `plextogether` → **Action → Build**, rebuild and restart.
Saved sign-ins and watch parties live in the `plextogether-data` volume, so they survive updates.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Sign-in says "Cross-origin request rejected", or you're immediately signed out | `APP_URL` doesn't exactly match the address in the browser. Also, cookies are HTTPS-only in production, so `http://NAS-IP:3000` won't work: use the HTTPS domain. |
| Room says "Connection lost — reconnecting…" forever | The reverse proxy is missing the **WebSocket** custom header. |
| Video won't start for someone outside your home | Plex Remote Access is off or not reachable. Check Plex → Settings → Remote Access. |
| At home, Chrome asks to allow access to devices on your local network | That's the player looking for the fastest route to Plex. Allow it, or it falls back to Plex's remote address. |
| "Your Plex account can't see …" for a guest | Share the library with their Plex account in Plex. |
| Everything was fine, then everyone was signed out | `SESSION_SECRET` changed, or the data volume was deleted. |

Logs: Container Manager → Container → `plextogether` → **Log**. Tokens are never logged.

## Security notes

- The container listens only on `127.0.0.1:3000`. The DSM reverse proxy, over HTTPS, is the only way in.
- `.env` holds `SESSION_SECRET`. Anyone with it **and** the data volume could read the saved Plex
  tokens, so keep DSM admin access tight (2-factor sign-in, and DSM's firewall if you use it).
- To revoke PlexTogether's access to a Plex account, remove "PlexTogether" under plex.tv →
  Account → Authorized Devices.
