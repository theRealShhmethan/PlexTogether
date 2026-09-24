"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Plex may redirect back a moment before the PIN shows as claimed, so poll
// briefly (the docs suggest once per second).
const POLL_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 30;

type Outcome = { ok: true } | { ok: false; message: string };

// Completing a PIN is one-shot on the server, so there must be exactly one
// poller per page load — even when React (dev/StrictMode) runs effects twice.
let inflight: Promise<Outcome> | null = null;

async function completeSignIn(): Promise<Outcome> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch("/api/auth/plex/complete", { method: "POST" });
    } catch {
      return { ok: false, message: "Network error while finishing sign-in." };
    }
    if (res.status === 200) return { ok: true };
    if (res.status !== 202) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, message: body.error ?? `Sign-in failed (HTTP ${res.status})` };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, message: "Plex sign-in was not completed in time." };
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    inflight ??= completeSignIn();
    inflight.then((outcome) => {
      if (cancelled) return;
      inflight = null;
      if (outcome.ok) {
        router.replace("/");
        router.refresh();
      } else {
        setError(outcome.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <section className="panel">
      {error === null ? (
        <p>Finishing Plex sign-in…</p>
      ) : (
        <>
          <p className="error">{error}</p>
          <Link href="/">Back to start</Link>
        </>
      )}
    </section>
  );
}
