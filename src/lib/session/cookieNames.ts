/**
 * Cookie names, in a module without Next.js imports so the custom WebSocket
 * server (server.ts) can use them too.
 */
export const COOKIE_SESSION = "pt_session";
export const COOKIE_PENDING = "pt_login";
/** A guest's seat in a room: an opaque random secret, HttpOnly. */
export const COOKIE_GUEST = "pt_guest";

/** Minimal Cookie header parser (names/values are our own URL-safe tokens). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
