import { randomBytes } from "node:crypto";
import type { DeviceKey } from "@/lib/plex/deviceKey";
import type { PlexConnection, PlexServer } from "@/lib/plex/resources";
import type { PlexUser } from "@/lib/plex/schemas";

/**
 * In-memory session store (v0.1). Everything is lost when the process
 * restarts, which simply means the host signs in again.
 *
 * SECURITY: this is the ONLY place the host's Plex JWT and device private key
 * live. Browsers receive an opaque random session id in an HttpOnly cookie;
 * they never receive the token or the key.
 */

/** A login started but not yet completed on app.plex.tv. */
export type PendingLogin = {
  id: string;
  clientIdentifier: string;
  deviceKey: DeviceKey;
  pinId: number;
  expiresAt: number;
};

export type HostSession = {
  id: string;
  clientIdentifier: string;
  deviceKey: DeviceKey;
  plexJwt: string;
  plexJwtExpiresAt: number;
  user: PlexUser;
  createdAt: number;
  expiresAt: number;
  /** Last server list from plex.tv (contains per-server access tokens). */
  servers?: PlexServer[];
  selectedServer?: SelectedServer;
};

/** The host's chosen PMS and the connection verified to work from here. */
export type SelectedServer = {
  serverId: string;
  name: string;
  owned: boolean;
  ownerName: string | null;
  version: string | null;
  /** SECURITY: PMS credential. Server-side only. */
  accessToken: string;
  connection: PlexConnection;
  latencyMs: number;
  checkedAt: number;
};

export const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 256 bits from the OS CSPRNG, URL-safe. */
export function randomId(): string {
  return randomBytes(32).toString("base64url");
}

type Stores = {
  pending: Map<string, PendingLogin>;
  sessions: Map<string, HostSession>;
};

// Kept on globalThis so Next.js dev-mode module reloads share one store.
const globalStores = globalThis as typeof globalThis & { __plexTogetherStores?: Stores };
const stores: Stores = (globalStores.__plexTogetherStores ??= {
  pending: new Map(),
  sessions: new Map(),
});

function sweep(now = Date.now()) {
  for (const [id, p] of stores.pending) if (p.expiresAt <= now) stores.pending.delete(id);
  for (const [id, s] of stores.sessions) if (s.expiresAt <= now) stores.sessions.delete(id);
}

export function savePendingLogin(p: PendingLogin): void {
  sweep();
  stores.pending.set(p.id, p);
}

export function getPendingLogin(id: string | undefined): PendingLogin | undefined {
  if (!id) return undefined;
  sweep();
  return stores.pending.get(id);
}

export function deletePendingLogin(id: string): void {
  stores.pending.delete(id);
}

export function saveSession(s: HostSession): void {
  sweep();
  stores.sessions.set(s.id, s);
}

export function getSession(id: string | undefined): HostSession | undefined {
  if (!id) return undefined;
  sweep();
  return stores.sessions.get(id);
}

export function deleteSession(id: string): void {
  stores.sessions.delete(id);
}

/** Test helper. */
export function _resetStores(): void {
  stores.pending.clear();
  stores.sessions.clear();
}
