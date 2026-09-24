"use client";

import { useEffect, useRef, useState } from "react";
import { DecisionSummary } from "@/components/player/DecisionSummary";
import { usePlexStream } from "@/components/player/usePlexStream";
import { SignInButton } from "@/components/SignInButton";
import type { ClientMessage } from "@/lib/rooms/protocol";
import { correctionFor, driftLabel, expectedPositionMs, type PlaybackAnchor } from "@/lib/sync/drift";

const SYNC_LOOP_MS = 500;
const STATUS_MS = 1000;
const HOST_TICK_MS = 2000;
/** After a hard seek, give HLS time to fetch/decode before judging drift again. */
const SEEK_COOLDOWN_MS = 3000;
/** Ignore player events we caused ourselves for this long. */
const SUPPRESS_MS = 800;

type Props = {
  roomId: string;
  isHost: boolean;
  playback: PlaybackAnchor;
  serverNow: () => number;
  rttMs: number | null;
  send: (msg: ClientMessage) => void;
  connected: boolean;
  canStart: boolean;
  startHint: string;
};

/**
 * The synced player. Host-authoritative:
 * - the host's own play/pause/seek go to the server, which anchors them in server time;
 * - guests follow the anchor, correcting drift (see src/lib/sync/drift.ts);
 * - "Start Together" schedules a start a moment ahead so everyone begins at once.
 */
