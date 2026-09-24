import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPlexJwt, buildAuthAppUrl, checkJwtPin, checkLegacyPin, createJwtPin, createLegacyPin } from "./auth";
import { PlexApiError } from "./client";
import { generateDeviceKey } from "./deviceKey";

const client = { clientIdentifier: "cid-1", product: "PlexTogether", version: "0.1.0" };

// Unsigned JWT-shaped token with an exp claim; acceptPlexJwt only decodes.
function fakeJwt(exp: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ exp })}.sig`;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildAuthAppUrl", () => {
  it("puts parameters in the fragment, encoded like the docs example", () => {
    const url = buildAuthAppUrl(
      { ...client, product: "My Cool App" },
      "abc",
      "http://localhost:3000/auth/callback",
    );
    expect(url.startsWith("https://app.plex.tv/auth#?")).toBe(true);
    const params = new URLSearchParams(url.split("#?")[1]);
    expect(params.get("clientID")).toBe("cid-1");
    expect(params.get("code")).toBe("abc");
    expect(params.get("forwardUrl")).toBe("http://localhost:3000/auth/callback");
    expect(params.get("context[device][product]")).toBe("My Cool App");
    expect(url).toContain("context%5Bdevice%5D%5Bproduct%5D=My%20Cool%20App");
  });
});

describe("acceptPlexJwt", () => {
  it("accepts a JWT and reads its expiry", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(acceptPlexJwt("t", fakeJwt(exp)).expiresAt).toBe(exp * 1000);
  });

  it("refuses a legacy (non-JWT) token", () => {
    expect(() => acceptPlexJwt("t", "legacyTokenABC123")).toThrow(PlexApiError);
  });
});

describe("legacy PIN flow", () => {
  it("creates a strong PIN on plex.tv without a JWK or token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 7, code: "c", authToken: null }));
    vi.stubGlobal("fetch", fetchMock);
    await createLegacyPin(client);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://plex.tv/api/v2/pins?strong=true");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["X-Plex-Token"]).toBeUndefined();
  });

  it("returns the claimed token, with no expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 7, code: "c", authToken: "legacy123" })));
    await expect(checkLegacyPin(client, 7)).resolves.toEqual({ status: "authorized", token: "legacy123", expiresAt: null });
  });

  it("reports pending until claimed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 7, code: "c", authToken: null })));
    await expect(checkLegacyPin(client, 7)).resolves.toEqual({ status: "pending" });
  });
});

describe("JWT PIN flow", () => {
  it("createJwtPin sends the public JWK and strong=true, without any token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 42, code: "code", authToken: null }));
    vi.stubGlobal("fetch", fetchMock);
    const key = await generateDeviceKey();

    const pin = await createJwtPin(client, key);

    expect(pin).toEqual({ id: 42, code: "code", authToken: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://clients.plex.tv/api/v2/pins");
    expect(JSON.parse(init.body as string)).toEqual({ jwk: key.publicJwk, strong: true });
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Plex-Client-Identifier"]).toBe("cid-1");
    expect(headers["X-Plex-Token"]).toBeUndefined();
  });

  it("checkJwtPin reports pending until authToken is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 42, code: "code", authToken: null })));
    const key = await generateDeviceKey();
    await expect(checkJwtPin(client, key, 42)).resolves.toEqual({ status: "pending" });
  });

  it("checkJwtPin refuses Plex's silent legacy-token fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 42, code: "code", authToken: "legacy123" })));
    const key = await generateDeviceKey();
    await expect(checkJwtPin(client, key, 42)).rejects.toThrow(/legacy/);
  });

  it("maps HTTP errors to PlexApiError without leaking the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const key = await generateDeviceKey();
    const err = await checkJwtPin(client, key, 42).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlexApiError);
    expect((err as PlexApiError).status).toBe(404);
    expect((err as PlexApiError).message).not.toContain("deviceJWT");
  });
});
