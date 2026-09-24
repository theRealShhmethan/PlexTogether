import { afterEach, describe, expect, it, vi } from "vitest";
import { withToken } from "@/lib/client/tokenUrl";
import { parseOffsetMs, reportTimeline, startPlayback, transcodeParams } from "./playback";
import type { PmsTarget } from "./pms";

const target: PmsTarget = {
  client: { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" },
  baseUrl: "https://10-0-0-2.abc.plex.direct:32400",
  token: "LONG-LIVED-SERVER-TOKEN",
};

afterEach(() => vi.unstubAllGlobals());

const decisionOk = {
  MediaContainer: {
    generalDecisionCode: 1000,
    generalDecisionText: "Direct play OK.",
    Metadata: [
      {
        Media: [
          {
            container: "mkv",
            videoResolution: "1080",
            Part: [
              {
                decision: "transcode",
                Stream: [
                  { streamType: 1, codec: "h264", decision: "copy" },
                  { streamType: 2, codec: "eac3", decision: "transcode", language: "English" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

function mockPms(decision: unknown = decisionOk) {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/decision")) return Response.json(decision);
    if (url.includes("/security/token")) return Response.json({ MediaContainer: { token: "TRANSIENT" } });
    return new Response("", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const calls = (fn: ReturnType<typeof mockPms>) => fn.mock.calls as unknown as [string, RequestInit][];

describe("transcodeParams", () => {
  it("asks for HLS with direct stream, keyed to the item", () => {
    const p = transcodeParams({ ratingKey: "70", location: "lan" }, "sess");
    expect(p).toMatchObject({ path: "/library/metadata/70", protocol: "hls", directStream: "1", session: "sess" });
    expect(p.videoBitrate).toBeUndefined();
  });

  it("caps quality on remote connections", () => {
    expect(transcodeParams({ ratingKey: "70", location: "wan" }, "s")).toMatchObject({
      videoBitrate: "8000",
      videoResolution: "1920x1080",
    });
  });

  it("starts the transcode at the requested offset (seconds, as documented)", () => {
    expect(transcodeParams({ ratingKey: "70", location: "lan", offsetMs: 1_263_456 }, "s").offset).toBe("1263.4");
    expect(transcodeParams({ ratingKey: "70", location: "lan", offsetMs: 0 }, "s").offset).toBeUndefined();
  });

  it("applies the viewer's quality choice", () => {
    expect(transcodeParams({ ratingKey: "70", location: "lan", quality: "720" }, "s")).toMatchObject({
      videoBitrate: "4000",
      videoResolution: "1280x720",
    });
    expect(transcodeParams({ ratingKey: "70", location: "wan", quality: "original" }, "s").videoBitrate).toBeUndefined();
    expect(transcodeParams({ ratingKey: "70", location: "wan", quality: "auto" }, "s").videoResolution).toBe("1920x1080");
  });

  it("rejects non-numeric ids", () => {
    expect(() => transcodeParams({ ratingKey: "70/../../:/prefs", location: "lan" }, "s")).toThrow();
  });
});

describe("startPlayback", () => {
  it("makes a decision, gets a transient token, and returns a token-free playlist URL", async () => {
    const fn = mockPms();
    const start = await startPlayback(target, { ratingKey: "70", location: "lan" });

    const [decisionUrl, decisionInit] = calls(fn)[0];
    expect(decisionUrl).toContain("/video/:/transcode/universal/decision?");
    const headers = decisionInit.headers as Record<string, string>;
    expect(headers["X-Plex-Client-Profile-Name"]).toBe("Generic");
    expect(headers["X-Plex-Session-Identifier"]).toBe(start.sessionId);
    expect(calls(fn)[1][0]).toContain("/security/token?type=delegation&scope=all");

    expect(start.transientToken).toBe("TRANSIENT");
    expect(start.playlistUrl).toContain("/video/:/transcode/universal/start.m3u8?");
    expect(start.playlistUrl).toContain(`session=${start.sessionId}`);
    // SECURITY: neither token is baked into the URL; the long-lived one never leaves the server.
    expect(start.playlistUrl).not.toContain("TRANSIENT");
    expect(JSON.stringify(start)).not.toContain("LONG-LIVED-SERVER-TOKEN");

    expect(start.decision.streams).toEqual([
      { kind: "video", codec: "h264", decision: "copy", language: null },
      { kind: "audio", codec: "eac3", decision: "transcode", language: "English" },
    ]);
  });

  it("fails loudly when Plex says the item can't be played", async () => {
    mockPms({ MediaContainer: { generalDecisionCode: 2000, generalDecisionText: "Not enough bandwidth" } });
    await expect(startPlayback(target, { ratingKey: "70", location: "wan" })).rejects.toThrow(/Not enough bandwidth/);
  });
});

describe("reportTimeline", () => {
  it("POSTs state and position with the session identifier", async () => {
    const fn = mockPms();
    await reportTimeline(target, "sess-1", "70", "paused", 61_234.4, 2_640_000);
    const [url, init] = calls(fn)[0];
    const u = new URL(url);
    expect(u.pathname).toBe("/:/timeline");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      ratingKey: "70",
      key: "/library/metadata/70",
      state: "paused",
      time: "61234",
      duration: "2640000",
    });
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Plex-Session-Identifier"]).toBe("sess-1");
  });
});

describe("withToken", () => {
  const origin = "https://10-0-0-2.abc.plex.direct:32400";
  it("adds the token only for the Plex server's origin", () => {
    expect(withToken(`${origin}/video/:/transcode/universal/session/x/base/00001.ts`, origin, "T")).toContain(
      "X-Plex-Token=T",
    );
    expect(withToken("https://cdn.example.com/segment.ts", origin, "T")).not.toContain("X-Plex-Token");
    expect(withToken("https://10-0-0-2.abc.plex.direct:443/x", origin, "T")).not.toContain("X-Plex-Token");
  });
});

describe("parseOffsetMs", () => {
  it("clamps and rejects junk", () => {
    expect(parseOffsetMs(5000)).toBe(5000);
    expect(parseOffsetMs(-5)).toBe(0);
    expect(parseOffsetMs("5000")).toBe(0);
    expect(parseOffsetMs(Number.NaN)).toBe(0);
    expect(parseOffsetMs(1e12)).toBe(86_400_000);
  });
});
