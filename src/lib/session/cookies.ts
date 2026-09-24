import "server-only";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import type { PlexAuthMode } from "@/lib/plex/auth";

export { COOKIE_GUEST, COOKIE_PENDING, COOKIE_SESSION } from "./cookieNames";
/**
 * Stable, non-secret Plex client identifier for this browser, one per auth
 * mode. PLEX QUIRK (observed 2026-09-23): after an identifier had been used
 * for JWT sign-in, app.plex.tv refused a legacy PIN sign-in for it ("We were
 * unable to complete this request"), so the two modes never share one.
 * (The original `pt_cid` cookie was used by JWT sign-ins, so it is retired.)
 */
export function clientIdCookieName(mode: PlexAuthMode): string {
  return mode === "jwt" ? "pt_cid_jwt" : "pt_cid_legacy";
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * SECURITY: HttpOnly so page JavaScript can't read the session id; Secure in
 * production; SameSite=Lax so the cookie survives the top-level redirect back
 * from app.plex.tv but isn't sent on cross-site subrequests.
 */
export function setSecureCookie(store: CookieStore, name: string, value: string, maxAgeSeconds: number) {
  store.set(name, value, {
    httpOnly: true,
    secure: getConfig().isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}
