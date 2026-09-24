"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { ItemPage, LibraryItem, LibrarySection } from "@/lib/plex/library";
import { ItemDetail } from "./ItemDetail";
import { itemSubtitle } from "@/lib/format/item";
import { PosterGrid } from "./PosterGrid";

type Listing =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      /** Which tab is showing: "continue", "search", or a library id. */
      view: string;
      title: string;
      items: LibraryItem[];
      total: number | null;
      /** Set for library listings, which can page. */
      sectionId: string | null;
    };

const CONTINUE = "continue";

async function fetchContinueWatching(): Promise<Listing> {
  const r = await getJson<{ items: LibraryItem[] }>("/api/plex/continue");
  return r.ok
    ? { kind: "ready", view: CONTINUE, title: "Continue Watching", items: r.data.items, total: null, sectionId: null }
    : { kind: "error", message: r.error };
}

export function LibraryBrowser() {
  const [libraries, setLibraries] = useState<LibrarySection[] | null>(null);
  const [librariesError, setLibrariesError] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeRoom, setActiveRoom] = useState<{ roomId: string; title: string } | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<{ libraries: LibrarySection[] }>("/api/plex/libraries"),
      getJson<{ item: LibraryItem | null }>("/api/plex/selection"),
      fetchContinueWatching(),
      getJson<{ roomId: string | null; title: string | null }>("/api/rooms"),
    ]).then(([libs, sel, cw, active]) => {
      if (cancelled) return;
      if (active.ok && active.data.roomId) setActiveRoom({ roomId: active.data.roomId, title: active.data.title ?? "" });
      setListing(cw);
      if (libs.ok) setLibraries(libs.data.libraries);
      else setLibrariesError(libs.error);
      if (sel.ok) setSelected(sel.data.item);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openLibrary(lib: LibrarySection) {
    setOpenKey(null);
    setListing({ kind: "loading" });
    const r = await getJson<ItemPage>(`/api/plex/libraries/${lib.id}/items?start=0`);
    setListing(
      r.ok
        ? { kind: "ready", view: lib.id, title: lib.title, items: r.data.items, total: r.data.total, sectionId: lib.id }
        : { kind: "error", message: r.error },
    );
  }

  async function loadMore() {
    if (listing.kind !== "ready" || !listing.sectionId) return;
    setLoadingMore(true);
    const r = await getJson<ItemPage>(`/api/plex/libraries/${listing.sectionId}/items?start=${listing.items.length}`);
    setLoadingMore(false);
    if (!r.ok) {
      setListing({ kind: "error", message: r.error });
      return;
    }
    // Plex may return fewer items than asked; de-duplicate defensively.
    const seen = new Set(listing.items.map((i) => i.ratingKey));
    setListing({ ...listing, items: [...listing.items, ...r.data.items.filter((i) => !seen.has(i.ratingKey))] });
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setOpenKey(null);
    setListing({ kind: "loading" });
    const r = await getJson<{ items: LibraryItem[] }>(`/api/plex/search?${new URLSearchParams({ q })}`);
    setListing(
      r.ok
        ? {
            kind: "ready",
            view: "search",
            title: `Results for “${q}”`,
            items: r.data.items,
            total: r.data.items.length,
            sectionId: null,
          }
        : { kind: "error", message: r.error },
    );
  }

  async function openContinueWatching() {
    setOpenKey(null);
    setListing({ kind: "loading" });
    setListing(await fetchContinueWatching());
  }

  async function createParty() {
    setCreating(true);
    setPickError(null);
    const r = await postJson<{ roomId: string }>("/api/rooms", {});
    setCreating(false);
    if (r.ok) router.push(`/r/${r.data.roomId}`);
    else setPickError(r.error);
  }

  async function playInRoom() {
    if (!activeRoom || !selected) return;
    setCreating(true);
    setPickError(null);
    const r = await postJson<{ ok: true }>(`/api/rooms/${activeRoom.roomId}/item`, { ratingKey: selected.ratingKey });
    setCreating(false);
    if (r.ok) router.push(`/r/${activeRoom.roomId}`);
    else setPickError(r.error);
  }

  async function pick(item: LibraryItem) {
    setPicking(true);
    setPickError(null);
    const r = await postJson<{ item: LibraryItem }>("/api/plex/selection", { ratingKey: item.ratingKey });
    setPicking(false);
    if (r.ok) setSelected(r.data.item);
    else setPickError(r.error);
  }

  const canLoadMore =
    listing.kind === "ready" &&
    listing.sectionId !== null &&
    listing.total !== null &&
    listing.items.length < listing.total;

  return (
    <>
      <section className="pick-bar">
        {selected ? (
          <>
            <div className="pick-title">
              <div className="muted small">Tonight&apos;s pick</div>
              <strong>{selected.title}</strong> <span className="muted">{itemSubtitle(selected)}</span>
            </div>
            {activeRoom ? (
              <>
                <button className="button" onClick={() => void playInRoom()} disabled={creating}>
                  {creating ? "Switching…" : "Play in your watch party"}
                </button>
                <button className="button secondary" onClick={() => void createParty()} disabled={creating}>
                  New watch party
                </button>
              </>
            ) : (
              <button className="button" onClick={() => void createParty()} disabled={creating}>
                {creating ? "Creating…" : "Create watch party"}
              </button>
            )}
            <Link className="button secondary" href="/watch">
              ▶ Watch alone
            </Link>
          </>
        ) : (
          <span className="muted">Open a movie or episode and choose “Select for watch party”.</span>
        )}
        {pickError && <p className="error small">{pickError}</p>}
      </section>

      <section className="panel">
        <form className="search" onSubmit={runSearch}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movies and shows"
            maxLength={100}
            aria-label="Search"
          />
          <button className="button" type="submit">
            Search
          </button>
        </form>
        {librariesError && <p className="error">{librariesError}</p>}
        {libraries === null && !librariesError && <p className="muted">Loading libraries…</p>}
        {libraries && (
          <div className="tabs">
            <button
              className={listing.kind === "ready" && listing.view === CONTINUE ? "tab active" : "tab"}
              onClick={() => void openContinueWatching()}
            >
              Continue Watching
            </button>
            {libraries.length === 0 && <span className="muted">No movie or TV libraries on this server.</span>}
            {libraries.map((lib) => (
              <button
                key={lib.id}
                className={listing.kind === "ready" && listing.view === lib.id ? "tab active" : "tab"}
                onClick={() => void openLibrary(lib)}
              >
                {lib.title}
              </button>
            ))}
          </div>
        )}
      </section>

      {openKey ? (
        <ItemDetail
          key={openKey}
          ratingKey={openKey}
          selectedKey={selected?.ratingKey ?? null}
          busy={picking}
          onPick={(item) => void pick(item)}
          onOpen={(item) => setOpenKey(item.ratingKey)}
          onBack={() => setOpenKey(null)}
        />
      ) : (
        <section className="panel">
          {listing.kind === "loading" && <p className="muted">Loading…</p>}
          {listing.kind === "error" && <p className="error">{listing.message}</p>}
          {listing.kind === "ready" && (
            <>
              <h2>
                {listing.title}
                {listing.total !== null && <span className="muted small"> · {listing.total}</span>}
              </h2>
              {listing.items.length === 0 ? (
                <p className="muted">
                  {listing.view === CONTINUE
                    ? "Nothing in progress for this Plex account. Pick a library to browse."
                    : "Nothing here."}
                </p>
              ) : (
                <PosterGrid items={listing.items} onOpen={(item) => setOpenKey(item.ratingKey)} />
              )}
              {canLoadMore && (
                <button className="button secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
