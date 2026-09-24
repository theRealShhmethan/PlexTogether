import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePathSchema, imageProxyUrl, listEpisodes, listSectionItems, listSections, search } from "./library";
import type { PmsTarget } from "./pms";

const target: PmsTarget = {
  client: { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" },
  baseUrl: "https://10-0-0-2.abc.plex.direct:32400",
  token: "server-token",
};

afterEach(() => vi.unstubAllGlobals());

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const calls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls as unknown as [string, RequestInit][];

describe("image path allowlist", () => {
  it.each(["/library/metadata/123/thumb/1699999999", "/library/metadata/1/art/2", "/library/metadata/9/banner/10"])(
    "accepts %s",
    (p) => expect(ImagePathSchema.safeParse(p).success).toBe(true),
  );

  it.each([
    "/library/metadata/123/thumb/1/../../../:/prefs",
    "/:/prefs",
    "/library/sections/all",
    "https://evil.example/x.jpg",
    "//evil.example/library/metadata/1/thumb/2",
    "/library/metadata/1/thumb/2?X-Plex-Token=x",
    "/library/metadata/abc/thumb/2",
  ])("rejects %s", (p) => expect(ImagePathSchema.safeParse(p).success).toBe(false));

  it("builds same-origin proxy URLs only for allowed paths", () => {
    expect(imageProxyUrl("/library/metadata/5/thumb/6", 300, 450)).toBe(
      "/api/plex/image?path=%2Flibrary%2Fmetadata%2F5%2Fthumb%2F6&w=300&h=450",
    );
    expect(imageProxyUrl("https://metadata-static.plex.tv/x.jpg", 300, 450)).toBeNull();
    expect(imageProxyUrl(undefined, 300, 450)).toBeNull();
  });
});

describe("listSections", () => {
  it("returns only movie and show libraries, with the token in a header", async () => {
    const fn = mockFetch({
      MediaContainer: {
        Directory: [
          { key: "1", title: "Movies", type: "movie" },
          { key: "2", title: "TV Shows", type: "show" },
          { key: "3", title: "Music", type: "artist" },
        ],
      },
    });
    expect(await listSections(target)).toEqual([
      { id: "1", title: "Movies", type: "movie" },
      { id: "2", title: "TV Shows", type: "show" },
    ]);
    const [url, init] = calls(fn)[0];
    expect(url).toBe("https://10-0-0-2.abc.plex.direct:32400/library/sections/all");
    expect(url).not.toContain("server-token");
    expect((init.headers as Record<string, string>)["X-Plex-Token"]).toBe("server-token");
    expect(init.redirect).toBe("error");
  });
});

describe("listSectionItems", () => {
  it("sends pagination headers and maps items", async () => {
    const fn = mockFetch({
      MediaContainer: {
        offset: 60,
        totalSize: 200,
        Metadata: [
          { ratingKey: "10", type: "movie", title: "Heat", year: 1995, thumb: "/library/metadata/10/thumb/1", Media: [{ id: 1 }] },
          { ratingKey: "11", type: "movie", title: "No Media" },
          { ratingKey: "12", type: "collection", title: "Ignored" },
          { title: "malformed" },
        ],
      },
    });
    const page = await listSectionItems(target, "1", { start: 60, size: 60 });
    const headers = calls(fn)[0][1].headers as Record<string, string>;
    expect(headers["X-Plex-Container-Start"]).toBe("60");
    expect(headers["X-Plex-Container-Size"]).toBe("60");
    expect(page.start).toBe(60);
    expect(page.total).toBe(200);
    expect(page.items.map((i) => [i.ratingKey, i.playable])).toEqual([
      ["10", true],
      ["11", false],
    ]);
    expect(page.items[0].poster).toContain("/api/plex/image?");
  });

  it("refuses non-numeric ids before making a request", async () => {
    const fn = mockFetch({});
    await expect(listSectionItems(target, "1/../../:/prefs", { start: 0, size: 1 })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("listEpisodes / search", () => {
  it("maps episodes with show, season and episode numbers", async () => {
    mockFetch({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: "50",
            type: "episode",
            title: "Pilot",
            index: 1,
            parentIndex: 1,
            grandparentTitle: "Show",
            grandparentRatingKey: "40",
            Media: [{}],
          },
        ],
      },
    });
    const [ep] = await listEpisodes(target, "40");
    expect(ep).toMatchObject({ showTitle: "Show", showRatingKey: "40", seasonNumber: 1, episodeNumber: 1, playable: true });
  });

  it("keeps only movie/show/episode hubs from search", async () => {
    const fn = mockFetch({
      MediaContainer: {
        Hub: [
          { type: "movie", Metadata: [{ ratingKey: "1", type: "movie", title: "A" }] },
          { type: "actor", Metadata: [{ ratingKey: "2", type: "actor", title: "B" }] },
          { type: "show", Metadata: [{ ratingKey: "3", type: "show", title: "C" }] },
        ],
      },
    });
    expect((await search(target, "a b")).map((i) => i.ratingKey)).toEqual(["1", "3"]);
    expect(calls(fn)[0][0]).toContain("/hubs/search?query=a+b&limit=20");
  });
});
