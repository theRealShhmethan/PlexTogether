import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { COOKIE_SESSION } from "@/lib/session/cookies";
import { initSessionStore } from "@/lib/session/host";
import { deleteSession } from "@/lib/session/store";

/**
 * Discards the session and the Plex token it holds.
 *
 * SECURITY: Plex documents no sign-out/revoke endpoint. Discarding a legacy
 * token does NOT invalidate it on plex.tv (it doesn't expire on its own); a
 * discarded JWT lapses within 7 days. The host can revoke immediately under
 * plex.tv → Account → Authorized Devices → PlexTogether.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  initSessionStore();
  const store = await cookies();
  const id = store.get(COOKIE_SESSION)?.value;
  if (id) deleteSession(id);
  store.delete(COOKIE_SESSION);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
