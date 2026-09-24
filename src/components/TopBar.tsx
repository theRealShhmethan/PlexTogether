import Link from "next/link";
import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="pt-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e5a00d" />
          <stop offset="1" stopColor="#f6c453" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="16" r="10" fill="url(#pt-g)" opacity="0.55" />
      <circle cx="20" cy="16" r="10" fill="url(#pt-g)" />
      <path d="M17 11.5v9l7-4.5z" fill="#1a1204" />
    </svg>
  );
}

/** Top navigation. Server-rendered from the session. */
export async function TopBar() {
  const session = await getCurrentSession();
  const user = session ? toPublicUser(session) : null;
  const name = user ? (user.profile ?? user.displayName) : null;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          <BrandMark />
          PlexTogether
        </Link>
        {user && (
          <nav className="nav" aria-label="Main">
            <Link href="/">Home</Link>
            <Link href="/browse">Browse</Link>
          </nav>
        )}
        <div className="topbar-right">
          {name && (
            <span className="chip" title={user?.profile ? `Profile of ${user.displayName}` : undefined}>
              <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
              {name}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
