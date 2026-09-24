import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { createRoom, roomForHost } from "@/lib/rooms/hub";
import { buildRoomItem } from "@/lib/rooms/roomItem";
import { targetFor } from "@/lib/servers/target";
import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

const noStore = { "Cache-Control": "no-store" } as const;

/** The signed-in host's active room, if any. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  const room = roomForHost(session.id);
  return Response.json({ roomId: room?.id ?? null, title: room?.title ?? null }, { headers: noStore });
}

/** Creates a watch party for the host's current pick (replacing any previous room). */
export async function POST(request: Request) {
  const config = getConfig();
  if (!isSameOrigin(request, config.appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  if (!session.selectedServer || !session.selectedItem) {
    return jsonError(409, "Pick a movie or episode first.");
  }
  const { title, item } = await buildRoomItem(targetFor(session)!, session.selectedServer, session.selectedItem);
  const user = toPublicUser(session);
  const result = createRoom({ hostSessionId: session.id, hostName: user.profile ?? user.displayName, title, item });
  if (!result.ok) return jsonError(503, result.error);
  return Response.json(
    { roomId: result.room.id, inviteUrl: `${config.appOrigin}/r/${result.room.id}` },
    { headers: noStore },
  );
}
