"use client";

import type { LibraryItem } from "@/lib/plex/library";

export function itemSubtitle(item: LibraryItem): string {
  if (item.type === "episode") {
    const se =
      item.seasonNumber !== null && item.episodeNumber !== null ? `S${item.seasonNumber} · E${item.episodeNumber}` : "";
    return [item.showTitle, se].filter(Boolean).join(" · ");
  }
  if (item.type === "show") return item.episodeCount !== null ? `${item.episodeCount} episodes` : "TV show";
  return item.year !== null ? String(item.year) : "";
}

export function PosterGrid({ items, onOpen }: { items: LibraryItem[]; onOpen: (item: LibraryItem) => void }) {
  return (
    <ul className="poster-grid">
      {items.map((item) => (
        <li key={item.ratingKey}>
          <button className="poster" onClick={() => onOpen(item)} title={item.title}>
            {item.poster ? (
              // Same-origin proxy URL; next/image would add nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.poster} alt="" loading="lazy" />
            ) : (
              <span className="poster-fallback">{item.title}</span>
            )}
            <span className="poster-title">{item.title}</span>
            <span className="poster-sub muted">{itemSubtitle(item)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
