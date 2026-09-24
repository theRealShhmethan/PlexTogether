import "server-only";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";

export const COOKIE_SESSION = "pt_session";
export const COOKIE_PENDING = "pt_login";
/** Stable, non-secret Plex client identifier for this browser. */
export const COOKIE_CLIENT_ID = "pt_cid";

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
