"use client";

import { useEffect, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { AudioOutput, Quality } from "@/lib/plex/playback";
import type { Track, Tracks } from "@/lib/plex/tracks";
import { SubtitleSearch } from "./SubtitleSearch";
import { formatDelay, SUBTITLE_SIZES, type SubtitleSettings, type SubtitleSize, type SubtitleStyle } from "./subtitles";

const SIZE_LABELS: Record<SubtitleSize, string> = { small: "Small", medium: "Medium", large: "Large", huge: "Huge" };
const STYLE_LABELS: Record<SubtitleStyle, string> = { outline: "Outlined text", box: "Dark box behind text" };

/** Timing, size and style for the subtitles this viewer sees (this browser only). */
function SubtitleTiming({ settings, image }: { settings: SubtitleSettings; image: boolean }) {
  if (image) {
    return (
      <p className="muted small">
        This subtitle is made of pictures, so Plex draws it into the video and its timing can&apos;t be adjusted. Pick a
        text one (SRT) or find one online to adjust timing.
      </p>
    );
  }
  const { delayMs, setDelayMs, nudge } = settings;
  return (
    <div className="subtitle-settings">
      <div className="track-field">
        <span>Subtitle timing</span>
        <div className="delay-row" role="group" aria-label="Subtitle timing">
          <button className="button secondary small-button" onClick={() => nudge(-500)} title="Earlier by 0.5 s">
            −0.5
          </button>
          <button className="button secondary small-button" onClick={() => nudge(-100)} title="Earlier by 0.1 s (G)">
            −0.1
          </button>
          <output className="delay-value" aria-live="polite">
            {formatDelay(delayMs)}
          </output>
          <button className="button secondary small-button" onClick={() => nudge(100)} title="Later by 0.1 s (H)">
            +0.1
          </button>
          <button className="button secondary small-button" onClick={() => nudge(500)} title="Later by 0.5 s">
            +0.5
          </button>
          <button className="link-button small" onClick={() => setDelayMs(0)} disabled={delayMs === 0}>
            Reset
          </button>
        </div>
      </div>
      <p className="muted small">
        Subtitles before the speech → press <b>+</b> (or H). After it → <b>−</b> (or G). Saved for this title.
      </p>
      <div className="row">
        <label className="track-field">
          <span>Size</span>
          <select value={settings.size} onChange={(e) => settings.setSize(e.target.value as SubtitleSize)}>
            {(Object.keys(SUBTITLE_SIZES) as SubtitleSize[]).map((s) => (
              <option key={s} value={s}>
                {SIZE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="track-field">
          <span>Style</span>
          <select value={settings.style} onChange={(e) => settings.setStyle(e.target.value as SubtitleStyle)}>
            {(Object.keys(STYLE_LABELS) as SubtitleStyle[]).map((s) => (
              <option key={s} value={s}>
                {STYLE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

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
  audioOutput,
  onAudioOutput,
  subtitles,
}: {
  apiBase: string;
  onChanged: () => Promise<void>;
  quality: Quality;
  onQuality: (q: Quality) => Promise<void>;
  audioOutput: AudioOutput;
  onAudioOutput: (a: AudioOutput) => Promise<void>;
  subtitles?: SubtitleSettings;
}) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<Tracks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
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
      <button
        className="ctl"
        onClick={() => setOpen((o) => !o)}
        aria-label="Audio, subtitles and quality"
        aria-expanded={open}
      >
        <span className="cc">CC</span>
      </button>
      {open && (
        <div className="track-popover" role="dialog" aria-label="Audio and subtitles">
          {finding && (
            <SubtitleSearch
              apiBase={apiBase}
              onClose={() => setFinding(false)}
              onDownloaded={async (t, newId) => {
                setTracks(t);
                if (newId !== null) {
                  // Plex attached and selected it; reload the stream to show it.
                  await onChanged();
                  setFinding(false);
                }
              }}
            />
          )}
          {!finding && !tracks && !error && <p className="muted small">Loading tracks…</p>}
          {error && <p className="error small">{error}</p>}
          {!finding && tracks && (
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
              {subtitles && selectedId(tracks.subtitles) !== 0 && (
                <SubtitleTiming
                  settings={subtitles}
                  image={!!tracks.subtitles.find((t) => t.selected)?.image}
                />
              )}
              <button className="link-button small" onClick={() => setFinding(true)} disabled={busy}>
                {tracks.subtitles.length === 0 ? "No subtitles — find some online…" : "Find more subtitles online…"}
              </button>
              <label className="track-field">
                <span>Audio output</span>
                <select
                  value={audioOutput}
                  disabled={busy}
                  onChange={async (e) => {
                    setBusy(true);
                    await onAudioOutput(e.target.value as AudioOutput);
                    setBusy(false);
                  }}
                >
                  <option value="stereo">Stereo (headphones, laptop, TV)</option>
                  <option value="surround">Surround 5.1 / 7.1 (home theater)</option>
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
                {busy
                  ? "Switching…"
                  : "Audio and subtitle tracks are saved to your Plex account; output and quality to this browser."}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
