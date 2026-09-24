import { z } from "zod";
import { jsonError } from "@/lib/http/security";
import { listSectionItems, PlexIdSchema } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";

const PAGE_SIZE = 60;
const StartSchema = z.coerce.number().int().min(0).max(1_000_000).default(0);

/** One page of a library's items (movies, or shows). */
export async function GET(request: Request, ctx: RouteContext<"/api/plex/libraries/[sectionId]/items">) {
  const { sectionId } = await ctx.params;
  if (!PlexIdSchema.safeParse(sectionId).success) return jsonError(400, "Invalid library id");
  const start = StartSchema.safeParse(new URL(request.url).searchParams.get("start") ?? undefined);
  if (!start.success) return jsonError(400, "Invalid start");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  try {
    const page = await listSectionItems(host.target, sectionId, { start: start.data, size: PAGE_SIZE });
    return Response.json(page, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "library items");
  }
}
