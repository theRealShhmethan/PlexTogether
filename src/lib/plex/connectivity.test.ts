import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionRank, probeAll, probeConnection } from "./connectivity";
import type { PlexConnection } from "./resources";

const client = { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" };

const c = (o: Partial<PlexConnection>): PlexConnection => ({
  protocol: "https",
  address: "1.2.3.4",
  port: 32400,
  uri: "https://host.plex.direct:32400",
  local: false,
  relay: false,
  IPv6: false,
  ...o,
});

const identity = (machineIdentifier: string) =>
  Response.json({ MediaContainer: { machineIdentifier, version: "1.41.0" } });

afterEach(() => vi.unstubAllGlobals());

describe("connectionRank", () => {
  it("prefers local > remote > relay and https > http", () => {
    const ordered = [
      c({ local: true }),
      c({ local: true, protocol: "http" }),
      c({}),
      c({ protocol: "http" }),
      c({ relay: true }),
    ];
    const ranks = ordered.map(connectionRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe("probeConnection", () => {
  it("succeeds when identity matches and the token is accepted", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/identity") ? identity("m1") : new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeConnection(client, c({}), "m1", "tok");
    expect(r).toMatchObject({ ok: true, version: "1.41.0" });
    // Identity check goes without a token; the auth check carries it.
    const [idCall, authCall] = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect((idCall[1].headers as Record<string, string>)["X-Plex-Token"]).toBeUndefined();
    expect((authCall[1].headers as Record<string, string>)["X-Plex-Token"]).toBe("tok");
  });

  it("never sends the token to a host that identifies as a different server", async () => {
    const fetchMock = vi.fn(async () => identity("someone-else"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeConnection(client, c({}), "m1", "tok");
    expect(r).toMatchObject({ ok: false, reason: "wrong-server" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.endsWith("/identity") ? identity("m1") : new Response("", { status: 401 }))),
    );
    await expect(probeConnection(client, c({}), "m1", "tok")).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("reports network failures as unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(probeConnection(client, c({}), "m1", "tok")).resolves.toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("probeAll", () => {
  it("puts the best working connection first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://local")) throw new TypeError("fetch failed");
        return url.endsWith("/identity") ? identity("m1") : new Response("{}");
      }),
    );
    const results = await probeAll(
      client,
      [c({ relay: true, uri: "https://relay:1" }), c({ local: true, uri: "https://local:1" }), c({ uri: "https://remote:1" })],
      "m1",
      "tok",
    );
    expect(results.map((r) => [r.connection.uri, r.ok])).toEqual([
      ["https://remote:1", true],
      ["https://relay:1", true],
      ["https://local:1", false],
    ]);
  });
});
