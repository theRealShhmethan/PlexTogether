import { describe, expect, it, vi } from "vitest";
import { parseServers } from "./resources";

const conn = (o: Partial<Record<string, unknown>> = {}) => ({
  protocol: "https",
  address: "192.168.1.5",
  port: 32400,
  uri: "https://192-168-1-5.abc.plex.direct:32400",
  local: true,
  relay: false,
  IPv6: false,
  ...o,
});

describe("parseServers", () => {
  it("keeps servers, drops players, and maps shared-server owners", () => {
    const servers = parseServers([
      { name: "Home", clientIdentifier: "m1", provides: "server", owned: true, accessToken: "t1", connections: [conn()] },
      { name: "Phone", clientIdentifier: "p1", provides: "client,player", connections: [] },
      {
        name: "Dad's",
        clientIdentifier: "m2",
        provides: "server",
        owned: false,
        sourceTitle: "Dad",
        presence: true,
        accessToken: "t2",
        connections: [conn({ local: false })],
      },
    ]);
    expect(servers.map((s) => s.id)).toEqual(["m1", "m2"]);
    expect(servers[0]).toMatchObject({ owned: true, ownerName: null });
    expect(servers[1]).toMatchObject({ owned: false, ownerName: "Dad", online: true });
  });

  it("skips malformed entries instead of failing the whole list", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const servers = parseServers([
      { name: "Bad", provides: "server" }, // no clientIdentifier
      { name: "Good", clientIdentifier: "m1", provides: "server", connections: [conn()] },
    ]);
    expect(servers.map((s) => s.id)).toEqual(["m1"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toContain("Bad");
    warn.mockRestore();
  });
});
