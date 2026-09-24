import { afterEach, describe, expect, it, vi } from "vitest";
import { pickConnection, type Candidate } from "@/lib/client/probe";
import type { PmsTarget } from "./pms";
import { getTracks, setTracks } from "./tracks";

const target: PmsTarget = {
  client: { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" },
  baseUrl: "https://pms.example:32400",
  token: "SERVER-TOKEN",
};

const metadata = {
  MediaContainer: {
    Metadata: [
      {
        Media: [
          {
            Part: [
              {
                id: 555,
                Stream: [
                  { id: 1, streamType: 1, codec: "h264" },
                  { id: 2, streamType: 2, displayTitle: "English (AC3 5.1)", languageCode: "eng", selected: true },
                  { id: 3, streamType: 2, displayTitle: "Español (AAC Stereo)", languageCode: "spa" },
                  { id: 4, streamType: 3, displayTitle: "English (SRT)", languageCode: "eng", key: "/library/streams/4" },
                  { id: 5, streamType: 3, extendedDisplayTitle: "English (Forced PGS)", languageCode: "eng", selected: true },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("tracks", () => {
  it("lists audio and subtitle tracks with what's selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(metadata)));
    const t = await getTracks(target, "70");
    expect(t.partId).toBe(555);
    expect(t.audio.map((a) => [a.id, a.label, a.selected])).toEqual([
      [2, "English (AC3 5.1)", true],
      [3, "Español (AAC Stereo)", false],
    ]);
    expect(t.subtitles.map((s) => [s.id, s.label, s.selected, s.external])).toEqual([
      [4, "English (SRT)", false, true],
      [5, "English (Forced PGS)", true, false],
    ]);
  });

  it("selects tracks with the documented PUT, and 0 turns subtitles off", async () => {
    const fn = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? new Response(null, { status: 200 }) : Response.json(metadata),
    );
    vi.stubGlobal("fetch", fn);
    const r = await setTracks(target, "70", { audioStreamId: 3, subtitleStreamId: 0 });
    expect(r.ok).toBe(true);
    const put = (fn.mock.calls as unknown as [string, RequestInit][]).find(([, init]) => init?.method === "PUT")!;
    const u = new URL(put[0]);
    expect(u.pathname).toBe("/library/parts/555");
    expect(Object.fromEntries(u.searchParams)).toEqual({ allParts: "1", audioStreamID: "3", subtitleStreamID: "0" });
    expect((put[1].headers as Record<string, string>)["X-Plex-Token"]).toBe("SERVER-TOKEN");
    expect(put[1].redirect).toBe("error");
  });

  it("refuses track ids that don't belong to this item", async () => {
    const fn = vi.fn(async () => Response.json(metadata));
    vi.stubGlobal("fetch", fn);
    expect(await setTracks(target, "70", { audioStreamId: 4 })).toEqual({ ok: false, error: "Unknown audio track" });
    expect(await setTracks(target, "70", { subtitleStreamId: 999 })).toEqual({ ok: false, error: "Unknown subtitle track" });
    expect((fn.mock.calls as unknown as [string, RequestInit?][]).some(([, i]) => i?.method === "PUT")).toBe(false);
  });
});

describe("pickConnection (browser-side)", () => {
  const cands: Candidate[] = [
    { index: 0, uri: "http://192.168.1.5:32400", protocol: "http", local: true, relay: false },
    { index: 1, uri: "https://local.plex.direct:32400", protocol: "https", local: true, relay: false },
    { index: 2, uri: "https://remote.plex.direct:32400", protocol: "https", local: false, relay: false },
    { index: 3, uri: "https://relay.plex.direct:8443", protocol: "https", local: false, relay: true },
  ];
  const reachableOnly = (hosts: string[]) =>
    vi.fn(async (url: string) => {
      if (hosts.some((h) => url.includes(h))) return new Response(null);
      throw new TypeError("unreachable");
    });

  it("prefers local, then remote, then relay, among reachable addresses", async () => {
    vi.stubGlobal("fetch", reachableOnly(["local.plex.direct", "remote.plex.direct", "relay"]));
    expect(await pickConnection(cands, true)).toBe(1);
    vi.stubGlobal("fetch", reachableOnly(["remote.plex.direct", "relay"]));
    expect(await pickConnection(cands, true)).toBe(2);
    vi.stubGlobal("fetch", reachableOnly(["relay"]));
    expect(await pickConnection(cands, true)).toBe(3);
  });

  it("never picks http:// from an https page (mixed content), and returns null if nothing answers", async () => {
    const fn = reachableOnly(["192.168.1.5"]);
    vi.stubGlobal("fetch", fn);
    expect(await pickConnection(cands, true)).toBeNull();
    expect((fn.mock.calls as unknown as [string][]).some(([u]) => u.startsWith("http://"))).toBe(false);
    expect(await pickConnection(cands, false)).toBe(0);
  });
});
