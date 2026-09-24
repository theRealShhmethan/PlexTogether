"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error(`Sign-out failed (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-out failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="button secondary" onClick={signOut} disabled={busy}>
        Sign out
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
