"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickConnection, type Candidate } from "@/lib/client/probe";
import { withToken } from "@/lib/client/tokenUrl";
import type { PlaybackDecision, PlaybackStart, Quality, TimelineState } from "@/lib/plex/playback";

const QUALITY_KEY = "pt_quality";
function readQuality(): Quality {
  try {
    const q = window.localStorage.getItem(QUALITY_KEY);
    return q === "original" || q === "1080" || q === "720" || q === "480" ? q : "auto";
  } catch {
    return "auto";
  }
}

export type StreamPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "loaded"; sessionId: string; decision: PlaybackDecision; location: "lan" | "wan" }
  | { kind: "error"; message: string; needsPlex?: boolean };

type StartResponse = PlaybackStart & { location: "lan" | "wan" };

/** Plex asks for a timeline report every ~10 s while playing (documented). */
const TIMELINE_INTERVAL_MS = 10_000;
/** A seek is "local" (instant) only if at least this much is buffered after the target. */
const LOCAL_SEEK_MARGIN_S = 1;
/** Network hiccups: retry loading this many times (with backoff) before starting a fresh session. */
const NETWORK_RETRIES = 3;

/**
 * Loads a Plex HLS stream into a <video> via hls.js and exposes playback in
 * MEDIA time (ms into the movie), independent of how the stream is cut.
 *
 * PLEX NOTE: the transcoder produces the stream in order from where the
 * session started, so jumping far inside a session stalls until it catches
 * up. Like Plex's own clients, a seek outside what's buffered starts a new
 * session at that `offset`. Whether the new session's playlist is numbered
 * from the offset (relative) or from the start of the movie (absolute) is
 * detected from its length, so media time stays correct either way.
 *
 * SECURITY: the start endpoint returns a transient token; it's added only to
 * requests for the Plex server's own origin (withToken) and never stored.
 */
/**
 * @param apiBase "/api/plex/playback" (solo) or "/api/rooms/<id>/playback"; provides
 *   /start, /connections and /tracks.
 */
