import { getConfig } from "@/lib/config";
import { itemHeading } from "@/lib/format/item";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { createRoom, roomForHost } from "@/lib/rooms/hub";
import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

const noStore = { "Cache-Control": "no-store" } as const;

/** The signed-in host's active room, if any. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  const room = roomForHost(session.id);
  return Response.json({ roomId: room?.id ?? null }, { headers: noStore });
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
  const user = toPublicUser(session);
  const result = createRoom({
    hostSessionId: session.id,
    hostName: user.profile ?? user.displayName,
    title: itemHeading(session.selectedItem),
    item: {
      ratingKey: session.selectedItem.ratingKey,
      serverId: session.selectedServer.serverId,
      serverName: session.selectedServer.name,
      durationMs: session.selectedItem.durationMs,
    },
  });
  if (!result.ok) return jsonError(503, result.error);
  return Response.json(
    { roomId: result.room.id, inviteUrl: `${config.appOrigin}/r/${result.room.id}` },
    { headers: noStore },
  );
}
