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

/** Tiles lead with the show name for episodes ("House M.D." / "S3 · E5 · Title"). */
function tileText(item: LibraryItem): { title: string; sub: string } {
  if (item.type !== "episode" || !item.showTitle) return { title: item.title, sub: itemSubtitle(item) };
  const se = item.seasonNumber !== null && item.episodeNumber !== null ? `S${item.seasonNumber} · E${item.episodeNumber} · ` : "";
  return { title: item.showTitle, sub: se + item.title };
}

export function PosterGrid({ items, onOpen }: { items: LibraryItem[]; onOpen: (item: LibraryItem) => void }) {
  return (
    <ul className="poster-grid">
      {items.map((item) => (
        <li key={item.ratingKey}>
          <button className="poster" onClick={() => onOpen(item)} title={`${tileText(item).title} — ${tileText(item).sub}`}>
            {item.poster ? (
              // Same-origin proxy URL; next/image would add nothing here.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.poster} alt="" loading="lazy" />
            ) : (
              <span className="poster-fallback">{item.title}</span>
            )}
            {item.viewOffsetMs !== null && item.durationMs ? (
              <span className="progress" aria-label="Watched progress">
                <span style={{ width: `${Math.min(100, (item.viewOffsetMs / item.durationMs) * 100)}%` }} />
              </span>
            ) : null}
            <span className="poster-title">{tileText(item).title}</span>
            <span className="poster-sub muted">{tileText(item).sub}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
