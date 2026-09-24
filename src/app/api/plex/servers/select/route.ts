import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { PlexApiError } from "@/lib/plex/client";
import { selectServer, toPublicProbe, toPublicSelection } from "@/lib/servers/service";
import { getCurrentSession } from "@/lib/session/host";

// Server ids are Plex machine identifiers (hex-ish); only ids from the host's
// own server list are accepted — never a URL or address from the browser.
const BodySchema = z.object({ serverId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

const MESSAGES = {
  "unknown-server": "That server isn't on your Plex account (try reloading the list).",
  "no-access": "Plex didn't provide an access token for this server.",
  "no-connections": "Plex doesn't list any connections for this server. Is it online?",
  unreachable: "Couldn't reach this server on any of its connections.",
} as const;

/** Selects a server and verifies connectivity (also used to re-check). */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid server id");

  try {
    const result = await selectServer(session, body.data.serverId);
    const probes = result.probes.map(toPublicProbe);
    if (!result.ok) {
      const status = result.error === "unknown-server" ? 404 : 502;
      return Response.json(
        { error: MESSAGES[result.error], probes },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { selected: toPublicSelection(result.selection), probes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof PlexApiError) {
      console.error(`[servers] ${err.endpoint} failed: ${err.message}`);
      return jsonError(502, `Plex request failed: ${err.message}`);
    }
    throw err;
  }
}
