import "server-only";
import { cookies } from "next/headers";
import { jsonError } from "@/lib/http/security";
import type { PmsTarget } from "@/lib/plex/pms";
import type { PlexConnection } from "@/lib/plex/resources";
import { getRoom, resolveGuest } from "@/lib/rooms/hub";
import { RoomIdSchema } from "@/lib/rooms/protocol";
import { COOKIE_GUEST } from "@/lib/session/cookies";
import { getCurrentSession } from "@/lib/session/host";
import type { HostSession } from "@/lib/session/store";
import { selectServer } from "./service";
import { noStore, targetFor } from "./target";

/**
 * Who is watching what, for playback routes. Two cases:
 *  - solo (/watch): the signed-in host and their picked item;
 *  - room: a participant (host session or guest seat) watching the room's
 *    item with THEIR OWN Plex sign-in in this browser (see
 *    docs/ARCHITECTURE.md §4, Option A). Nobody gets anyone else's token.
 */
export type Viewer = {
  session: HostSession;
  target: PmsTarget;
  ratingKey: string;
  durationMs: number | null;
};

export async function resolveViewer(roomId: string | null): Promise<Viewer | Response> {
  const session = await getCurrentSession();

  if (roomId === null) {
    if (!session) return jsonError(401, "Not signed in");
    const item = session.selectedItem;
    if (!session.selectedServer) return jsonError(409, "Select a Plex Media Server first");
    if (!item) return jsonError(409, "Pick a movie or episode on the Browse page first.");
    return { session, target: targetFor(session)!, ratingKey: item.ratingKey, durationMs: item.durationMs };
  }

  const room = RoomIdSchema.safeParse(roomId).success ? getRoom(roomId) : undefined;
  if (!room) return jsonError(404, "This watch party has ended.");
  const isHost = !!session && session.id === room.hostSessionId;
  const guest = isHost ? undefined : resolveGuest((await cookies()).get(COOKIE_GUEST)?.value);
  if (!isHost && guest?.room.id !== room.id) return jsonError(403, "You're not in this watch party.");
  if (!session) {
    return Response.json(
      { error: "Sign in with Plex to watch.", needsPlex: true, serverName: room.item.serverName },
      { status: 401, headers: noStore },
    );
  }
  // Make sure this participant's session points at the room's server.
  if (session.selectedServer?.serverId !== room.item.serverId) {
    const selected = await selectServer(session, room.item.serverId);
    if (!selected.ok) {
      return jsonError(
        403,
        selected.error === "unknown-server"
          ? `Your Plex account can't see ${room.item.serverName}. Ask the host to share the library with you in Plex.`
          : `Couldn't connect to ${room.item.serverName} from here.`,
      );
    }
  }
  return { session, target: targetFor(session)!, ratingKey: room.item.ratingKey, durationMs: room.item.durationMs };
}

/** The selected server's connections, as offered to the browser to probe. */
export function browserConnections(session: HostSession): PlexConnection[] {
  const s = session.selectedServer!;
  return s.connections?.length ? s.connections : [s.connection];
}

/**
 * The connection the browser asked to stream from (by index into
 * browserConnections), or the server-side one if none/invalid.
 */
export function playbackConnection(session: HostSession, index: unknown): PlexConnection {
  const list = browserConnections(session);
  return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < list.length
    ? list[index]
    : session.selectedServer!.connection;
}

export const locationFor = (c: PlexConnection): "lan" | "wan" => (c.local && !c.relay ? "lan" : "wan");
