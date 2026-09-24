import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { COOKIE_SESSION } from "@/lib/session/cookies";
import { deleteSession } from "@/lib/session/store";

/**
 * Discards the session, including the Plex JWT and device private key.
 * Without the key the JWT can no longer be refreshed, so it lapses within
 * 7 days. (Plex documents no device-revocation endpoint; the host can revoke
 * immediately under plex.tv → Account → Authorized Devices.)
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const store = await cookies();
  const id = store.get(COOKIE_SESSION)?.value;
  if (id) deleteSession(id);
  store.delete(COOKIE_SESSION);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
