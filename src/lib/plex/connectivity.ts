import { z } from "zod";
import { plexHeaders, type PlexClientInfo } from "./client";
import type { PlexConnection } from "./resources";

/**
 * Checks which of a server's advertised connections actually work *from
 * this PlexTogether server*, then picks the best one.
 *
 * Each probe:
 *   1. GET {uri}/identity (no token needed) and confirm `machineIdentifier`
 *      matches the server we expect, so we never send the token to the wrong host.
 *   2. Only then GET {uri}/ with the token, to prove the token is accepted.
 *
 * PLEX NOTE: `local` means the server's LAN address, which is only reachable
 * when we're on the same network. `https` URIs are *.plex.direct hostnames
 * that resolve to the server's IP; some routers block that ("DNS rebinding
 * protection"), in which case only plain-http local connections work.
 */

const PROBE_TIMEOUT_MS = 5000;

export type ConnectionKind = "local" | "remote" | "relay";

export type ProbeResult =
  | { ok: true; connection: PlexConnection; latencyMs: number; version: string | null }
  | { ok: false; connection: PlexConnection; reason: ProbeFailure };

export type ProbeFailure = "unreachable" | "timeout" | "wrong-server" | "unauthorized" | "http-error" | "bad-response";

const IdentitySchema = z.object({
  MediaContainer: z.object({
    machineIdentifier: z.string(),
    version: z.string().optional(),
  }),
});

export function connectionKind(c: PlexConnection): ConnectionKind {
  if (c.relay) return "relay";
  return c.local ? "local" : "remote";
}

/** Lower is better: local < remote < relay, https before http, IPv4 before IPv6. */
export function connectionRank(c: PlexConnection): number {
  const kind = { local: 0, remote: 10, relay: 20 }[connectionKind(c)];
  return kind + (c.protocol === "https" ? 0 : 2) + (c.IPv6 ? 1 : 0);
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

function failureFromError(err: unknown): ProbeFailure {
  return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable";
}

export async function probeConnection(
  client: PlexClientInfo,
  connection: PlexConnection,
  expectedMachineId: string,
  accessToken: string,
): Promise<ProbeResult> {
  const base = connection.uri.replace(/\/+$/, "");
  const started = performance.now();

  let identityRes: Response;
  try {
    identityRes = await timedFetch(`${base}/identity`, { headers: plexHeaders(client) });
  } catch (err) {
    return { ok: false, connection, reason: failureFromError(err) };
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!identityRes.ok) return { ok: false, connection, reason: "http-error" };
  const identity = IdentitySchema.safeParse(await identityRes.json().catch(() => null));
  if (!identity.success) return { ok: false, connection, reason: "bad-response" };
  if (identity.data.MediaContainer.machineIdentifier !== expectedMachineId) {
    return { ok: false, connection, reason: "wrong-server" };
  }

  // Identity confirmed; now it is safe to present the token.
  let authRes: Response;
  try {
    authRes = await timedFetch(`${base}/`, { headers: plexHeaders(client, accessToken) });
  } catch (err) {
    return { ok: false, connection, reason: failureFromError(err) };
  }
  if (authRes.status === 401 || authRes.status === 403) return { ok: false, connection, reason: "unauthorized" };
  if (!authRes.ok) return { ok: false, connection, reason: "http-error" };
  await authRes.body?.cancel();

  return { ok: true, connection, latencyMs, version: identity.data.MediaContainer.version ?? null };
}

/** Probes all connections in parallel; results are sorted best-first. */
export async function probeAll(
  client: PlexClientInfo,
  connections: PlexConnection[],
  expectedMachineId: string,
  accessToken: string,
): Promise<ProbeResult[]> {
  const results = await Promise.all(
    connections.map((c) => probeConnection(client, c, expectedMachineId, accessToken)),
  );
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return connectionRank(a.connection) - connectionRank(b.connection);
  });
}