export function usePlexStream(apiBase: string, knownDurationMs: number | null) {
  const startUrl = `${apiBase}/start`;
  /** Which server address this browser streams from (undefined = not probed yet). */
  const connectionRef = useRef<number | null | undefined>(undefined);
  /** This browser's quality choice (remembered). */
  const [quality, setQualityState] = useState<Quality>("auto");
  const qualityRef = useRef<Quality>("auto");
  useEffect(() => {
    qualityRef.current = readQuality();
    setQualityState(qualityRef.current);
  }, []);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  /** Media time at playlist time 0 for the current session. */
  const baseMsRef = useRef(0);
  const loadSeq = useRef(0);
  /** Fresh sessions started to recover from network failure since the last successful fragment. */
  const recoveriesRef = useRef(0);
  /** Lets the error handler start a fresh session without `load` referring to itself. */
  const reloadRef = useRef<((fromMs: number) => void) | null>(null);
  const [phase, setPhase] = useState<StreamPhase>({ kind: "idle" });

  const mediaTimeMs = useCallback(() => {
    const v = videoRef.current;
    return v ? baseMsRef.current + v.currentTime * 1000 : 0;
  }, []);

  const durationMs = useCallback(() => {
    if (knownDurationMs) return knownDurationMs;
    const v = videoRef.current;
    return v && Number.isFinite(v.duration) ? baseMsRef.current + v.duration * 1000 : null;
  }, [knownDurationMs]);

  const report = useCallback(
    (state: TimelineState, keepalive = false) => {
      const sessionId = sessionRef.current;
      if (!sessionId || !videoRef.current) return;
      // keepalive lets the final "stopped" report survive page unload.
      void fetch("/api/plex/playback/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, state, timeMs: Math.round(mediaTimeMs()) }),
        keepalive,
      }).catch(() => {});
    },
    [mediaTimeMs],
  );

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

  /**
   * Starts a Plex session at `fromMs` (media time) and attaches it. Resolves
   * once attached (not yet playing). `restart` keeps the current UI state.
   */
  const load = useCallback(
    async (fromMs: number, opts: { restart?: boolean } = {}): Promise<boolean> => {
      const seq = ++loadSeq.current;
      teardown();
      if (!opts.restart) setPhase({ kind: "starting" });
      if (connectionRef.current === undefined) {
        // Test the server's addresses from this browser; fall back to the server's choice.
        try {
          const r = await fetch(`${apiBase}/connections`);
          const body = r.ok ? ((await r.json()) as { connections: Candidate[] }) : null;
          connectionRef.current = body ? await pickConnection(body.connections, window.location.protocol === "https:") : null;
        } catch {
          connectionRef.current = null;
        }
        if (seq !== loadSeq.current) return false;
      }
      let res: Response;
      try {
        res = await fetch(startUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offsetMs: Math.max(0, Math.round(fromMs)),
            quality: qualityRef.current,
            ...(connectionRef.current !== null ? { connectionIndex: connectionRef.current } : {}),
          }),
        });
      } catch {
        setPhase({ kind: "error", message: "Network error while starting playback." });
        return false;
      }
      const body = (await res.json().catch(() => null)) as (StartResponse & { error?: string; needsPlex?: boolean }) | null;
      const video = videoRef.current;
      if (seq !== loadSeq.current) return false; // superseded by a newer load
      if (!res.ok || !body || !video) {
        setPhase({ kind: "error", message: body?.error ?? `Playback failed (HTTP ${res.status})`, needsPlex: body?.needsPlex });
        return false;
      }
      const { playlistUrl, transientToken, sessionId, decision, location } = body;
      const pmsOrigin = new URL(playlistUrl).origin;
      sessionRef.current = sessionId;
      // Assume the playlist starts at the offset until its length says otherwise.
      baseMsRef.current = fromMs;

      if (Hls.isSupported()) {
        const hls = new Hls({
          xhrSetup: (xhr, url) => {
            xhr.open("GET", withToken(url, pmsOrigin, transientToken), true);
          },
        });
        hlsRef.current = hls;
        let detected = false;
        let networkFailures = 0;
        hls.on(Hls.Events.FRAG_LOADED, () => {
          networkFailures = 0;
          recoveriesRef.current = 0;
        });
        hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
          if (detected) return;
          detected = true;
          const playlistMs = data.details.totalduration * 1000;
          if (knownDurationMs && fromMs > 10_000) {
            const absolute = Math.abs(playlistMs - knownDurationMs) < Math.abs(playlistMs - (knownDurationMs - fromMs));
            if (absolute) {
              baseMsRef.current = 0;
              video.currentTime = fromMs / 1000;
            }
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && seq === loadSeq.current) {
            // Brief outage (Wi-Fi/VPN blip): retry with backoff, then try a fresh Plex session here.
            if (networkFailures < NETWORK_RETRIES) {
              const delay = 1000 * 2 ** networkFailures++;
              window.setTimeout(() => {
                if (hlsRef.current === hls) hls.startLoad();
              }, delay);
              return;
            }
            if (recoveriesRef.current < 1) {
              recoveriesRef.current++;
              const at = baseMsRef.current + video.currentTime * 1000;
              connectionRef.current = undefined; // the network changed: probe again
              reloadRef.current?.(at);
              return;
            }
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
      } else {
        setPhase({ kind: "error", message: "This browser can't play HLS video." });
        return false;
      }
      setPhase({ kind: "loaded", sessionId, decision, location });
      return true;
    },
    [apiBase, startUrl, teardown, knownDurationMs],
  );

  useEffect(() => {
    reloadRef.current = (fromMs) => void load(fromMs, { restart: true });
  }, [load]);

  /** True if media time `ms` is already buffered (so a seek there is instant). */
  const isBuffered = useCallback((ms: number) => {
    const v = videoRef.current;
    if (!v) return false;
    const t = (ms - baseMsRef.current) / 1000;
    if (t < 0) return false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (t >= v.buffered.start(i) && t <= v.buffered.end(i) - LOCAL_SEEK_MARGIN_S) return true;
    }
    return false;
  }, []);

  /** Seeks to media time `ms`: instantly if buffered, otherwise via a new Plex session there. */
  const seekTo = useCallback(
    async (ms: number): Promise<"local" | "restart" | "failed"> => {
      const v = videoRef.current;
      if (!v) return "failed";
      if (isBuffered(ms)) {
        v.currentTime = (ms - baseMsRef.current) / 1000;
        return "local";
      }
      return (await load(ms, { restart: true })) ? "restart" : "failed";
    },
    [isBuffered, load],
  );

  /** Resolves when the player can play (or after `timeoutMs`). */
  const waitUntilPlayable = useCallback((timeoutMs = 20_000) => {
    return new Promise<void>((resolve) => {
      const v = videoRef.current;
      if (!v || v.readyState >= 3) return resolve();
      const done = () => {
        v.removeEventListener("canplay", done);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, timeoutMs);
      v.addEventListener("canplay", done);
    });
  }, []);

  /** Spread onto the <video>: keeps Plex's timeline in step with the player. */
  const videoEvents = {
    onPlay: () => report("playing"),
    onPause: () => report("paused"),
    onWaiting: () => report("buffering"),
    onEnded: () => report("stopped"),
  };

  /** Restarts the stream where it is (e.g. after changing audio/subtitles), keeping play/pause. */
  const reloadHere = useCallback(async () => {
    const v = videoRef.current;
    const wasPlaying = !!v && !v.paused;
    if (!(await load(mediaTimeMs(), { restart: true }))) return;
    await waitUntilPlayable();
    if (wasPlaying) void videoRef.current?.play().catch(() => {});
  }, [load, mediaTimeMs, waitUntilPlayable]);

  /** Changes quality (remembered in this browser) and reloads in place if playing. */
  const setQuality = useCallback(
    async (q: Quality) => {
      qualityRef.current = q;
      setQualityState(q);
      try {
        window.localStorage.setItem(QUALITY_KEY, q);
      } catch {
        /* not remembered, that's fine */
      }
      if (sessionRef.current) await reloadHere();
    },
    [reloadHere],
  );

  return {
    videoRef,
    apiBase,
    reloadHere,
    quality,
    setQuality,
    phase,
    setPhase,
    load,
    seekTo,
    isBuffered,
    waitUntilPlayable,
    mediaTimeMs,
    durationMs,
    teardown,
    videoEvents,
  };
}
