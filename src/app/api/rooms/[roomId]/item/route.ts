import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { getItem, PlexIdSchema } from "@/lib/plex/library";
import { changeItem, getRoom } from "@/lib/rooms/hub";
import { RoomIdSchema } from "@/lib/rooms/protocol";
import { buildRoomItem } from "@/lib/rooms/roomItem";
import { selectServer } from "@/lib/servers/service";
import { noStore, pmsErrorResponse, targetFor } from "@/lib/servers/target";
import { getCurrentSession } from "@/lib/session/host";

const BodySchema = z.union([
  // Switch to the host's current pick (or a given item on the host's server).
  z.object({ ratingKey: PlexIdSchema }),
  // Play the next episode of the current show; starts by itself once everyone is loaded.
  z.object({ next: z.literal(true) }),
]);

/** Host only: change what the room is playing, keeping the link and the people. */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/item">) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const { roomId } = await ctx.params;
  const room = RoomIdSchema.safeParse(roomId).success ? getRoom(roomId) : undefined;
  if (!room) return jsonError(404, "This watch party has ended.");
  const session = await getCurrentSession();
  if (!session || session.id !== room.hostSessionId) return jsonError(403, "Only the host can change what's playing.");

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid request");

  try {
    let ratingKey: string;
    let autoStart = false;
    if ("next" in body.data) {
      if (!room.item.next) return jsonError(409, "There's no next episode.");
      ratingKey = room.item.next.ratingKey;
      autoStart = true;
      // The next episode lives on the room's server.
      if (session.selectedServer?.serverId !== room.item.serverId) {
        const r = await selectServer(session, room.item.serverId);
        if (!r.ok) return jsonError(502, `Couldn't reach ${room.item.serverName}.`);
      }
    } else {
      ratingKey = body.data.ratingKey;
      if (!session.selectedServer) return jsonError(409, "Select a Plex server first.");
    }
    const target = targetFor(session)!;
    // Re-read from Plex rather than trusting the browser's id.
    const picked = await getItem(target, ratingKey);
    if (!picked || !picked.playable) return jsonError(422, "Pick a movie or an episode that has a media file.");
    const { title, item } = await buildRoomItem(target, session.selectedServer!, picked);
    if (!changeItem(room.id, room.hostParticipantId, { title, item, autoStart })) {
      return jsonError(409, "Couldn't change the title.");
    }
    return Response.json({ ok: true, title }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "the new title");
  }
}
