import { z } from "zod";
import { PLEX_CLIENTS_API } from "./constants";
import { plexHeaders, plexRequest, PlexApiError, type PlexClientInfo } from "./client";

/**
 * Plex Home profiles ("switch user").
 *
 * UNDOCUMENTED: these plex.tv endpoints are not in Plex's official developer
 * docs (which only cover the media server). They are what Plex's own apps use
 * and are relied on by the widely used python-plexapi library. Verified to
 * exist on 2026-09-23 (401 without a token, vs 404 for unknown routes).
 * Response shapes are validated loosely; anything unexpected fails loudly.
 *
 *   GET  /api/v2/home/users                 → the Home's profiles
 *   POST /api/v2/home/users/{id}/switch     → a token for that profile
 *
 * SECURITY: a switched-to profile's token only has that profile's access
 * (a managed profile is limited to the libraries it's allowed). It is kept
 * server-side like every other token.
 */

const HomeUserSchema = z
  .object({
    id: z.number().int(),
    uuid: z.string().min(1),
    title: z.string(),
    username: z.string().nullable().optional(),
    admin: z.boolean().default(false),
    guest: z.boolean().default(false),
    restricted: z.boolean().default(false),
    // true when the profile has a PIN.
    protected: z.boolean().default(false),
  })
  .loose();

const HomeUsersResponseSchema = z.union([
  z.object({ users: z.array(z.unknown()) }).loose(),
  z.array(z.unknown()),
]);

const SwitchResponseSchema = z
  .object({
    authToken: z.string().min(1).optional(),
    authenticationToken: z.string().min(1).optional(),
  })
  .loose();

export type HomeProfile = {
  id: number;
  uuid: string;
  title: string;
  admin: boolean;
  restricted: boolean;
  hasPin: boolean;
};

export const ProfilePinSchema = z.string().regex(/^\d{4}$/);

export async function listHomeProfiles(client: PlexClientInfo, accountToken: string): Promise<HomeProfile[]> {
  const res = await plexRequest(
    "home-users",
    `${PLEX_CLIENTS_API}/home/users`,
    { method: "GET", headers: plexHeaders(client, accountToken) },
    HomeUsersResponseSchema,
  );
  const raw = Array.isArray(res) ? res : res.users;
  const profiles: HomeProfile[] = [];
  for (const entry of raw) {
    const u = HomeUserSchema.safeParse(entry);
    // Guest profiles can't be switched to meaningfully; skip them.
    if (!u.success || u.data.guest) continue;
    profiles.push({
      id: u.data.id,
      uuid: u.data.uuid,
      title: u.data.title,
      admin: u.data.admin,
      restricted: u.data.restricted,
      hasPin: u.data.protected,
    });
  }
  return profiles;
}

/**
 * Returns the switched-to profile's token. Tries the profile's uuid first,
 * then its numeric id — which one v2 expects isn't documented.
 */
export async function switchHomeProfile(
  client: PlexClientInfo,
  accountToken: string,
  profile: HomeProfile,
  pin: string | null,
): Promise<string> {
  // The PIN goes as a query parameter, as python-plexapi sends it. HTTPS only; never logged here.
  const query = pin ? `?${new URLSearchParams({ pin })}` : "";
  let lastError: unknown;
  for (const id of [profile.uuid, String(profile.id)]) {
    try {
      const res = await plexRequest(
        "home-switch",
        `${PLEX_CLIENTS_API}/home/users/${encodeURIComponent(id)}/switch${query}`,
        { method: "POST", headers: plexHeaders(client, accountToken) },
        SwitchResponseSchema,
      );
      const token = res.authToken ?? res.authenticationToken;
      if (!token) throw new PlexApiError("home-switch", 200, "Plex didn't return a token for that profile");
      return token;
    } catch (err) {
      lastError = err;
      // Only retry with the other id form when this one wasn't recognised.
      if (!(err instanceof PlexApiError) || (err.status !== 404 && err.status !== 400)) throw err;
    }
  }
  throw lastError;
}
