"use client";

import { useEffect, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { Quality } from "@/lib/plex/playback";
import type { Track, Tracks } from "@/lib/plex/tracks";

const QUALITY_LABELS: Record<Quality, string> = {
  auto: "Auto (best for your connection)",
  original: "Original",
  "1080": "1080p (8 Mbps)",
  "720": "720p (4 Mbps)",
  "480": "480p (1.5 Mbps)",
};

/**
 * Audio language and subtitle picker. Each viewer chooses their own; the
 * choice is saved on their Plex account and the stream restarts in place.
 */
export function TrackMenu({
  apiBase,
  onChanged,
  quality,
  onQuality,
}: {
  apiBase: string;
  onChanged: () => Promise<void>;
  quality: Quality;
  onQuality: (q: Quality) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<Tracks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getJson<Tracks>(`${apiBase}/tracks`).then((r) => {
      if (cancelled) return;
      if (r.ok) setTracks(r.data);
      else setError(r.error);
    });
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open, apiBase]);

  async function choose(change: { audioStreamId?: number; subtitleStreamId?: number }) {
    setBusy(true);
    setError(null);
    const r = await postJson<Tracks>(`${apiBase}/tracks`, change);
    if (!r.ok) {
      setError(r.error);
      setBusy(false);
      return;
    }
    setTracks(r.data);
    await onChanged();
    setBusy(false);
  }

  const selectedId = (list: Track[]) => list.find((t) => t.selected)?.id ?? 0;

  return (
    <div className="track-menu" ref={ref}>
      <button className="ctl" onClick={() => setOpen((o) => !o)} aria-label="Audio, subtitles and quality" aria-expanded={open}>
        <span className="cc">CC</span>
      </button>
      {open && (
        <div className="track-popover" role="dialog" aria-label="Audio and subtitles">
          {!tracks && !error && <p className="muted small">Loading tracks…</p>}
          {error && <p className="error small">{error}</p>}
          {tracks && (
            <>
              <label className="track-field">
                <span>Audio</span>
                <select
                  value={selectedId(tracks.audio)}
                  disabled={busy || tracks.audio.length < 2}
                  onChange={(e) => void choose({ audioStreamId: Number(e.target.value) })}
                >
                  {tracks.audio.length === 0 && <option value={0}>Default</option>}
                  {tracks.audio.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="track-field">
                <span>Subtitles</span>
                <select
                  value={selectedId(tracks.subtitles)}
                  disabled={busy}
                  onChange={(e) => void choose({ subtitleStreamId: Number(e.target.value) })}
                >
                  <option value={0}>Off</option>
                  {tracks.subtitles.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                      {t.external ? " (file)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="track-field">
                <span>Quality</span>
                <select
                  value={quality}
                  disabled={busy}
                  onChange={async (e) => {
                    setBusy(true);
                    await onQuality(e.target.value as Quality);
                    setBusy(false);
                  }}
                >
                  {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
                    <option key={q} value={q}>
                      {QUALITY_LABELS[q]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                {busy ? "Switching…" : "Audio and subtitles are saved to your Plex account; quality to this browser."}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
