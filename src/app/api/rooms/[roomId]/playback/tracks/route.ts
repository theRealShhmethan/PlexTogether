import { handleGetTracks, handleSetTracks } from "@/lib/servers/playbackRoutes";

/** Audio/subtitle tracks for the room's item; each participant chooses their own. */
export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/tracks">) {
  return handleGetTracks((await ctx.params).roomId);
}

export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/tracks">) {
  return handleSetTracks(request, (await ctx.params).roomId);
}
