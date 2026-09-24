import { handleStart } from "@/lib/servers/playbackRoutes";

/**
 * Starts this participant's own Plex stream of the room's item, with their
 * own Plex sign-in (see src/lib/servers/viewer.ts). A guest without one gets
 * 401 + needsPlex and is asked to sign in.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/start">) {
  return handleStart(request, (await ctx.params).roomId);
}
