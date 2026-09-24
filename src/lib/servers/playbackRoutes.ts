import "server-only";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { parseOffsetMs, startPlayback } from "@/lib/plex/playback";
import { getTracks, preferredAudio, setTracks } from "@/lib/plex/tracks";
import { saveSession, type HostSession } from "@/lib/session/store";
import type { PmsTarget } from "@/lib/plex/pms";
import { noStore, pmsErrorResponse } from "./target";
import { browserConnections, locationFor, playbackConnection, resolveViewer } from "./viewer";

/**
 * Shared handlers for solo (/api/plex/playback/*) and room
 * (/api/rooms/<id>/playback/*) playback. `roomId` null = solo.
 */

const MAX_TRACK_PREFS = 200;

function rememberTrackPref(session: HostSession, ratingKey: string, how: "auto" | "manual") {
  const prefs = { ...(session.trackPrefs ?? {}) };
  delete prefs[ratingKey]; // re-insert so the newest are kept
  prefs[ratingKey] = how;
  const keys = Object.keys(prefs);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRACK_PREFS))) delete prefs[k];
  session.trackPrefs = prefs;
}

/**
 * The first time a viewer plays a title, switch to their preferred audio
 * language (English by default) if it isn't already selected. Never after
 * they've chosen tracks themselves. Best effort: failures don't block playback.
 */
async function applyPreferredAudio(session: HostSession, target: PmsTarget, ratingKey: string) {
  if (session.trackPrefs?.[ratingKey]) return;
  try {
    const choice = preferredAudio(await getTracks(target, ratingKey), getConfig().preferredAudio);
    if (choice !== null) await setTracks(target, ratingKey, { audioStreamId: choice });
    rememberTrackPref(session, ratingKey, "auto");
  } catch (err) {
    console.warn(`[tracks] couldn't apply the preferred audio language: ${err instanceof Error ? err.message : "error"}`);
  }
}

/** POST start: a new Plex session at `offsetMs`, streamed from the connection the browser chose. */
export async function handleStart(request: Request, roomId: string | null): Promise<Response> {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const body = (await request.json().catch(() => ({}))) as { offsetMs?: unknown; connectionIndex?: unknown };
  const viewer = await resolveViewer(roomId);
  if (viewer instanceof Response) return viewer;
  const { session, target, ratingKey, durationMs } = viewer;
  const conn = playbackConnection(session, body?.connectionIndex);
  const location = locationFor(conn);
  await applyPreferredAudio(session, target, ratingKey);
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
    rememberTrackPref(viewer.session, viewer.ratingKey, "manual");
    saveSession(viewer.session);
    return Response.json(result.tracks, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "the track selection");
  }
}
