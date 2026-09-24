import { decodeJwt } from "jose";
import { PLEX_AUTH_APP, PLEX_CLIENTS_API, PLEX_JWT_LIFETIME_MS, PLEX_JWT_SCOPE, PLEX_TV_API } from "./constants";
import { plexHeaders, plexRequest, PlexApiError, type PlexClientInfo } from "./client";
import { signDeviceJwt, type DeviceKey } from "./deviceKey";
import { NonceSchema, PinSchema, PlexUserSchema, TokenExchangeSchema, type Pin, type PlexUser } from "./schemas";

/**
 * Plex JWT authentication via the PIN flow ("Option 1" in the official docs:
 * https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex).
 *
 *   1. createPin: POST /pins with our public JWK
 *   2. user signs in on app.plex.tv (buildAuthAppUrl) — we never see their password
 *   3. checkPin: GET /pins/:id?deviceJWT=<signed> → authToken is a Plex JWT
 *   4. refreshPlexJwt: nonce → signed device JWT → POST /auth/token (every ≤7 days)
 */

export async function createPin(client: PlexClientInfo, key: DeviceKey): Promise<Pin> {
  return plexRequest(
    "create-pin",
    `${PLEX_CLIENTS_API}/pins`,
    {
      method: "POST",
      headers: { ...plexHeaders(client), "Content-Type": "application/json" },
      // strong=true → long code with a longer lifetime; the user never types it.
      body: JSON.stringify({ jwk: key.publicJwk, strong: true }),
    },
    PinSchema,
  );
}

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

export type PinCheckResult =
  | { status: "pending" }
  | { status: "authorized"; plexJwt: string; expiresAt: number };

/**
 * Checks whether the user has claimed the PIN.
 *
 * PLEX QUIRK: if the PIN wasn't created with a JWK, or the deviceJWT can't be
 * matched to the registered key, Plex *silently* returns a legacy (long-lived,
 * non-JWT) token instead. We refuse that rather than fall back, so a broken
 * JWT setup fails loudly instead of quietly storing a weaker credential.
 */
export async function checkPin(client: PlexClientInfo, key: DeviceKey, pinId: number): Promise<PinCheckResult> {
  const deviceJwt = await signDeviceJwt(key, client.clientIdentifier);
  const url = `${PLEX_CLIENTS_API}/pins/${encodeURIComponent(String(pinId))}?${new URLSearchParams({ deviceJWT: deviceJwt })}`;
  const pin = await plexRequest("check-pin", url, { method: "GET", headers: plexHeaders(client) }, PinSchema);
  if (!pin.authToken) return { status: "pending" };
  return { status: "authorized", ...acceptPlexJwt("check-pin", pin.authToken) };
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

export async function fetchPlexUser(client: PlexClientInfo, plexJwt: string): Promise<PlexUser> {
  return plexRequest(
    "user",
    `${PLEX_TV_API}/user`,
    { method: "GET", headers: plexHeaders(client, plexJwt) },
    PlexUserSchema,
  );
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
