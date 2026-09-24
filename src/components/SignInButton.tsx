"use client";

import { useState } from "react";

export function SignInButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/plex/start", { method: "POST" });
      const body = (await res.json()) as { authUrl?: string; error?: string };
      if (!res.ok || !body.authUrl) throw new Error(body.error ?? `Sign-in failed (HTTP ${res.status})`);
      // Full-page redirect to app.plex.tv; Plex sends us back to /auth/callback.
      window.location.assign(body.authUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <>
      <button className="button" onClick={signIn} disabled={busy}>
        {busy ? "Redirecting to Plex…" : "Sign in with Plex"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
