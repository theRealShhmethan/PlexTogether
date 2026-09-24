import "server-only";
import { itemHeading } from "@/lib/format/item";
import { getItem, listEpisodes, type LibraryItem } from "@/lib/plex/library";
import type { PmsTarget } from "@/lib/plex/pms";
import type { SelectedServer } from "@/lib/session/store";
import type { RoomItem } from "./hub";

/**
 * Builds what a room plays from a library item, on the host's server:
 * fresh metadata (for the resume point) and, for episodes, the next episode
 * (from the documented /library/metadata/{show}/allLeaves, in order).
 */
export async function buildRoomItem(
  target: PmsTarget,
  server: SelectedServer,
  picked: LibraryItem,
): Promise<{ title: string; item: RoomItem }> {
  let item = picked;
  try {
    item = (await getItem(target, picked.ratingKey)) ?? picked;
  } catch {
    /* use what we have */
  }

  let next: RoomItem["next"] = null;
  if (item.type === "episode" && item.showRatingKey) {
    try {
      const episodes = await listEpisodes(target, item.showRatingKey);
      const i = episodes.findIndex((e) => e.ratingKey === item.ratingKey);
      const n = i >= 0 ? episodes.slice(i + 1).find((e) => e.playable) : undefined;
      if (n) next = { ratingKey: n.ratingKey, title: itemHeading(n) };
    } catch {
      /* no "next episode" then */
    }
  }

  return {
    title: itemHeading(item),
    item: {
      ratingKey: item.ratingKey,
      serverId: server.serverId,
      serverName: server.name,
      durationMs: item.durationMs,
      // Ignore a resume point in the first minute or the last three (Plex treats those as unwatched/finished).
      resumeMs:
        item.viewOffsetMs && item.viewOffsetMs > 60_000 && (!item.durationMs || item.viewOffsetMs < item.durationMs - 180_000)
          ? item.viewOffsetMs
          : null,
      next,
    },
  };
}
