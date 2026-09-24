import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { endRoom, getRoom } from "@/lib/rooms/hub";
import { getCurrentSession } from "@/lib/session/host";

/** The host ends the room: everyone is disconnected and all guest seats stop working. */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/end">) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const { roomId } = await ctx.params;
  const session = await getCurrentSession();
  const room = getRoom(roomId);
  if (!room) return Response.json({ ok: true });
  if (!session || session.id !== room.hostSessionId) return jsonError(403, "Only the host can end the room.");
  endRoom(roomId, "host-ended");
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
