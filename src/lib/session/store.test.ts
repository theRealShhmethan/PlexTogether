import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDeviceKey } from "@/lib/plex/deviceKey";
import { _resetStores, getSession, randomId, saveSession, type HostSession } from "./store";
import { toPublicUser } from "./publicUser";

afterEach(() => {
  vi.useRealTimers();
  _resetStores();
});

async function makeSession(expiresAt: number): Promise<HostSession> {
  return {
    id: randomId(),
    clientIdentifier: "cid",
    deviceKey: await generateDeviceKey(),
    plexJwt: "secret-jwt",
    plexJwtExpiresAt: expiresAt,
    user: { id: 1, username: "ethan", title: "Ethan", email: "e@example.com" } as HostSession["user"],
    createdAt: Date.now(),
    expiresAt,
  };
}

describe("session store", () => {
  it("generates 256-bit url-safe ids", () => {
    const id = randomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomId()).not.toBe(id);
  });

  it("expires sessions", async () => {
    vi.useFakeTimers();
    const s = await makeSession(Date.now() + 1000);
    saveSession(s);
    expect(getSession(s.id)).toBe(s);
    vi.advanceTimersByTime(1001);
    expect(getSession(s.id)).toBeUndefined();
  });

  it("public user view never includes the token or key", async () => {
    const s = await makeSession(Date.now() + 1000);
    const json = JSON.stringify(toPublicUser(s));
    expect(json).not.toContain("secret-jwt");
    expect(json).not.toContain("e@example.com");
    expect(Object.keys(toPublicUser(s)).sort()).toEqual(["displayName", "plexPass", "username"]);
  });
});
