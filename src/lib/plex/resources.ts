import { z } from "zod";
import { PLEX_CLIENTS_API } from "./constants";
import { plexHeaders, plexRequest, type PlexClientInfo } from "./client";

/**
 * Server discovery via `GET clients.plex.tv/api/v2/resources` ("Talking to
 * PMS" in https://developer.plex.tv/pms/). The docs describe the response only
 * in prose (servers, their `accessToken`, and connection URLs flagged `local`
 * / `relay`), so we validate just the fields we use and skip entries that
 * don't match instead of failing the whole list.
 *
 * SECURITY: `accessToken` is the credential for that PMS. For a server the
 * user owns it is admin-level; for a server shared with them it is limited to
 * what was shared. Either way it stays server-side.
 */

const ConnectionSchema = z.object({
  protocol: z.enum(["http", "https"]),
  address: z.string(),
  port: z.number().int(),
  uri: z.url(),
  local: z.boolean().default(false),
  relay: z.boolean().default(false),
  IPv6: z.boolean().default(false),
});
export type PlexConnection = z.infer<typeof ConnectionSchema>;

const ResourceSchema = z.object({
  name: z.string(),
  clientIdentifier: z.string().min(1),
  provides: z.string(),
  product: z.string().optional(),
  productVersion: z.string().optional(),
  platform: z.string().nullable().optional(),
  owned: z.boolean().default(false),
  // For shared servers: the owner's display name.
  sourceTitle: z.string().nullable().optional(),
  presence: z.boolean().optional(),
  accessToken: z.string().nullable().optional(),
  connections: z.array(ConnectionSchema).default([]),
});

export type PlexServer = {
  id: string;
  name: string;
  owned: boolean;
  ownerName: string | null;
  product: string | null;
  version: string | null;
  platform: string | null;
  online: boolean | null;
  accessToken: string | null;
  connections: PlexConnection[];
};

export async function fetchServers(client: PlexClientInfo, plexJwt: string): Promise<PlexServer[]> {
  const url = `${PLEX_CLIENTS_API}/resources?${new URLSearchParams({ includeHttps: "1", includeRelay: "1", includeIPv6: "1" })}`;
  const raw = await plexRequest(
    "resources",
    url,
    { method: "GET", headers: plexHeaders(client, plexJwt) },
    z.array(z.unknown()),
  );
  return parseServers(raw);
}

export function parseServers(raw: unknown[]): PlexServer[] {
  const servers: PlexServer[] = [];
  let skipped = 0;
  for (const item of raw) {
    const parsed = ResourceSchema.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const r = parsed.data;
    // Resources also include players/clients; only PMS instances "provide" server.
    if (!r.provides.split(",").includes("server")) continue;
    servers.push({
      id: r.clientIdentifier,
      name: r.name,
      owned: r.owned,
      ownerName: r.owned ? null : (r.sourceTitle ?? null),
      product: r.product ?? null,
      version: r.productVersion ?? null,
      platform: r.platform ?? null,
      online: r.presence ?? null,
      accessToken: r.accessToken ?? null,
      connections: r.connections,
    });
  }
  // Log the count only — the entries themselves contain tokens.
  if (skipped > 0) console.warn(`[servers] skipped ${skipped} resource(s) with an unexpected shape`);
  return servers;
}
