import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexApiError } from "./client";
import { listHomeProfiles, switchHomeProfile, type HomeProfile } from "./home";

const client = { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" };

afterEach(() => vi.unstubAllGlobals());

const users = [
  { id: 1, uuid: "aaa", title: "Elliot", admin: true, protected: false },
  { id: 2, uuid: "bbb", title: "Ethan", admin: false, protected: true, restricted: false },
  { id: 3, uuid: "ccc", title: "Guest", guest: true },
];

describe("listHomeProfiles", () => {
  it.each([["wrapped", { users }], ["bare array", users]])("parses a %s response and skips guests", async (_, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    const profiles = await listHomeProfiles(client, "acct");
    expect(profiles.map((p) => [p.title, p.admin, p.hasPin])).toEqual([
      ["Elliot", true, false],
      ["Ethan", false, true],
    ]);
  });
});

describe("switchHomeProfile", () => {
  const ethan: HomeProfile = { id: 2, uuid: "bbb", title: "Ethan", admin: false, restricted: false, hasPin: true };

  it("switches by uuid with the PIN and returns the profile token", async () => {
    const fn = vi.fn(async () => Response.json({ authToken: "ethan-token" }));
    vi.stubGlobal("fetch", fn);
    await expect(switchHomeProfile(client, "acct", ethan, "1234")).resolves.toBe("ethan-token");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://clients.plex.tv/api/v2/home/users/bbb/switch?pin=1234");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Plex-Token"]).toBe("acct");
  });

  it("falls back to the numeric id when the uuid isn't recognised", async () => {
    const fn = vi.fn(async (url: string) =>
      url.includes("/bbb/") ? new Response("", { status: 404 }) : Response.json({ authenticationToken: "t2" }),
    );
    vi.stubGlobal("fetch", fn);
    await expect(switchHomeProfile(client, "acct", ethan, null)).resolves.toBe("t2");
    expect((fn.mock.calls[1] as unknown as [string])[0]).toContain("/home/users/2/switch");
  });

  it("does not retry when Plex rejects the PIN", async () => {
    const fn = vi.fn(async () => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fn);
    const err = await switchHomeProfile(client, "acct", ethan, "0000").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlexApiError);
    expect((err as PlexApiError).status).toBe(401);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
