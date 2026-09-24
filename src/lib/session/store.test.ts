import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetStores, getSession, randomId, saveSession, type HostSession } from "./store";
import { toPublicUser } from "./publicUser";

afterEach(() => {
  vi.useRealTimers();
  _resetStores();
});

function makeSession(expiresAt: number): HostSession {
  return {
    id: randomId(),
    clientIdentifier: "cid",
    plex: { mode: "legacy", token: "secret-jwt" },
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

  it("expires sessions", () => {
    vi.useFakeTimers();
    const s = makeSession(Date.now() + 1000);
    saveSession(s);
    expect(getSession(s.id)).toBe(s);
    vi.advanceTimersByTime(1001);
    expect(getSession(s.id)).toBeUndefined();
  });

  it("public user view never includes the token or key", () => {
    const s = makeSession(Date.now() + 1000);
    const json = JSON.stringify(toPublicUser(s));
    expect(json).not.toContain("secret-jwt");
    expect(json).not.toContain("e@example.com");
    expect(Object.keys(toPublicUser(s)).sort()).toEqual(["displayName", "plexPass", "profile", "username"]);
  });
});
