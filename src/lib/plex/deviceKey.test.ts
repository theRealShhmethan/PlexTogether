import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { generateDeviceKey, signDeviceJwt } from "./deviceKey";

describe("device key", () => {
  it("produces an Ed25519 public JWK with only public fields", async () => {
    const key = await generateDeviceKey();
    expect(Object.keys(key.publicJwk).sort()).toEqual(["alg", "crv", "kid", "kty", "x"]);
    expect(key.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    // The private scalar must never be part of what we send to plex.tv.
    expect(key.publicJwk).not.toHaveProperty("d");
  });

  it("uses a different key (and kid) per call", async () => {
    const [a, b] = await Promise.all([generateDeviceKey(), generateDeviceKey()]);
    expect(a.publicJwk.kid).not.toBe(b.publicJwk.kid);
  });

  it("signs device JWTs with the claims and header Plex requires", async () => {
    const key = await generateDeviceKey();
    const jwt = await signDeviceJwt(key, "client-123", { nonce: "n-1", scope: "username" });

    const header = decodeProtectedHeader(jwt);
    expect(header).toMatchObject({ alg: "EdDSA", kid: key.publicJwk.kid, typ: "JWT" });

    const publicKey = await importJWK(key.publicJwk, "EdDSA");
    const { payload } = await jwtVerify(jwt, publicKey, { audience: "plex.tv", issuer: "client-123" });
    expect(payload.nonce).toBe("n-1");
    expect(payload.scope).toBe("username");
    expect(payload.exp! - payload.iat!).toBe(300);
  });
});
