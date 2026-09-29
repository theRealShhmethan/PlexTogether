import { handleDownloadSubtitle, handleSearchSubtitles } from "@/lib/servers/playbackRoutes";

/** Find subtitles online for the room's title (GET), and download one (POST). */
export async function GET(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/subtitles">) {
  return handleSearchSubtitles(request, (await ctx.params).roomId);
}

export async function POST(request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/subtitles">) {
  return handleDownloadSubtitle(request, (await ctx.params).roomId);
}
