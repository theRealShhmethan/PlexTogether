"use client";

import { useEffect, useMemo, useState } from "react";
import { getJson } from "@/lib/client/api";
import type { LibraryItem } from "@/lib/plex/library";
import { itemSubtitle } from "@/lib/format/item";

type Detail = { item: LibraryItem; episodes: LibraryItem[] | null };
type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; detail: Detail };

function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export function ItemDetail({
  ratingKey,
  selectedKey,
  busy,
  onPick,
  onOpen,
  onBack,
}: {
  ratingKey: string;
  selectedKey: string | null;
  busy: boolean;
  onPick: (item: LibraryItem) => void;
  onOpen: (item: LibraryItem) => void;
  onBack: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void getJson<Detail>(`/api/plex/items/${encodeURIComponent(ratingKey)}`).then((r) => {
      if (cancelled) return;
      setState(r.ok ? { kind: "ready", detail: r.data } : { kind: "error", message: r.error });
    });
    return () => {
      cancelled = true;
    };
  }, [ratingKey]);

  const seasons = useMemo(() => {
    if (state.kind !== "ready" || !state.detail.episodes) return [];
    const bySeason = new Map<number, LibraryItem[]>();
    for (const ep of state.detail.episodes) {
      const s = ep.seasonNumber ?? 0;
      bySeason.set(s, [...(bySeason.get(s) ?? []), ep]);
    }
    return [...bySeason.entries()].sort(([a], [b]) => a - b);
  }, [state]);

  return (
    <section className="panel">
      <button className="link-button" onClick={onBack}>
        ← Back
      </button>
      {state.kind === "loading" && <p className="muted">Loading…</p>}
      {state.kind === "error" && <p className="error">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          <div className="detail">
            {state.detail.item.poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="detail-poster" src={state.detail.item.poster} alt="" />
            )}
            <div className="detail-body">
              <h2>{state.detail.item.title}</h2>
              <p className="muted">
                {[itemSubtitle(state.detail.item), state.detail.item.contentRating, formatDuration(state.detail.item.durationMs)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {state.detail.item.summary && <p className="summary">{state.detail.item.summary}</p>}
              {state.detail.item.playable && (
                <PickButton item={state.detail.item} selectedKey={selectedKey} busy={busy} onPick={onPick} />
              )}
              {state.detail.item.type === "episode" && state.detail.item.showRatingKey && (
                <button
                  className="link-button"
                  onClick={() =>
                    onOpen({ ...state.detail.item, type: "show", ratingKey: state.detail.item.showRatingKey! })
                  }
                >
                  All episodes of {state.detail.item.showTitle}
                </button>
              )}
            </div>
          </div>

          {seasons.map(([season, eps]) => (
            <div key={season} className="season">
              <h3>{season === 0 ? "Specials" : `Season ${season}`}</h3>
              <ul className="episode-list">
                {eps.map((ep) => (
                  <li key={ep.ratingKey} className="episode">
                    <div>
                      <strong>
                        {ep.episodeNumber !== null ? `${ep.episodeNumber}. ` : ""}
                        {ep.title}
                      </strong>
                      <span className="muted small"> {formatDuration(ep.durationMs)}</span>
                    </div>
                    {ep.playable && <PickButton item={ep} selectedKey={selectedKey} busy={busy} onPick={onPick} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function PickButton({
  item,
  selectedKey,
  busy,
  onPick,
}: {
  item: LibraryItem;
  selectedKey: string | null;
  busy: boolean;
  onPick: (item: LibraryItem) => void;
}) {
  const picked = selectedKey === item.ratingKey;
  return (
    <button className={picked ? "button secondary" : "button"} disabled={busy || picked} onClick={() => onPick(item)}>
      {picked ? "✓ Selected for watch party" : "Select for watch party"}
    </button>
  );
}
