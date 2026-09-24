import { jsonError } from "@/lib/http/security";
import { PlexApiError } from "@/lib/plex/client";
import { listServers, toPublicSelection, toPublicServer } from "@/lib/servers/service";
import { getCurrentSession } from "@/lib/session/host";

/** Lists the Plex Media Servers the signed-in host can access. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  try {
    const servers = await listServers(session);
    return Response.json(
      {
        servers: servers.map(toPublicServer),
        selected: session.selectedServer ? toPublicSelection(session.selectedServer) : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof PlexApiError) {
      console.error(`[servers] ${err.endpoint} failed: ${err.message}`);
      return jsonError(502, `Could not load servers from Plex: ${err.message}`);
    }
    throw err;
  }
}
