import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { leaveRoom, resolveGuest } from "@/lib/rooms/hub";
import { COOKIE_GUEST } from "@/lib/session/cookies";

/** A guest leaves the room; their seat cookie stops working. */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/leave">) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const { roomId } = await ctx.params;
  const store = await cookies();
  const guest = resolveGuest(store.get(COOKIE_GUEST)?.value);
  if (guest && guest.room.id === roomId) leaveRoom(roomId, guest.participant.id);
  store.delete(COOKIE_GUEST);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
