import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { buildAuthAppUrl, createJwtPin, createLegacyPin } from "@/lib/plex/auth";
import { PlexApiError } from "@/lib/plex/client";
import { generateDeviceKey } from "@/lib/plex/deviceKey";
import { clientIdCookieName, COOKIE_PENDING, setSecureCookie } from "@/lib/session/cookies";
import { plexClientFor } from "@/lib/session/host";
import { PENDING_LOGIN_TTL_MS, randomId, savePendingLogin } from "@/lib/session/store";

const CLIENT_ID_PATTERN = /^[0-9a-f-]{36}$/;
// SECURITY: only our own home page or a room page — never an arbitrary URL (no open redirect).
const ReturnToSchema = z.union([z.literal("/"), z.string().regex(/^\/r\/[A-Za-z0-9_-]{22}$/)]).catch("/");

/**
 * Step 1 of sign-in: create a PIN and return the app.plex.tv URL the browser
 * should navigate to. The PIN id (and, in JWT mode, the device key) stay
 * server-side.
 */
export async function POST(request: Request) {
  const config = getConfig();
  if (!isSameOrigin(request, config.appOrigin)) return jsonError(403, "Cross-origin request rejected");

  const body = (await request.json().catch(() => ({}))) as { returnTo?: unknown };
  const returnTo = ReturnToSchema.parse(body?.returnTo ?? "/");

  const store = await cookies();
  const clientIdCookie = clientIdCookieName(config.authMode);
  let clientIdentifier = store.get(clientIdCookie)?.value;
  if (!clientIdentifier || !CLIENT_ID_PATTERN.test(clientIdentifier)) clientIdentifier = randomUUID();

  const client = plexClientFor(clientIdentifier);
  const deviceKey = config.authMode === "jwt" ? await generateDeviceKey() : null;

  let pin;
  try {
    pin = deviceKey ? await createJwtPin(client, deviceKey) : await createLegacyPin(client);
  } catch (err) {
    if (err instanceof PlexApiError) {
      console.error(`[auth] ${err.endpoint} failed: ${err.message}`);
      return jsonError(502, "Could not start Plex sign-in. Please try again.");
    }
    throw err;
  }

  const pendingId = randomId();
  savePendingLogin({
    id: pendingId,
    clientIdentifier,
    mode: config.authMode,
    deviceKey,
    pinId: pin.id,
    returnTo,
    expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
  });

  setSecureCookie(store, clientIdCookie, clientIdentifier, 400 * 24 * 60 * 60);
  setSecureCookie(store, COOKIE_PENDING, pendingId, PENDING_LOGIN_TTL_MS / 1000);

  const authUrl = buildAuthAppUrl(client, pin.code, `${config.appOrigin}/auth/callback`);
  return Response.json({ authUrl }, { headers: { "Cache-Control": "no-store" } });
}
