import type { LibraryItem } from "@/lib/plex/library";

/** Short secondary line for an item: "Show · S1 · E2", "24 episodes", or the year. Safe on server and client. */
export function itemSubtitle(item: LibraryItem): string {
  if (item.type === "episode") {
    const se =
      item.seasonNumber !== null && item.episodeNumber !== null ? `S${item.seasonNumber} · E${item.episodeNumber}` : "";
    return [item.showTitle, se].filter(Boolean).join(" · ");
  }
  if (item.type === "show") return item.episodeCount !== null ? `${item.episodeCount} episodes` : "TV show";
  return item.year !== null ? String(item.year) : "";
}

/** "House M.D. · S3 · E5 · Title" for episodes, "Title (1995)" for movies. */
export function itemHeading(item: LibraryItem): string {
  if (item.type === "episode") return [itemSubtitle(item), item.title].filter(Boolean).join(" · ");
  return item.year !== null ? `${item.title} (${item.year})` : item.title;
}
