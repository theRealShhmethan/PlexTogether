import { jsonError } from "@/lib/http/security";
import { getItem, listEpisodes, PlexIdSchema } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";

/** One item's details; for a show, also its episodes. */
export async function GET(_request: Request, ctx: RouteContext<"/api/plex/items/[ratingKey]">) {
  const { ratingKey } = await ctx.params;
  if (!PlexIdSchema.safeParse(ratingKey).success) return jsonError(400, "Invalid item id");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  try {
    const item = await getItem(host.target, ratingKey);
    if (!item) return jsonError(404, "That item isn't a movie, show or episode.");
    const episodes = item.type === "show" ? await listEpisodes(host.target, ratingKey) : null;
    return Response.json({ item, episodes }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "item details");
  }
}
