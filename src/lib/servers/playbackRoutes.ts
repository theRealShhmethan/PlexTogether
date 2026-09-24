import "server-only";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { parseOffsetMs, startPlayback } from "@/lib/plex/playback";
import { getTracks, setTracks } from "@/lib/plex/tracks";
import { saveSession } from "@/lib/session/store";
import { noStore, pmsErrorResponse } from "./target";
import { browserConnections, locationFor, playbackConnection, resolveViewer } from "./viewer";

/**
 * Shared handlers for solo (/api/plex/playback/*) and room
 * (/api/rooms/<id>/playback/*) playback. `roomId` null = solo.
 */

/** POST start: a new Plex session at `offsetMs`, streamed from the connection the browser chose. */
export async function handleStart(request: Request, roomId: string | null): Promise<Response> {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const body = (await request.json().catch(() => ({}))) as { offsetMs?: unknown; connectionIndex?: unknown };
  const viewer = await resolveViewer(roomId);
  if (viewer instanceof Response) return viewer;
  const { session, target, ratingKey, durationMs } = viewer;
  const conn = playbackConnection(session, body?.connectionIndex);
  const location = locationFor(conn);
  try {
    const start = await startPlayback(target, { ratingKey, location, offsetMs: parseOffsetMs(body?.offsetMs) }, conn.uri);
    session.playback = { sessionId: start.sessionId, ratingKey, durationMs, startedAt: Date.now() };
    saveSession(session);
    return Response.json({ ...start, location }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "playback");
  }
}

/**
 * GET connections: the server's advertised addresses, for the browser to probe.
 * These are this viewer's own server addresses (the playlist URL contains one anyway).
 */
export async function handleConnections(roomId: string | null): Promise<Response> {
  const viewer = await resolveViewer(roomId);
  if (viewer instanceof Response) return viewer;
  const list = browserConnections(viewer.session).map((c, index) => ({
    index,
    uri: c.uri,
    protocol: c.protocol,
    local: c.local,
    relay: c.relay,
  }));
  return Response.json({ serverId: viewer.session.selectedServer!.serverId, connections: list }, { headers: noStore });
}

/** GET tracks: audio and subtitle choices for the item. */
export async function handleGetTracks(roomId: string | null): Promise<Response> {
  const viewer = await resolveViewer(roomId);
  if (viewer instanceof Response) return viewer;
  try {
    return Response.json(await getTracks(viewer.target, viewer.ratingKey), { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "audio and subtitle tracks");
  }
}

const TrackBody = z.object({
  audioStreamId: z.number().int().positive().optional(),
  // 0 = subtitles off (documented).
  subtitleStreamId: z.number().int().min(0).optional(),
});

/** POST tracks: select audio/subtitles (saved on the Plex account, like Plex's own apps do). */
export async function handleSetTracks(request: Request, roomId: string | null): Promise<Response> {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const body = TrackBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid track selection");
  const viewer = await resolveViewer(roomId);
  if (viewer instanceof Response) return viewer;
  try {
    const result = await setTracks(viewer.target, viewer.ratingKey, body.data);
    if (!result.ok) return jsonError(400, result.error);
    return Response.json(result.tracks, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "the track selection");
  }
}
