/**
 * Adds the transient Plex token to a media request URL, but only when the
 * URL is on the Plex server's own origin, so the token is never sent anywhere
 * else (e.g. if a playlist ever referenced another host).
 */
export function withToken(url: string, pmsOrigin: string, token: string): string {
  const u = new URL(url);
  if (u.origin === pmsOrigin) u.searchParams.set("X-Plex-Token", token);
  return u.toString();
}
