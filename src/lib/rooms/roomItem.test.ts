import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "@/lib/plex/library";
import type { PmsTarget } from "@/lib/plex/pms";
import type { SelectedServer } from "@/lib/session/store";
import { buildRoomItem } from "./roomItem";

const target: PmsTarget = {
  client: { clientIdentifier: "cid", product: "PlexTogether", version: "0.1.0" },
  baseUrl: "https://pms.example:32400",
  token: "T",
};
const server = { serverId: "m1", name: "Synology-NAS" } as SelectedServer;

const ep = (rk: string, index: number, extra: object = {}) => ({
  ratingKey: rk,
  type: "episode",
  title: `Ep ${index}`,
  index,
  parentIndex: 1,
  grandparentTitle: "House M.D.",
  grandparentRatingKey: "60",
  duration: 2_640_000,
  Media: [{}],
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("buildRoomItem", () => {
  it("finds the next episode and applies the resume point rule", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/allLeaves")
          ? Response.json({ MediaContainer: { Metadata: [ep("70", 1), ep("71", 2), ep("72", 3)] } })
          : Response.json({ MediaContainer: { Metadata: [ep("71", 2, { viewOffset: 600_000 })] } }),
      ),
    );
    const picked = { ratingKey: "71", type: "episode" } as LibraryItem;
    const { title, item } = await buildRoomItem(target, server, picked);
    expect(title).toBe("House M.D. · S1 · E2 · Ep 2");
    expect(item).toMatchObject({ ratingKey: "71", serverId: "m1", resumeMs: 600_000, next: { ratingKey: "72" } });
  });

  it("has no next for the last episode or a movie, and ignores a resume point near the end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/allLeaves")
          ? Response.json({ MediaContainer: { Metadata: [ep("70", 1), ep("71", 2)] } })
          : Response.json({ MediaContainer: { Metadata: [ep("71", 2, { viewOffset: 2_600_000 })] } }),
      ),
    );
    const { item } = await buildRoomItem(target, server, { ratingKey: "71", type: "episode" } as LibraryItem);
    expect(item.next).toBeNull();
    expect(item.resumeMs).toBeNull();
  });
});
