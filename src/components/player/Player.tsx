"use client";

import { useRef, useState } from "react";
import { formatTime } from "@/lib/format/time";
import type { LibraryItem } from "@/lib/plex/library";
import { DecisionSummary } from "./DecisionSummary";
import { PlayerControls } from "./PlayerControls";
import { usePlexStream } from "./usePlexStream";

/** Solo host player for the watch-party pick (/watch). */
export function Player({ item }: { item: LibraryItem }) {
  const stream = usePlexStream("/api/plex/playback/start", item.durationMs);
  const { videoRef, phase, setPhase, load, videoEvents } = stream;
  const containerRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function start(fromMs: number) {
    if (!(await load(fromMs))) return;
    await stream.waitUntilPlayable();
    void videoRef.current?.play().catch(() => {
      /* Autoplay may be blocked; the user can press play. */
    });
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }

  async function seek(ms: number) {
    const v = videoRef.current;
    if (!v) return;
    const wasPlaying = !v.paused;
    v.pause();
    setBusy("Loading…");
    const r = await stream.seekTo(ms);
    if (r !== "failed") await stream.waitUntilPlayable();
    setBusy(null);
    if (wasPlaying) void videoRef.current?.play().catch(() => {});
  }

  const resumeMs = item.viewOffsetMs && item.viewOffsetMs > 60_000 ? item.viewOffsetMs : null;
  const loaded = phase.kind === "loaded";

  return (
    <div className="player">
      <div ref={containerRef} className={loaded ? "video-box" : "video-box hidden"}>
        <video ref={videoRef} className="video" playsInline onClick={togglePlay} {...videoEvents} />
        <PlayerControls
          videoRef={videoRef}
          containerRef={containerRef}
          mediaTimeMs={stream.mediaTimeMs}
          durationMs={stream.durationMs}
          onTogglePlay={togglePlay}
          onSeek={(ms) => void seek(ms)}
          busyLabel={busy}
        />
      </div>

      {phase.kind === "idle" && (
        <div className="row">
          {resumeMs !== null && (
            <button className="button" onClick={() => void start(resumeMs)}>
              ▶ Resume from {formatTime(resumeMs)}
            </button>
          )}
          <button className={resumeMs !== null ? "button secondary" : "button"} onClick={() => void start(0)}>
            ▶ Play from the beginning
          </button>
        </div>
      )}
      {phase.kind === "starting" && <p className="muted">Asking Plex to prepare the stream…</p>}
      {phase.kind === "loaded" && <DecisionSummary decision={phase.decision} location={phase.location} />}
      {phase.kind === "error" && (
        <div className="status bad">
          <strong className="error">{phase.message}</strong>
          <button className="button secondary" onClick={() => setPhase({ kind: "idle" })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
