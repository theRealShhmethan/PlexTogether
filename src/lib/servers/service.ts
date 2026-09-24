import "server-only";
import { connectionKind, probeAll, type ProbeFailure, type ProbeResult } from "@/lib/plex/connectivity";
import { fetchServers, type PlexServer } from "@/lib/plex/resources";
import { getFreshPlexToken, plexClientFor } from "@/lib/session/host";
import { saveSession, type HostSession, type SelectedServer } from "@/lib/session/store";

/**
 * Server discovery + selection for a signed-in host. Everything returned by
 * the `toPublic*` functions is safe for the browser: no tokens, and no
 * connection addresses (the host doesn't need them, and a shared server's
 * addresses belong to its owner).
 */

export type PublicServer = {
  id: string;
  name: string;
  owned: boolean;
  ownerName: string | null;
  version: string | null;
  platform: string | null;
  online: boolean | null;
  hasAccess: boolean;
  connections: { local: number; remote: number; relay: number };
};

export type PublicConnection = { kind: "local" | "remote" | "relay"; protocol: "http" | "https"; ipv6: boolean };

export type PublicProbe = PublicConnection & ({ ok: true; latencyMs: number } | { ok: false; reason: ProbeFailure });

export type PublicSelection = {
  serverId: string;
  name: string;
  owned: boolean;
  ownerName: string | null;
  version: string | null;
  connection: PublicConnection;
  latencyMs: number;
  checkedAt: number;
};

export async function listServers(session: HostSession): Promise<PlexServer[]> {
  const token = await getFreshPlexToken(session);
  const servers = await fetchServers(plexClientFor(session.clientIdentifier), token);
  session.servers = servers;
  // Drop a selection whose server has disappeared from the account.
  if (session.selectedServer && !servers.some((s) => s.id === session.selectedServer!.serverId)) {
    session.selectedServer = undefined;
  }
  saveSession(session);
  return servers;
}

export type SelectResult =
  | { ok: true; selection: SelectedServer; probes: ProbeResult[] }
  | { ok: false; error: "unknown-server" | "no-access" | "no-connections" | "unreachable"; probes: ProbeResult[] };

export async function selectServer(session: HostSession, serverId: string): Promise<SelectResult> {
  const servers = session.servers ?? (await listServers(session));
  const server = servers.find((s) => s.id === serverId);
  if (!server) return { ok: false, error: "unknown-server", probes: [] };
  if (!server.accessToken) return { ok: false, error: "no-access", probes: [] };
  if (server.connections.length === 0) return { ok: false, error: "no-connections", probes: [] };

  const probes = await probeAll(
    plexClientFor(session.clientIdentifier),
    server.connections,
    server.id,
    server.accessToken,
  );
  const best = probes[0];
  if (!best?.ok) return { ok: false, error: "unreachable", probes };

  const selection: SelectedServer = {
    serverId: server.id,
    name: server.name,
    owned: server.owned,
    ownerName: server.ownerName,
    version: best.version ?? server.version,
    accessToken: server.accessToken,
    connection: best.connection,
    latencyMs: best.latencyMs,
    checkedAt: Date.now(),
  };
  session.selectedServer = selection;
  saveSession(session);
  return { ok: true, selection, probes };
}

export function toPublicServer(s: PlexServer): PublicServer {
  const connections = { local: 0, remote: 0, relay: 0 };
  for (const c of s.connections) connections[connectionKind(c)]++;
  return {
    id: s.id,
    name: s.name,
    owned: s.owned,
    ownerName: s.ownerName,
    version: s.version,
    platform: s.platform,
    online: s.online,
    hasAccess: s.accessToken !== null,
    connections,
  };
}

function toPublicConnection(c: SelectedServer["connection"]): PublicConnection {
  return { kind: connectionKind(c), protocol: c.protocol, ipv6: c.IPv6 };
}

export function toPublicProbe(p: ProbeResult): PublicProbe {
  const base = toPublicConnection(p.connection);
  return p.ok ? { ...base, ok: true, latencyMs: p.latencyMs } : { ...base, ok: false, reason: p.reason };
}

export function toPublicSelection(s: SelectedServer): PublicSelection {
  return {
    serverId: s.serverId,
    name: s.name,
    owned: s.owned,
    ownerName: s.ownerName,
    version: s.version,
    connection: toPublicConnection(s.connection),
    latencyMs: s.latencyMs,
    checkedAt: s.checkedAt,
  };
}
