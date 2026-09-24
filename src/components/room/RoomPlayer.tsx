"use client";

import { useEffect, useRef, useState } from "react";
import { DecisionSummary } from "@/components/player/DecisionSummary";
import { PlayerControls } from "@/components/player/PlayerControls";
import { usePlexStream } from "@/components/player/usePlexStream";
import { SignInButton } from "@/components/SignInButton";
import type { ClientMessage, Permissions } from "@/lib/rooms/protocol";
import { correctionFor, DRIFT, driftLabel, expectedPositionMs, type PlaybackAnchor } from "@/lib/sync/drift";

const SYNC_LOOP_MS = 250;
const STATUS_MS = 1000;
const TICK_MS = 2000;
/** After a hard seek, give HLS time to fetch/decode before judging drift again. */
const SEEK_COOLDOWN_MS = 2000;
/** A buffered (instant) seek lands this far ahead, then holds until the room reaches it. */
const LOCAL_SEEK_LEAD_MS = 300;
/** First guess at how long a new Plex session takes to become playable; learned from experience. */
const INITIAL_RESTART_MS = 4000;
/** Paused and ahead of the room by at most this → wait for the room rather than seek back. */
const HOLD_MAX_MS = 10_000;

type Props = {
  roomId: string;
  me: string;
  isHost: boolean;
  permissions: Permissions;
  playback: PlaybackAnchor;
  durationMs: number | null;
  serverNow: () => number;
  rttMs: number | null;
  send: (msg: ClientMessage) => void;
  connected: boolean;
  canStart: boolean;
  startHint: string;
  nameOf: (id: string | null) => string | null;
};

/**
 * The synced player.
 *
 * Whoever last played, paused or seeked (anchor.by) is the reference: their
 * player isn't corrected. Everyone else follows the anchor in server time
 * (see src/lib/sync/drift.ts). "Start Together" (by = null) is followed by all.
 *
 * Seeking far means a new Plex session, which takes a few seconds; so a
 * follower seeks slightly AHEAD of the room and holds there until the room
 * catches up, then plays — rather than arriving late and chasing.
 */
