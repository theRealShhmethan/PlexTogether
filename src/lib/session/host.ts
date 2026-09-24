import "server-only";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { refreshPlexJwt } from "@/lib/plex/auth";
import type { PlexClientInfo } from "@/lib/plex/client";
import { COOKIE_SESSION } from "./cookies";
import { getSession, saveSession, type HostSession } from "./store";

/** Refresh the Plex JWT when it has less than this long left. */
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
 * Returns a usable Plex JWT for the session, refreshing it if it is close to
 * (or past) expiry. Plex allows refresh even after expiry.
 * The returned token must only be used for server-side requests.
 */
export async function getFreshPlexJwt(session: HostSession): Promise<string> {
  if (session.plexJwtExpiresAt - Date.now() > REFRESH_WINDOW_MS) return session.plexJwt;
  const { plexJwt, expiresAt } = await refreshPlexJwt(plexClientFor(session.clientIdentifier), session.deviceKey);
  session.plexJwt = plexJwt;
  session.plexJwtExpiresAt = expiresAt;
  saveSession(session);
  return plexJwt;
}
