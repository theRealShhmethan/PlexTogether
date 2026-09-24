import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { startPlayback } from "@/lib/plex/playback";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";
import { saveSession } from "@/lib/session/store";

/**
 * Starts host playback of the item picked for the watch party. Only that item
 * can be started — the browser can't name arbitrary media.
 *
 * SECURITY: returns a *transient* PMS token (≤48 h) for the host's own
 * player. The long-lived server token never leaves the server.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const host = await requireSelectedServer();
  if (host instanceof Response) return host;

  const { session, target } = host;
  const item = session.selectedItem;
  if (!item) return jsonError(409, "Pick a movie or episode on the Browse page first.");

  const location = session.selectedServer!.connection.local ? "lan" : "wan";
  try {
    const start = await startPlayback(target, { ratingKey: item.ratingKey, location });
    session.playback = {
      sessionId: start.sessionId,
      ratingKey: item.ratingKey,
      durationMs: item.durationMs,
      startedAt: Date.now(),
    };
    saveSession(session);
    return Response.json({ ...start, item, location }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "playback");
  }
}
