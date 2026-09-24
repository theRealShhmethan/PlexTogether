import { getConfig } from "@/lib/config";
import { itemHeading } from "@/lib/format/item";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { getItem } from "@/lib/plex/library";
import { createRoom, roomForHost } from "@/lib/rooms/hub";
import { targetFor } from "@/lib/servers/target";
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
  // Re-read the item so the room starts at the host's current Plex resume point.
  let item = session.selectedItem;
  try {
    item = (await getItem(targetFor(session)!, item.ratingKey)) ?? item;
  } catch {
    /* use the stored copy */
  }
  const user = toPublicUser(session);
  const result = createRoom({
    hostSessionId: session.id,
    hostName: user.profile ?? user.displayName,
    title: itemHeading(item),
    item: {
      ratingKey: item.ratingKey,
      serverId: session.selectedServer.serverId,
      serverName: session.selectedServer.name,
      durationMs: item.durationMs,
      // Ignore a resume point in the first minute or the last few (Plex treats those as unwatched/finished).
      resumeMs:
        item.viewOffsetMs && item.viewOffsetMs > 60_000 && (!item.durationMs || item.viewOffsetMs < item.durationMs - 180_000)
          ? item.viewOffsetMs
          : null,
    },
  });
  if (!result.ok) return jsonError(503, result.error);
  return Response.json(
    { roomId: result.room.id, inviteUrl: `${config.appOrigin}/r/${result.room.id}` },
    { headers: noStore },
  );
}
