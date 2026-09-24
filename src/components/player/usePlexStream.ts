"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { withToken } from "@/lib/client/tokenUrl";
import type { PlaybackDecision, PlaybackStart, TimelineState } from "@/lib/plex/playback";

export type StreamPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "loaded"; sessionId: string; decision: PlaybackDecision; location: "lan" | "wan" }
  | { kind: "error"; message: string; needsPlex?: boolean };

type StartResponse = PlaybackStart & { location: "lan" | "wan" };

/** Plex asks for a timeline report every ~10 s while playing (documented). */
const TIMELINE_INTERVAL_MS = 10_000;

/**
 * Loads a Plex HLS stream into a <video> via hls.js, from one of our start
 * endpoints, and keeps Plex's timeline updated. Shared by the solo player and
 * the room player.
 *
 * SECURITY: the start endpoint returns a transient token; it's added only to
 * requests for the Plex server's own origin (withToken) and never stored.
 */
export function usePlexStream(startUrl: string) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<StreamPhase>({ kind: "idle" });

  const report = useCallback((state: TimelineState, keepalive = false) => {
    const sessionId = sessionRef.current;
    const video = videoRef.current;
    if (!sessionId || !video) return;
    // keepalive lets the final "stopped" report survive page unload.
    void fetch("/api/plex/playback/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, state, timeMs: Math.round(video.currentTime * 1000) }),
      keepalive,
    }).catch(() => {});
  }, []);

  const teardown = useCallback(() => {
    if (sessionRef.current) report("stopped", true);
    sessionRef.current = null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
  }, [report]);

  useEffect(() => {
    window.addEventListener("pagehide", teardown);
    return () => {
      window.removeEventListener("pagehide", teardown);
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    if (phase.kind !== "loaded") return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (v) report(v.paused ? "paused" : "playing");
    }, TIMELINE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase.kind, report]);

  /** Starts a Plex session and loads it at `fromMs`. Resolves once the stream is attached (not yet playing). */
  const load = useCallback(
    async (fromMs: number): Promise<boolean> => {
      teardown();
      setPhase({ kind: "starting" });
      let res: Response;
      try {
        res = await fetch(startUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch {
        setPhase({ kind: "error", message: "Network error while starting playback." });
        return false;
      }
      const body = (await res.json().catch(() => null)) as (StartResponse & { error?: string; needsPlex?: boolean }) | null;
      const video = videoRef.current;
      if (!res.ok || !body || !video) {
        setPhase({ kind: "error", message: body?.error ?? `Playback failed (HTTP ${res.status})`, needsPlex: body?.needsPlex });
        return false;
      }
      const { playlistUrl, transientToken, sessionId, decision, location } = body;
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
        return false;
      }
      setPhase({ kind: "loaded", sessionId, decision, location });
      return true;
    },
    [startUrl, teardown],
  );

  /** Spread onto the <video>: keeps Plex's timeline in step with the player. */
  const videoEvents = {
    onPlay: () => report("playing"),
    onPause: () => report("paused"),
    onSeeked: () => report(videoRef.current?.paused ? "paused" : "playing"),
    onWaiting: () => report("buffering"),
    onEnded: () => report("stopped"),
  };

  return { videoRef, phase, setPhase, load, teardown, videoEvents };
}
