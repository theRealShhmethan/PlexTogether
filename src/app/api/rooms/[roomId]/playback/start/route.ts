import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { parseOffsetMs, startPlayback } from "@/lib/plex/playback";
import { getRoom, resolveGuest } from "@/lib/rooms/hub";
import { RoomIdSchema } from "@/lib/rooms/protocol";
import { selectServer } from "@/lib/servers/service";
import { noStore, pmsErrorResponse, targetFor } from "@/lib/servers/target";
import { COOKIE_GUEST } from "@/lib/session/cookies";
import { getCurrentSession } from "@/lib/session/host";
import { saveSession } from "@/lib/session/store";

/**
 * Starts this participant's own Plex stream of the room's item.
 *
 * SECURITY / guest model: every participant plays with THEIR OWN Plex sign-in
 * in this browser (the host with theirs, a guest with theirs — Option A in
 * docs/ARCHITECTURE.md §4). Nobody receives anyone else's token; a guest's
 * access is whatever Plex grants their account on the host's server. A guest
 * without a Plex sign-in gets 401 + needsPlex and is asked to sign in.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/start">) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const { roomId } = await ctx.params;
  const room = RoomIdSchema.safeParse(roomId).success ? getRoom(roomId) : undefined;
  if (!room) return jsonError(404, "This watch party has ended.");

  const session = await getCurrentSession();
  const isHost = !!session && session.id === room.hostSessionId;
  const guest = isHost ? undefined : resolveGuest((await cookies()).get(COOKIE_GUEST)?.value);
  if (!isHost && guest?.room.id !== room.id) return jsonError(403, "You're not in this watch party.");

  if (!session) {
    return Response.json(
      { error: "Sign in with Plex to watch.", needsPlex: true, serverName: room.item.serverName },
      { status: 401, headers: noStore },
    );
  }

  try {
    // Make sure this participant's session points at the room's server.
    if (session.selectedServer?.serverId !== room.item.serverId) {
      const selected = await selectServer(session, room.item.serverId);
      if (!selected.ok) {
        const message =
          selected.error === "unknown-server"
            ? `Your Plex account can't see ${room.item.serverName}. Ask the host to share the library with you in Plex.`
            : `Couldn't connect to ${room.item.serverName} from here.`;
        return jsonError(403, message);
      }
    }
    const target = targetFor(session)!;
    const location = session.selectedServer!.connection.local ? "lan" : "wan";
    const start = await startPlayback(target, {
      ratingKey: room.item.ratingKey,
      location,
      offsetMs: parseOffsetMs(((await request.json().catch(() => ({}))) as { offsetMs?: unknown })?.offsetMs),
    });
    session.playback = {
      sessionId: start.sessionId,
      ratingKey: room.item.ratingKey,
      durationMs: room.item.durationMs,
      startedAt: Date.now(),
    };
    saveSession(session);
    return Response.json({ ...start, location }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "playback");
  }
}
