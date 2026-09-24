import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { checkPin, fetchPlexUser } from "@/lib/plex/auth";
import { PlexApiError } from "@/lib/plex/client";
import { COOKIE_PENDING, COOKIE_SESSION, setSecureCookie } from "@/lib/session/cookies";
import { plexClientFor } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";
import {
  deletePendingLogin,
  getPendingLogin,
  randomId,
  saveSession,
  SESSION_TTL_MS,
} from "@/lib/session/store";

/**
 * Step 2 of sign-in, called by /auth/callback after app.plex.tv redirects
 * back. Returns 202 while the PIN is still unclaimed so the page can poll.
 */
export async function POST(request: Request) {
  const config = getConfig();
  if (!isSameOrigin(request, config.appOrigin)) return jsonError(403, "Cross-origin request rejected");

  const store = await cookies();
  const pending = getPendingLogin(store.get(COOKIE_PENDING)?.value);
  if (!pending) return jsonError(410, "Sign-in expired or was not started from this browser.");

  const client = plexClientFor(pending.clientIdentifier);
  try {
    const result = await checkPin(client, pending.deviceKey, pending.pinId);
    if (result.status === "pending") {
      return Response.json({ status: "pending" }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    const user = await fetchPlexUser(client, result.plexJwt);

    // New random session id (never reuse the pending id) to prevent fixation.
    const now = Date.now();
    const session = {
      id: randomId(),
      clientIdentifier: pending.clientIdentifier,
      deviceKey: pending.deviceKey,
      plexJwt: result.plexJwt,
      plexJwtExpiresAt: result.expiresAt,
      user,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    saveSession(session);
    deletePendingLogin(pending.id);
    store.delete(COOKIE_PENDING);
    setSecureCookie(store, COOKIE_SESSION, session.id, SESSION_TTL_MS / 1000);

    return Response.json(
      { status: "authorized", user: toPublicUser(session) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof PlexApiError) {
      console.error(`[auth] ${err.endpoint} failed: ${err.message}`);
      if (err.status === 404) {
        deletePendingLogin(pending.id);
        return jsonError(410, "The Plex sign-in code expired. Please start again.");
      }
      return jsonError(502, `Plex sign-in failed: ${err.message}`);
    }
    throw err;
  }
}
