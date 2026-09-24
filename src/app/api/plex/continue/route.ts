import { continueWatching } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";

/** The signed-in account's Continue Watching row on the selected server. */
export async function GET() {
  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  try {
    return Response.json({ items: await continueWatching(host.target) }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "Continue Watching");
  }
}
