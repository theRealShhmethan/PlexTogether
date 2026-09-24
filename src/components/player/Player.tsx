"use client";

import type { LibraryItem } from "@/lib/plex/library";
import { formatTime } from "@/lib/format/time";
import { DecisionSummary } from "./DecisionSummary";
import { usePlexStream } from "./usePlexStream";

/** Solo host player for the watch-party pick (/watch). */
export function Player({ item }: { item: LibraryItem }) {
  const { videoRef, phase, setPhase, load, videoEvents } = usePlexStream("/api/plex/playback/start");

  async function start(fromMs: number) {
    if (await load(fromMs)) {
      void videoRef.current?.play().catch(() => {
        /* Autoplay may be blocked; the user can press play. */
      });
    }
  }

  const resumeMs = item.viewOffsetMs && item.viewOffsetMs > 60_000 ? item.viewOffsetMs : null;

  return (
    <div className="player">
      <video ref={videoRef} className="video" controls playsInline {...videoEvents} />

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
