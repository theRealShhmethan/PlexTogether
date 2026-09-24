import type { HostSession } from "./store";

/**
 * The only account data that is sent to the browser. Keep this an explicit
 * allowlist — never spread the session or the Plex user object.
 */
export type PublicUser = {
  displayName: string;
  username: string | null;
  /** null when Plex didn't say. Relevant to Plex's remote-playback rules. */
  plexPass: boolean | null;
};

export function toPublicUser(session: HostSession): PublicUser {
  const u = session.user;
  return {
    displayName: u.friendlyName || u.title || u.username || "Plex user",
    username: u.username ?? null,
    plexPass: u.subscription?.active ?? null,
  };
}
