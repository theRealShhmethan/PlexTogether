import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { PlexApiError } from "@/lib/plex/client";
import { listHomeProfiles, ProfilePinSchema, switchHomeProfile } from "@/lib/plex/home";
import { getCurrentSession, getFreshPlexToken, plexClientFor } from "@/lib/session/host";
import { saveSession, type HostSession } from "@/lib/session/store";

const noStore = { "Cache-Control": "no-store" } as const;

function activeUuid(session: HostSession, profiles: { uuid: string; admin: boolean }[]): string | null {
  return session.profile?.uuid ?? profiles.find((p) => p.admin)?.uuid ?? null;
}

function plexError(err: unknown, action: string): Response {
  if (err instanceof PlexApiError) {
    console.error(`[profiles] ${err.endpoint} failed: ${err.message}`);
    return jsonError(502, `Could not ${action}: ${err.message}`);
  }
  throw err;
}

/** Plex Home profiles on the signed-in account (empty if it isn't a Plex Home). */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  try {
    const token = await getFreshPlexToken(session);
    const profiles = await listHomeProfiles(plexClientFor(session.clientIdentifier), token);
    return Response.json({ profiles, active: activeUuid(session, profiles) }, { headers: noStore });
  } catch (err) {
    return plexError(err, "load Plex Home profiles");
  }
}

const BodySchema = z.object({
  profileId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  pin: ProfilePinSchema.nullable().optional(),
});

/** Switches to a Home profile. The profile must come from the account's own list. */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const session = await getCurrentSession();
  if (!session) return jsonError(401, "Not signed in");
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid profile or PIN (PINs are 4 digits)");

  const client = plexClientFor(session.clientIdentifier);
  try {
    const accountToken = await getFreshPlexToken(session);
    const profiles = await listHomeProfiles(client, accountToken);
    const profile = profiles.find((p) => p.uuid === body.data.profileId);
    if (!profile) return jsonError(404, "That profile isn't in this Plex Home.");

    if (profile.admin) {
      // The admin profile is the signed-in account itself.
      session.profile = undefined;
    } else {
      if (profile.hasPin && !body.data.pin) return jsonError(422, `Enter the PIN for ${profile.title}.`);
      let token: string;
      try {
        token = await switchHomeProfile(client, accountToken, profile, body.data.pin ?? null);
      } catch (err) {
        if (err instanceof PlexApiError && (err.status === 401 || err.status === 403)) {
          return jsonError(403, profile.hasPin ? "Wrong PIN." : "Plex refused to switch to that profile.");
        }
        throw err;
      }
      session.profile = { uuid: profile.uuid, title: profile.title, token };
    }

    // Server tokens and picks belong to the previous profile.
    session.servers = undefined;
    session.selectedServer = undefined;
    session.selectedItem = undefined;
    saveSession(session);
    return Response.json({ active: profile.uuid }, { headers: noStore });
  } catch (err) {
    return plexError(err, "switch profile");
  }
}
