import "server-only";
import { jsonError } from "@/lib/http/security";
import { PlexApiError } from "@/lib/plex/client";
import type { PmsTarget } from "@/lib/plex/pms";
import { getCurrentSession, plexClientFor } from "@/lib/session/host";
import type { HostSession } from "@/lib/session/store";

export type HostContext = { session: HostSession; target: PmsTarget };

/**
 * Resolves the signed-in host and their selected server for a route handler,
 * or returns the error Response to send.
 */
export async function requireSelectedServer(): Promise<HostContext | Response> {
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  const selected = session.selectedServer;
  if (!selected) return jsonError(409, "Select a Plex Media Server first");
  return {
    session,
    target: {
      client: plexClientFor(session.clientIdentifier),
      baseUrl: selected.connection.uri,
      token: selected.accessToken,
    },
  };
}

/** Maps PMS failures to a JSON error without leaking URLs or tokens. */
export function pmsErrorResponse(err: unknown, what: string): Response {
  if (err instanceof PlexApiError) {
    console.error(`[library] ${err.endpoint} failed: ${err.message}`);
    if (err.status === 401 || err.status === 403) {
      return jsonError(502, `The server rejected our access token while loading ${what}. Try re-checking the server.`);
    }
    if (err.status === 404) return jsonError(404, `Not found on the server (${what}).`);
    return jsonError(502, `Could not load ${what} from the server: ${err.message}`);
  }
  throw err;
}

export const noStore = { "Cache-Control": "no-store" } as const;
