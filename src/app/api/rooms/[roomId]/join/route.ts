import { cookies } from "next/headers";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { getRoom, joinRoom } from "@/lib/rooms/hub";
import { DisplayNameSchema, RoomIdSchema } from "@/lib/rooms/protocol";
import { COOKIE_GUEST, setSecureCookie } from "@/lib/session/cookies";
import { getCurrentSession } from "@/lib/session/host";

const BodySchema = z.object({ name: DisplayNameSchema });

/**
 * A guest joins with just a display name — no account. They get an opaque,
 * HttpOnly seat cookie that only works for this room and dies with it.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/join">) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const { roomId } = await ctx.params;
  if (!RoomIdSchema.safeParse(roomId).success) return jsonError(404, "This watch party doesn't exist.");

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, body.error.issues[0]?.message ?? "Invalid name");

  // The host is already in their own room.
  const session = await getCurrentSession();
  const room = getRoom(roomId);
  if (room && session?.id === room.hostSessionId) return Response.json({ ok: true, host: true });

  const store = await cookies();
  const result = joinRoom(roomId, body.data.name, store.get(COOKIE_GUEST)?.value);
  if (!result.ok) return jsonError(409, result.error);

  const secondsLeft = Math.max(60, Math.floor(((room?.expiresAt ?? Date.now()) - Date.now()) / 1000));
  setSecureCookie(store, COOKIE_GUEST, result.secret, secondsLeft);
  return Response.json({ ok: true, host: false }, { headers: { "Cache-Control": "no-store" } });
}
