import { handleStart } from "@/lib/servers/playbackRoutes";

/**
 * Starts host playback of the item picked for the watch party. Only that item
 * can be started — the browser can't name arbitrary media.
 *
 * SECURITY: returns a *transient* PMS token (≤48 h) for the host's own
 * player. The long-lived server token never leaves the server.
 */
export async function POST(request: Request) {
  return handleStart(request, null);
}