export function RoomPlayer(props: Props) {
  const { roomId, isHost, playback, serverNow, rttMs, send, connected, canStart, startHint } = props;
  const { videoRef, phase, setPhase, load, videoEvents } = usePlexStream(`/api/rooms/${roomId}/playback/start`);

  const anchorRef = useRef(playback);
  const rttRef = useRef(rttMs);
  useEffect(() => {
    anchorRef.current = playback;
    rttRef.current = rttMs;
  }, [playback, rttMs]);

  const [canPlay, setCanPlay] = useState(false);
  const [drift, setDrift] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const bufferingRef = useRef(false);
  const driftRef = useRef<number | null>(null);
  const nudgingRef = useRef(false);
  const seekCooldownUntil = useRef(0);
  const suppressUntil = useRef(0);
  // Server time of the host's last own action; anchors newer than this weren't made by us (e.g. Start Together).
  const lastHostAction = useRef(0);

  const loaded = phase.kind === "loaded";
  const playerReady = loaded && canPlay;

  /** Programmatic player changes, flagged so the host doesn't echo them back as its own actions. */
  const quietly = (fn: (v: HTMLVideoElement) => void) => {
    const v = videoRef.current;
    if (!v) return;
    suppressUntil.current = performance.now() + SUPPRESS_MS;
    fn(v);
  };

  function hostSend(action: "play" | "pause" | "seek" | "tick") {
    const v = videoRef.current;
    if (!isHost || !v) return;
    lastHostAction.current = serverNow();
    send({ type: "host", action, positionMs: Math.round(v.currentTime * 1000), latencyMs: (rttRef.current ?? 0) / 2 });
  }
  const userEvent = (action: "play" | "pause" | "seek") => () => {
    if (performance.now() < suppressUntil.current) return;
    hostSend(action);
  };

  // --- the sync loop ---
  useEffect(() => {
    if (!loaded) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      const a = anchorRef.current;
      const now = serverNow();
      const actual = v.currentTime * 1000;
      const due = a.status === "playing" && now >= a.anchorServerTime;
      setCountdown(a.status === "playing" && !due ? Math.ceil((a.anchorServerTime - now) / 1000) : null);

      if (isHost) {
        // The host only follows anchors it didn't create: a scheduled Start Together.
        if (a.status === "playing" && a.anchorServerTime > lastHostAction.current) {
          if (!due) {
            if (!v.paused) quietly((x) => x.pause());
            if (Math.abs(actual - a.positionMs) > 500) quietly((x) => (x.currentTime = a.positionMs / 1000));
          } else if (v.paused) {
            lastHostAction.current = a.anchorServerTime;
            quietly((x) => {
              x.currentTime = expectedPositionMs(a, now) / 1000;
              void x.play().catch(() => {});
            });
          } else {
            lastHostAction.current = a.anchorServerTime;
          }
        }
        return;
      }

      // Guests.
      const expected = expectedPositionMs(a, now);
      driftRef.current = a.status === "idle" ? null : actual - expected;
      setDrift(driftRef.current);
      if (!due) {
        if (!v.paused) v.pause();
        v.playbackRate = 1;
        nudgingRef.current = false;
        if (Math.abs(actual - expected) > 500 && performance.now() > seekCooldownUntil.current) {
          v.currentTime = expected / 1000;
          seekCooldownUntil.current = performance.now() + SEEK_COOLDOWN_MS;
        }
        return;
      }
      if (v.paused) {
        v.currentTime = expected / 1000;
        seekCooldownUntil.current = performance.now() + SEEK_COOLDOWN_MS;
        void v.play().catch(() => {});
        return;
      }
      if (bufferingRef.current || performance.now() < seekCooldownUntil.current) return;
      const c = correctionFor(actual, expected, nudgingRef.current);
      if (c.kind === "seek") {
        v.playbackRate = 1;
        nudgingRef.current = false;
        v.currentTime = c.toMs / 1000;
        seekCooldownUntil.current = performance.now() + SEEK_COOLDOWN_MS;
      } else {
        v.playbackRate = c.rate;
        nudgingRef.current = c.kind === "rate";
      }
    }, SYNC_LOOP_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable callbacks only
  }, [loaded, isHost, serverNow]);

  // --- status to the room, host ticks ---
  useEffect(() => {
    if (!connected) return;
    const status = window.setInterval(() => {
      send({
        type: "status",
        playerReady,
        buffering: bufferingRef.current,
        driftMs: isHost || driftRef.current === null ? null : Math.round(driftRef.current),
      });
    }, STATUS_MS);
    const tick = isHost
      ? window.setInterval(() => {
          const v = videoRef.current;
          if (v && !v.paused && anchorRef.current.status === "playing" && serverNow() >= anchorRef.current.anchorServerTime) {
            hostSend("tick");
          }
        }, HOST_TICK_MS)
      : undefined;
    return () => {
      window.clearInterval(status);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hostSend reads refs only
  }, [connected, playerReady, isHost, send, serverNow]);

  async function getReady() {
    setCanPlay(false);
    const ok = await load(expectedPositionMs(anchorRef.current, serverNow()));
    if (ok) send({ type: "ready", ready: true });
  }

  function startTogether() {
    const v = videoRef.current;
    if (!v) return;
    lastHostAction.current = 0;
    send({ type: "start", positionMs: Math.round(v.currentTime * 1000) });
  }

  const guestFollowing = !isHost && playback.status === "playing";

  return (
    <div className="player">
      <video
        ref={videoRef}
        className={loaded ? "video" : "video hidden"}
        controls
        playsInline
        onPlay={() => {
          videoEvents.onPlay();
          userEvent("play")();
        }}
        onPause={() => {
          videoEvents.onPause();
          userEvent("pause")();
        }}
        onSeeked={() => {
          videoEvents.onSeeked();
          userEvent("seek")();
        }}
        onWaiting={() => {
          videoEvents.onWaiting();
          bufferingRef.current = true;
        }}
        onPlaying={() => (bufferingRef.current = false)}
        onCanPlay={() => {
          bufferingRef.current = false;
          setCanPlay(true);
        }}
        onEnded={videoEvents.onEnded}
      />

      {phase.kind === "idle" && (
        <div className="row">
          <button className="button" onClick={() => void getReady()} disabled={!connected}>
            Get ready (load the video)
          </button>
        </div>
      )}
      {phase.kind === "starting" && <p className="muted">Asking Plex to prepare the stream…</p>}
      {phase.kind === "error" && (
        <div className="status bad">
          <strong className="error">{phase.message}</strong>
          {phase.needsPlex ? (
            <>
              <p className="muted small">
                Watching uses your own Plex account, so the host never shares theirs. Your account needs access to the
                host&apos;s server.
              </p>
              <SignInButton returnTo={`/r/${roomId}`} />
            </>
          ) : (
            <button className="button secondary" onClick={() => setPhase({ kind: "idle" })}>
              Try again
            </button>
          )}
        </div>
      )}

      {loaded && (
        <div className="row sync-bar">
          {countdown !== null ? (
            <strong>Starting in {countdown}…</strong>
          ) : isHost ? (
            <>
              <span className="muted small">You&apos;re in control — play, pause and seek as normal.</span>
              <button className="button" onClick={startTogether} disabled={!canStart || !playerReady} title={startHint}>
                Start Together
              </button>
            </>
          ) : (
            <span className={drift !== null && Math.abs(drift) < 250 ? "sync ok" : "sync"}>
              {playback.status === "idle" ? "Waiting for the host to start…" : driftLabel(drift)}
              {guestFollowing ? "" : playback.status === "paused" ? " · host paused" : ""}
            </span>
          )}
        </div>
      )}
      {loaded && isHost && !canStart && <p className="muted small">{startHint}</p>}
      {phase.kind === "loaded" && <DecisionSummary decision={phase.decision} location={phase.location} />}
      {!isHost && loaded && <p className="muted small">The host controls playback; your player follows along.</p>}
    </div>
  );
}
