import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { PLEX_JWT_AUDIENCE } from "./constants";

/**
 * Plex JWT auth: each "device" (here: one host login session) owns an Ed25519
 * key pair. The public key is registered with plex.tv when the PIN is created;
 * the private key signs short-lived "device JWTs" that plex.tv exchanges for
 * a Plex JWT (the actual X-Plex-Token).
 *
 * SECURITY: the private key never leaves server memory. It is not exported,
 * persisted, logged, or sent to any browser.
 */
export type DeviceKey = {
  privateKey: CryptoKey;
  publicJwk: PlexPublicJwk;
};

export type PlexPublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
};

export async function generateDeviceKey(): Promise<DeviceKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: false,
  });
  const jwk: JWK = await exportJWK(publicKey);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("Unexpected public key format");
  }
  // RFC 7638 thumbprint makes a stable, collision-resistant key id.
  const kid = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  return {
    privateKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA" },
  };
}

/**
 * Signs a device JWT. Plex requires `kid` + `alg` in the header and
 * `aud: "plex.tv"`, `iss: <clientIdentifier>` in the payload. The refresh
 * flow additionally requires `nonce` and `scope`; the PIN exchange does not.
 * Lifetime is kept short (5 min) since each one is used immediately.
 */
export async function signDeviceJwt(
  key: DeviceKey,
  clientIdentifier: string,
  extraClaims: { nonce?: string; scope?: string } = {},
): Promise<string> {
  return new SignJWT({ ...extraClaims })
    .setProtectedHeader({ alg: "EdDSA", kid: key.publicJwk.kid, typ: "JWT" })
    .setAudience(PLEX_JWT_AUDIENCE)
    .setIssuer(clientIdentifier)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key.privateKey);
}
