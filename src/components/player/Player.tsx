"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/client/api";
import { withToken } from "@/lib/client/tokenUrl";
import type { LibraryItem } from "@/lib/plex/library";
import type { PlaybackDecision, PlaybackStart, TimelineState } from "@/lib/plex/playback";
import { DecisionSummary } from "./DecisionSummary";

type StartResponse = PlaybackStart & { item: LibraryItem; location: "lan" | "wan" };

type Phase =
  | { kind: "ready" }
  | { kind: "starting" }
  | { kind: "playing"; sessionId: string; decision: PlaybackDecision; location: "lan" | "wan" }
  | { kind: "error"; message: string };

/** Plex asks for a timeline report every ~10 s while playing (documented). */
const TIMELINE_INTERVAL_MS = 10_000;

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function Player({ item }: { item: LibraryItem }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });

  const report = useCallback((state: TimelineState, keepalive = false) => {
    const sessionId = sessionRef.current;
    const video = videoRef.current;
    if (!sessionId || !video) return;
    const body = JSON.stringify({ sessionId, state, timeMs: Math.round(video.currentTime * 1000) });
    // keepalive lets the final "stopped" report survive page unload.
    void fetch("/api/plex/playback/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive,
    }).catch(() => {});
  }, []);

  const teardown = useCallback(() => {
    if (sessionRef.current) report("stopped", true);
    sessionRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, [report]);

  // Stop the Plex session when leaving the page.
  useEffect(() => {
    window.addEventListener("pagehide", teardown);
    return () => {
      window.removeEventListener("pagehide", teardown);
      teardown();
    };
  }, [teardown]);

  // Periodic timeline reports while a session is active.
  useEffect(() => {
    if (phase.kind !== "playing") return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (v) report(v.paused ? "paused" : "playing");
    }, TIMELINE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase.kind, report]);

  async function start(fromMs: number) {
    teardown();
    setPhase({ kind: "starting" });
    const r = await postJson<StartResponse>("/api/plex/playback/start", {});
    const video = videoRef.current;
    if (!r.ok || !video) {
      setPhase({ kind: "error", message: r.ok ? "Player not ready" : r.error });
      return;
    }
    const { playlistUrl, transientToken, sessionId, decision, location } = r.data;
    const pmsOrigin = new URL(playlistUrl).origin;
    sessionRef.current = sessionId;

    if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition: fromMs / 1000,
        xhrSetup: (xhr, url) => {
          xhr.open("GET", withToken(url, pmsOrigin, transientToken), true);
        },
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        const hint =
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? " Your browser couldn't load the stream from the Plex server — check that this computer can reach it (VPN/remote access)."
            : "";
        setPhase({ kind: "error", message: `Playback failed (${data.details}).${hint}` });
        teardown();
      });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS (Safari without MSE). Only the playlist request carries the token here.
      video.src = withToken(playlistUrl, pmsOrigin, transientToken);
      video.addEventListener("loadedmetadata", () => (video.currentTime = fromMs / 1000), { once: true });
    } else {
      setPhase({ kind: "error", message: "This browser can't play HLS video." });
      return;
    }
    setPhase({ kind: "playing", sessionId, decision, location });
    void video.play().catch(() => {
      /* Autoplay may be blocked; the user can press play. */
    });
  }

  const resumeMs = item.viewOffsetMs && item.viewOffsetMs > 60_000 ? item.viewOffsetMs : null;

  return (
    <div className="player">
      <video
        ref={videoRef}
        className="video"
        controls
        playsInline
        onPlay={() => report("playing")}
        onPause={() => report("paused")}
        onSeeked={() => report(videoRef.current?.paused ? "paused" : "playing")}
        onWaiting={() => report("buffering")}
        onEnded={() => report("stopped")}
      />

      {phase.kind === "ready" && (
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
      {phase.kind === "playing" && <DecisionSummary decision={phase.decision} location={phase.location} />}
      {phase.kind === "error" && (
        <div className="status bad">
          <strong className="error">{phase.message}</strong>
          <button className="button secondary" onClick={() => setPhase({ kind: "ready" })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
