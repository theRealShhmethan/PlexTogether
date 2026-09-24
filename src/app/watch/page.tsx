import Link from "next/link";
import { Player } from "@/components/player/Player";
import { itemHeading } from "@/lib/format/item";
import { getItem } from "@/lib/plex/library";
import { requireSelectedServer } from "@/lib/servers/target";

/** Host test player for the watch-party pick (Phase 5 proof of concept). */
export default async function WatchPage() {
  const host = await requireSelectedServer();
  const pick = host instanceof Response ? null : host.session.selectedItem;

  // Re-read the item so the resume position is current.
  let item = pick ?? null;
  let loadError: string | null = null;
  if (!(host instanceof Response) && pick) {
    try {
      item = (await getItem(host.target, pick.ratingKey)) ?? pick;
    } catch {
      loadError = "Couldn't refresh the item from the server; the resume position may be out of date.";
    }
  }

  return (
    <div className="wide">
      <header className="page-header">
        <Link href="/browse">← Browse</Link>
        {item && <span className="muted">{itemHeading(item)}</span>}
      </header>
      {host instanceof Response ? (
        <section className="panel">
          <p>Sign in and select a server first.</p>
          <Link href="/">Go to start</Link>
        </section>
      ) : !item ? (
        <section className="panel">
          <p>Nothing picked yet.</p>
          <Link href="/browse">Pick a movie or episode</Link>
        </section>
      ) : (
        <>
          {loadError && <p className="muted small">{loadError}</p>}
          <Player item={item} />
        </>
      )}
    </div>
  );
}
