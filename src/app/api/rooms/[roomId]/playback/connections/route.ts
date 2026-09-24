import { handleConnections } from "@/lib/servers/playbackRoutes";

/** The room server's addresses (as this participant's account sees them), for the browser to probe. */
export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[roomId]/playback/connections">) {
  return handleConnections((await ctx.params).roomId);
}
