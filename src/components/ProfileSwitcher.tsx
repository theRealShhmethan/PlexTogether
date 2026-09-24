"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { HomeProfile } from "@/lib/plex/home";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; profiles: HomeProfile[]; active: string | null };

/** Lets the host switch between Plex Home profiles (hidden if the account has only one). */
export function ProfileSwitcher() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [choice, setChoice] = useState<string>("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson<{ profiles: HomeProfile[]; active: string | null }>("/api/auth/profiles").then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setState({ kind: "error", message: r.error });
        return;
      }
      setState({ kind: "ready", ...r.data });
      setChoice(r.data.active ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return null;
  if (state.kind === "error") return <p className="error small">{state.message}</p>;
  if (state.profiles.length < 2) return null;

  const chosen = state.profiles.find((p) => p.uuid === choice);
  const needsPin = !!chosen && !chosen.admin && chosen.hasPin && choice !== state.active;

  async function switchProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen || choice === (state.kind === "ready" ? state.active : null)) return;
    setBusy(true);
    setError(null);
    const r = await postJson<{ active: string }>("/api/auth/profiles", {
      profileId: chosen.uuid,
      pin: needsPin ? pin : null,
    });
    setBusy(false);
    setPin("");
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setState({ kind: "ready", profiles: state.kind === "ready" ? state.profiles : [], active: r.data.active });
    router.refresh();
  }

  return (
    <form className="profile-switcher" onSubmit={switchProfile}>
      <label className="muted" htmlFor="profile">
        Plex Home profile
      </label>
      <div className="row">
        <select id="profile" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
          {state.profiles.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.title}
              {p.admin ? " (admin)" : ""}
              {p.hasPin ? " 🔒" : ""}
            </option>
          ))}
        </select>
        {needsPin && (
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{4}"
            maxLength={4}
            placeholder="PIN"
            aria-label="Profile PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            required
          />
        )}
        <button className="button" type="submit" disabled={busy || choice === state.active}>
          {busy ? "Switching…" : "Switch"}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}
