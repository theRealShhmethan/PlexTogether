import Link from "next/link";
import { JoinBox } from "@/components/JoinBox";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { ServerPicker } from "@/components/ServerPicker";
import { SignInButton } from "@/components/SignInButton";
import { SignOutButton } from "@/components/SignOutButton";
import { roomForHost } from "@/lib/rooms/hub";
import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

export default async function Home() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <section className="hero">
          <span className="eyebrow">Movie night, miles apart</span>
          <h1>
            Watch Plex together, <span className="gradient-text">perfectly in sync.</span>
          </h1>
          <p className="lead">
            Press play once and everyone&apos;s screen follows — pauses, skips and all. Your Plex server streams the
            video; PlexTogether keeps you together.
          </p>
        </section>

        <div className="cards">
          <section className="panel action-card">
            <div className="card-icon" aria-hidden="true">
              🎟️
            </div>
            <h2>Join a watch party</h2>
            <p className="muted">Got an invite link? Paste it here. No PlexTogether account needed.</p>
            <JoinBox />
          </section>

          <section className="panel action-card">
            <div className="card-icon" aria-hidden="true">
              🎬
            </div>
            <h2>Host a watch party</h2>
            <p className="muted">
              Sign in on plex.tv to pick something from your library. PlexTogether never sees your password, and your
              Plex token never reaches your browser.
            </p>
            <SignInButton />
          </section>
        </div>
      </>
    );
  }

  const user = toPublicUser(session);
  const name = user.profile ?? user.displayName;
  const room = roomForHost(session.id);
  const server = session.selectedServer;

  return (
    <>
      <section className="hero">
        <span className="eyebrow">Welcome back</span>
        <h1>Hi, {name}</h1>
        <p className="lead">What are we watching?</p>
      </section>

      {room && (
        <div className="live-banner">
          <span className="live-dot" aria-hidden="true" />
          <span>
            <strong>Your watch party is live</strong> <span className="muted">· {room.title}</span>
          </span>
          <Link className="button small-button" href={`/r/${room.id}`} style={{ marginLeft: "auto" }}>
            Open room
          </Link>
        </div>
      )}

      <div className="cards">
        <section className="panel action-card">
          <div className="card-icon" aria-hidden="true">
            🍿
          </div>
          <h2>Start a movie or show</h2>
          <p className="muted">
            {server
              ? `Browse ${server.name}, pick something, and invite someone to watch with you.`
              : "First choose your Plex server below."}
          </p>
          {server ? (
            <Link className="button big" href="/browse">
              Browse library →
            </Link>
          ) : (
            <a className="button big secondary" href="#setup">
              Choose a server ↓
            </a>
          )}
        </section>

        <section className="panel action-card">
          <div className="card-icon" aria-hidden="true">
            🎟️
          </div>
          <h2>Join a room</h2>
          <p className="muted">Someone invited you? Paste their link.</p>
          <JoinBox />
        </section>
      </div>

      <h2 className="section-title" id="setup">
        Your setup
      </h2>
      <div className="setup-grid">
        <section className="panel">
          <h2>Plex account</h2>
          <dl>
            <dt>Account</dt>
            <dd>{user.displayName}</dd>
            {user.profile && (
              <>
                <dt>Profile</dt>
                <dd>{user.profile}</dd>
              </>
            )}
            <dt>Plex Pass</dt>
            <dd>{user.plexPass === null ? "Unknown" : user.plexPass ? "Active" : "Not active"}</dd>
          </dl>
          <ProfileSwitcher />
          <SignOutButton />
        </section>
        <ServerPicker key={user.profile ?? "account"} />
      </div>
    </>
  );
}
