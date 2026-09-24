import { SignInButton } from "@/components/SignInButton";
import { SignOutButton } from "@/components/SignOutButton";
import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

export default async function Home() {
  const session = await getCurrentSession();
  const user = session ? toPublicUser(session) : null;

  return (
    <>
      <header>
        <h1>PlexTogether</h1>
        <p className="muted">Watch your Plex library together, in sync. (v0.1 — sign-in only)</p>
      </header>

      {user ? (
        <section className="panel">
          <h2>Signed in with Plex</h2>
          <dl>
            <dt>Name</dt>
            <dd>{user.displayName}</dd>
            {user.username && (
              <>
                <dt>Username</dt>
                <dd>{user.username}</dd>
              </>
            )}
            <dt>Plex Pass</dt>
            <dd>{user.plexPass === null ? "Unknown" : user.plexPass ? "Active" : "Not active"}</dd>
          </dl>
          <p className="muted">Server selection, library browsing and watch parties are not built yet.</p>
          <SignOutButton />
        </section>
      ) : (
        <section className="panel">
          <h2>Host sign-in</h2>
          <p className="muted">
            You&apos;ll sign in on plex.tv. PlexTogether never sees your Plex password, and your Plex token stays on the
            PlexTogether server — it is never sent to your browser.
          </p>
          <SignInButton />
        </section>
      )}
    </>
  );
}
