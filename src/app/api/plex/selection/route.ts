import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { getItem, PlexIdSchema } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";
import { saveSession } from "@/lib/session/store";

const BodySchema = z.object({ ratingKey: PlexIdSchema });

/** The movie/episode the host has picked for the watch party. */
export async function GET() {
  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  return Response.json({ item: host.session.selectedItem ?? null }, { headers: noStore });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid item id");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  try {
    // Re-read from the server rather than trusting anything the browser sent.
    const item = await getItem(host.target, body.data.ratingKey);
    if (!item || !item.playable) return jsonError(422, "Pick a movie or an episode that has a media file.");
    host.session.selectedItem = item;
    saveSession(host.session);
    return Response.json({ item }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "the selected item");
  }
}
