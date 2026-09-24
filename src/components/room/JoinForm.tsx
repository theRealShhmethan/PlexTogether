"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client/api";

/** Guest entry: just a display name. No account. */
export function JoinForm({ roomId, title, code }: { roomId: string; title: string; code: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson<{ ok: true }>(`/api/rooms/${roomId}/join`, { name });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="panel">
      <h2>You&apos;re invited to a watch party</h2>
      <p>
        <strong>{title}</strong> <span className="muted">· Room {code}</span>
      </p>
      <form className="row" onSubmit={join}>
        <input
          aria-label="Your name"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          autoFocus
          required
        />
        <button className="button" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Joining…" : "Join"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <p className="muted small">No account needed. Your name is only shown to people in this room.</p>
    </section>
  );
}