export function RoomPlayer(props: Props) {
  const { roomId, me, isHost, permissions, playback, durationMs, serverNow, rttMs, send, connected } = props;
  const stream = usePlexStream(`/api/rooms/${roomId}/playback/start`, durationMs);
  const { videoRef, phase, setPhase, load, mediaTimeMs, videoEvents } = stream;
  const containerRef = useRef<HTMLDivElement>(null);

  const anchorRef = useRef(playback);
  const rttRef = useRef(rttMs);
  useEffect(() => {
    anchorRef.current = playback;
    rttRef.current = rttMs;
  }, [playback, rttMs]);

  const [canPlay, setCanPlay] = useState(false);
  const [drift, setDrift] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const bufferingRef = useRef(false);
  const driftRef = useRef<number | null>(null);
  const nudgingRef = useRef(false);
  const seekingRef = useRef(false);
  const cooldownUntil = useRef(0);
  const holdTimer = useRef<number | undefined>(undefined);
  const restartMsRef = useRef(INITIAL_RESTART_MS);

  const loaded = phase.kind === "loaded";
  const playerReady = loaded && canPlay;
  const canPlayPause = isHost || permissions.playPause;
  const canSeek = isHost || permissions.seek;

  function control(action: "play" | "pause" | "seek" | "tick", positionMs = mediaTimeMs()) {
    send({ type: "control", action, positionMs: Math.round(positionMs), latencyMs: (rttRef.current ?? 0) / 2 });
  }

  /** Repositions this player to media time `ms`, measuring how long a new session takes. */
  async function reposition(ms: number) {
    const v = videoRef.current;
    if (!v || seekingRef.current) return;
    seekingRef.current = true;
    v.pause();
    const started = performance.now();
    const how = await stream.seekTo(ms);
    if (how === "restart") {
      await stream.waitUntilPlayable();
      // Learn the restart time (smoothed) so the next lead is about right.
      restartMsRef.current = 0.5 * restartMsRef.current + 0.5 * (performance.now() - started);
    }
    cooldownUntil.current = performance.now() + SEEK_COOLDOWN_MS;
    seekingRef.current = false;
  }

  // --- follow the room ---
  useEffect(() => {
    if (!loaded) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || seekingRef.current) return;
      const a = anchorRef.current;
      const now = serverNow();
      const due = a.status === "playing" && now >= a.anchorServerTime;
      setCountdown(a.status === "playing" && !due ? Math.ceil((a.anchorServerTime - now) / 1000) : null);

      // The reference player sets the pace and is never corrected.
      if (a.by === me || a.status === "idle") {
        driftRef.current = null;
        setDrift(null);
        return;
      }

      const expected = expectedPositionMs(a, now);
      const actual = mediaTimeMs();
      const ahead = actual - expected;
      driftRef.current = ahead;
      setDrift(ahead);

      if (!due) {
        // Paused (or a scheduled start not yet due): sit at the right spot.
        if (!v.paused) v.pause();
        v.playbackRate = 1;
        nudgingRef.current = false;
        if (Math.abs(ahead) > 500 && performance.now() > cooldownUntil.current) void reposition(expected);
        return;
      }

      if (v.paused) {
        if (ahead > 0 && ahead < HOLD_MAX_MS) {
          // Ahead after a seek: wait for the room, starting precisely on time.
          if (ahead < SYNC_LOOP_MS * 2 && holdTimer.current === undefined) {
            holdTimer.current = window.setTimeout(() => {
              holdTimer.current = undefined;
              void videoRef.current?.play().catch(() => {});
            }, ahead);
          }
          return;
        }
        if (ahead <= 0 && ahead > -DRIFT.ignoreMs) {
          void v.play().catch(() => {});
          return;
        }
        const lead = stream.isBuffered(expected + LOCAL_SEEK_LEAD_MS) ? LOCAL_SEEK_LEAD_MS : restartMsRef.current + 1000;
        void reposition(expected + lead);
        return;
      }

      if (bufferingRef.current || performance.now() < cooldownUntil.current) return;
      const c = correctionFor(actual, expected, nudgingRef.current);
      if (c.kind === "seek") {
        v.playbackRate = 1;
        nudgingRef.current = false;
        const lead = stream.isBuffered(expected + LOCAL_SEEK_LEAD_MS) ? LOCAL_SEEK_LEAD_MS : restartMsRef.current + 1000;
        void reposition(expected + lead);
      } else {
        v.playbackRate = c.rate;
        nudgingRef.current = c.kind === "rate";
      }
    }, SYNC_LOOP_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable callbacks only
  }, [loaded, me, serverNow]);

  // --- status to the room; the reference player keeps the anchor fresh ---
  useEffect(() => {
    if (!connected) return;
    const status = window.setInterval(() => {
      send({
        type: "status",
        playerReady,
        buffering: bufferingRef.current,
        driftMs: driftRef.current === null ? null : Math.round(driftRef.current),
      });
    }, STATUS_MS);
    const tick = window.setInterval(() => {
      const v = videoRef.current;
      const a = anchorRef.current;
      if (v && !v.paused && !seekingRef.current && !bufferingRef.current && a.by === me && a.status === "playing") {
        control("tick");
      }
    }, TICK_MS);
    return () => {
      window.clearInterval(status);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- control reads refs only
  }, [connected, playerReady, me, send]);

  // --- this participant's own actions ---
  function togglePlay() {
    const v = videoRef.current;
    if (!v || !canPlayPause) return;
    if (v.paused) {
      void v.play().catch(() => {});
      control("play");
    } else {
      v.pause();
      control("pause");
    }
  }

  async function seek(ms: number) {
    const v = videoRef.current;
    if (!v || !canSeek) return;
    const wasPlaying = anchorRef.current.status === "playing";
    // With play/pause rights, hold the room at the new spot until this player is ready, then resume together.
    if (wasPlaying && canPlayPause) control("pause", ms);
    else control("seek", ms);
    setBusy("Loading…");
    await reposition(ms);
    setBusy(null);
    if (wasPlaying && canPlayPause) {
      void videoRef.current?.play().catch(() => {});
      control("play");
    }
  }

  async function getReady() {
    setCanPlay(false);
    const a = anchorRef.current;
    const now = serverNow();
    // If the room is already playing, load a little ahead and let the hold logic start us on time.
    const at = expectedPositionMs(a, now) + (a.status === "playing" && now >= a.anchorServerTime ? INITIAL_RESTART_MS : 0);
    if (await load(at)) send({ type: "ready", ready: true });
  }

  function startTogether() {
    send({ type: "start", positionMs: Math.round(mediaTimeMs()) });
  }

  const leader = playback.by === me ? "you" : props.nameOf(playback.by);

  return (
    <div className="player">
      <div ref={containerRef} className={loaded ? "video-box" : "video-box hidden"}>
        <video
          ref={videoRef}
          className="video"
          playsInline
          onClick={togglePlay}
          onPlay={videoEvents.onPlay}
          onPause={videoEvents.onPause}
          onEnded={videoEvents.onEnded}
          onWaiting={() => {
            videoEvents.onWaiting();
            bufferingRef.current = true;
          }}
          onPlaying={() => (bufferingRef.current = false)}
          onCanPlay={() => {
            bufferingRef.current = false;
            setCanPlay(true);
          }}
        />
        <PlayerControls
          videoRef={videoRef}
          containerRef={containerRef}
          mediaTimeMs={mediaTimeMs}
          durationMs={stream.durationMs}
          onTogglePlay={canPlayPause ? togglePlay : null}
          onSeek={canSeek ? (ms) => void seek(ms) : null}
          busyLabel={busy}
        />
      </div>

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
          ) : playback.status === "idle" ? (
            isHost ? (
              <>
                <span className="muted small">When everyone&apos;s ready, start together.</span>
                <button className="button" onClick={startTogether} disabled={!props.canStart || !playerReady} title={props.startHint}>
                  Start Together
                </button>
              </>
            ) : (
              <span className="muted">Waiting for the host to start…</span>
            )
          ) : playback.by === me ? (
            <span className="muted small">
              You {playback.status === "paused" ? "paused" : "set the pace"} — everyone follows you.
            </span>
          ) : (
            <span className={drift !== null && Math.abs(drift) < DRIFT.ignoreMs ? "sync ok" : "sync"}>
              {playback.status === "paused" ? `Paused by ${leader ?? "someone"}` : driftLabel(drift)}
            </span>
          )}
        </div>
      )}
      {loaded && isHost && playback.status === "idle" && !props.canStart && (
        <p className="muted small">{props.startHint}</p>
      )}
      {phase.kind === "loaded" && <DecisionSummary decision={phase.decision} location={phase.location} />}
      {!isHost && loaded && !canPlayPause && !canSeek && (
        <p className="muted small">The host controls playback; your player follows along.</p>
      )}
    </div>
  );
}
