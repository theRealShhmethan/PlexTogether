import Link from "next/link";
import { LibraryBrowser } from "@/components/library/LibraryBrowser";
import { getCurrentSession } from "@/lib/session/host";

export default async function BrowsePage() {
  const session = await getCurrentSession();
  const server = session?.selectedServer;

  return (
    <div className="wide">
      <header className="page-header">
        <Link href="/">← PlexTogether</Link>
        {server && <span className="muted">Browsing {server.name}</span>}
      </header>
      {!session ? (
        <section className="panel">
          <p>You&apos;re not signed in.</p>
          <Link href="/">Sign in</Link>
        </section>
      ) : !server ? (
        <section className="panel">
          <p>Select a Plex Media Server first.</p>
          <Link href="/">Choose a server</Link>
        </section>
      ) : (
        <LibraryBrowser />
      )}
    </div>
  );
}
