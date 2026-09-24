import { decodeJwt } from "jose";
import { PLEX_AUTH_APP, PLEX_CLIENTS_API, PLEX_JWT_LIFETIME_MS, PLEX_JWT_SCOPE, PLEX_TV_API } from "./constants";
import { plexHeaders, plexRequest, PlexApiError, type PlexClientInfo } from "./client";
import { signDeviceJwt, type DeviceKey } from "./deviceKey";
import { NonceSchema, PinSchema, PlexUserSchema, TokenExchangeSchema, type Pin, type PlexUser } from "./schemas";

/**
 * Plex PIN sign-in, per the official docs:
 * https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex
 *
 * Both modes send the user to app.plex.tv to sign in — we never see their
 * password — and then read the token off the claimed PIN.
 *
 * - "legacy" (default): the documented "Traditional Token Authentication".
 *   Long-lived token, accepted by Plex Media Server.
 * - "jwt": the documented, recommended JWT flow (Ed25519 device key, 7-day
 *   tokens). PLEX ISSUE (as of 2026-09): PMS rejects JWTs with 401, and
 *   /resources returns JWT server tokens when called with a JWT, so a JWT
 *   session can't talk to any server. Seen on PMS 1.42.1 here and reported
 *   by other developers since 2025-12 with no staff answer:
 *   https://forums.plex.tv/t/question-on-https-clients-plex-tv-api-v2-resources-and-jwt-authentication/934478
 *   Kept (and tested) so we can switch back once PMS accepts JWTs.
 */

export type PlexAuthMode = "legacy" | "jwt";

export type PinCheckResult =
  | { status: "pending" }
  | { status: "authorized"; token: string; expiresAt: number | null };

// ---------- legacy ----------

export async function createLegacyPin(client: PlexClientInfo): Promise<Pin> {
  // strong=true → long code with a longer lifetime; the user never types it.
  return plexRequest(
    "create-pin",
    `${PLEX_TV_API}/pins?strong=true`,
    { method: "POST", headers: plexHeaders(client) },
    PinSchema,
  );
}

export async function checkLegacyPin(client: PlexClientInfo, pinId: number): Promise<PinCheckResult> {
  const pin = await plexRequest(
    "check-pin",
    `${PLEX_TV_API}/pins/${encodeURIComponent(String(pinId))}`,
    { method: "GET", headers: plexHeaders(client) },
    PinSchema,
  );
  if (!pin.authToken) return { status: "pending" };
  return { status: "authorized", token: pin.authToken, expiresAt: null };
}

// ---------- JWT ----------

export async function createJwtPin(client: PlexClientInfo, key: DeviceKey): Promise<Pin> {
  return plexRequest(
    "create-pin",
    `${PLEX_CLIENTS_API}/pins`,
    {
      method: "POST",
      headers: { ...plexHeaders(client), "Content-Type": "application/json" },
      body: JSON.stringify({ jwk: key.publicJwk, strong: true }),
    },
    PinSchema,
  );
}

/**
 * PLEX QUIRK: if the PIN wasn't created with a JWK, or the deviceJWT can't be
 * matched to the registered key, Plex *silently* returns a legacy token
 * instead. In JWT mode we refuse that, so a broken JWT setup fails loudly.
 */
export async function checkJwtPin(client: PlexClientInfo, key: DeviceKey, pinId: number): Promise<PinCheckResult> {
  const deviceJwt = await signDeviceJwt(key, client.clientIdentifier);
  const url = `${PLEX_CLIENTS_API}/pins/${encodeURIComponent(String(pinId))}?${new URLSearchParams({ deviceJWT: deviceJwt })}`;
  const pin = await plexRequest("check-pin", url, { method: "GET", headers: plexHeaders(client) }, PinSchema);
  if (!pin.authToken) return { status: "pending" };
  const { plexJwt, expiresAt } = acceptPlexJwt("check-pin", pin.authToken);
  return { status: "authorized", token: plexJwt, expiresAt };
}

export async function refreshPlexJwt(
  client: PlexClientInfo,
  key: DeviceKey,
): Promise<{ plexJwt: string; expiresAt: number }> {
  const { nonce } = await plexRequest(
    "auth-nonce",
    `${PLEX_CLIENTS_API}/auth/nonce`,
    { method: "GET", headers: plexHeaders(client) },
    NonceSchema,
  );
  const deviceJwt = await signDeviceJwt(key, client.clientIdentifier, { nonce, scope: PLEX_JWT_SCOPE });
  const { auth_token } = await plexRequest(
    "auth-token",
    `${PLEX_CLIENTS_API}/auth/token`,
    {
      method: "POST",
      headers: { ...plexHeaders(client), "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: deviceJwt }),
    },
    TokenExchangeSchema,
  );
  return acceptPlexJwt("auth-token", auth_token);
}

/** Validates that a token is a JWT and extracts its expiry. Does not verify the signature (plex.tv does). */
export function acceptPlexJwt(endpoint: string, token: string): { plexJwt: string; expiresAt: number } {
  let exp: number | undefined;
  try {
    exp = decodeJwt(token).exp;
  } catch {
    throw new PlexApiError(
      endpoint,
      null,
      "Plex returned a legacy (non-JWT) token; refusing it. The JWT device key was not accepted.",
    );
  }
  const expiresAt = typeof exp === "number" ? exp * 1000 : Date.now() + PLEX_JWT_LIFETIME_MS;
  return { plexJwt: token, expiresAt };
}

// ---------- shared ----------

export function buildAuthAppUrl(client: PlexClientInfo, pinCode: string, forwardUrl: string): string {
  // The auth app reads its parameters from the URL *fragment*.
  const params = new URLSearchParams({
    clientID: client.clientIdentifier,
    code: pinCode,
    forwardUrl,
    "context[device][product]": client.product,
  });
  // URLSearchParams encodes spaces as "+"; the docs' examples use %20, which
  // is unambiguous inside a fragment. (A literal "+" is already %2B.)
  return PLEX_AUTH_APP + params.toString().replace(/\+/g, "%20");
}

export async function fetchPlexUser(client: PlexClientInfo, token: string): Promise<PlexUser> {
  return plexRequest(
    "user",
    `${PLEX_TV_API}/user`,
    { method: "GET", headers: plexHeaders(client, token) },
    PlexUserSchema,
  );
}
