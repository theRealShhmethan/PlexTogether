"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * Extracts a room id from a pasted invite link (or a bare id).
 *
 * SECURITY: only the full 128-bit id works. The short code shown in a room is
 * a label, not a key — a 6-character code could be guessed.
 */
export function roomIdFrom(input: string): string | null {
  const text = input.trim();
  if (ROOM_ID.test(text)) return text;
  const m = text.match(/\/r\/([A-Za-z0-9_-]{22})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function JoinBox({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const id = roomIdFrom(value);
    if (!id) {
      setError("That doesn't look like an invite link. Paste the whole link the host sent you (it contains /r/…).");
      return;
    }
    router.push(`/r/${id}`);
  }

  return (
    <form className="join-box" onSubmit={join}>
      <div className="row">
        <input
          aria-label="Invite link"
          placeholder="Paste your invite link"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          autoFocus={autoFocus}
          spellCheck={false}
        />
        <button className="button" type="submit" disabled={!value.trim()}>
          Join
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
