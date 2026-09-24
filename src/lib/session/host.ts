import "server-only";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { refreshPlexJwt } from "@/lib/plex/auth";
import type { PlexClientInfo } from "@/lib/plex/client";
import { COOKIE_SESSION } from "./cookies";
import { getSession, saveSession, type HostSession } from "./store";

/** Refresh a Plex JWT when it has less than this long left. */
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export function plexClientFor(clientIdentifier: string): PlexClientInfo {
  const { productName, productVersion } = getConfig();
  return { clientIdentifier, product: productName, version: productVersion };
}

export async function getCurrentSession(): Promise<HostSession | undefined> {
  const store = await cookies();
  return getSession(store.get(COOKIE_SESSION)?.value);
}

/**
 * Returns a usable plex.tv token for the session. Legacy tokens are returned
 * as-is; JWTs are refreshed when close to (or past) expiry — Plex allows
 * refresh even after expiry. Only use the result for server-side requests.
 */
export async function getFreshPlexToken(session: HostSession): Promise<string> {
  const cred = session.plex;
  if (cred.mode === "legacy") return cred.token;
  if (cred.expiresAt - Date.now() > REFRESH_WINDOW_MS) return cred.token;
  const { plexJwt, expiresAt } = await refreshPlexJwt(plexClientFor(session.clientIdentifier), cred.deviceKey);
  session.plex = { ...cred, token: plexJwt, expiresAt };
  saveSession(session);
  return plexJwt;
}
