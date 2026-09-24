"use client";

import { useEffect, useRef, useState } from "react";
import { DecisionSummary } from "@/components/player/DecisionSummary";
import { PlayerControls } from "@/components/player/PlayerControls";
import { TrackMenu } from "@/components/player/TrackMenu";
import { usePlexStream } from "@/components/player/usePlexStream";
import { SignInButton } from "@/components/SignInButton";
import type { ClientMessage, Permissions } from "@/lib/rooms/protocol";
import { correctionFor, DRIFT, driftLabel, expectedPositionMs, type PlaybackAnchor } from "@/lib/sync/drift";

const SYNC_LOOP_MS = 250;
const STATUS_MS = 1000;
const TICK_MS = 2000;
/** After repositioning, leave the player alone for a while before judging drift again. */
const SEEK_COOLDOWN_MS = 10_000;
/** While paused, line up with the room if off by more than this (cheap when it's buffered). */
const PAUSED_ALIGN_MS = 1500;
/** A buffered (instant) seek lands this far ahead, then holds until the room reaches it. */
const LOCAL_SEEK_LEAD_MS = 300;
/** First guess at how long a new Plex session takes to become playable; learned from experience. */
const INITIAL_RESTART_MS = 4000;
/** Paused and ahead of the room by at most this → wait for the room rather than seek back. */
const HOLD_MAX_MS = 10_000;

/** Remembers (per browser) that this room's video was loaded, so a reload or reopened link resumes it. */
const autoloadKey = (roomId: string) => `pt_autoload:${roomId}`;
function readAutoload(roomId: string): boolean {
  try {
    return window.localStorage.getItem(autoloadKey(roomId)) === "1";
  } catch {
    return false;
  }
}
function writeAutoload(roomId: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(autoloadKey(roomId), "1");
    else window.localStorage.removeItem(autoloadKey(roomId));
  } catch {
    /* storage unavailable (private mode etc.): the user just clicks "Get ready" again */
  }
}
export const forgetAutoload = (roomId: string) => writeAutoload(roomId, false);

type Props = {
  roomId: string;
  me: string;
  isHost: boolean;
  permissions: Permissions;
  playback: PlaybackAnchor;
  durationMs: number | null;
  waitingFor: string[];
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
  const stream = usePlexStream(`/api/rooms/${roomId}/playback`, durationMs);
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
  const lastRepositionAt = useRef(-Infinity);
  const [needsUnmute, setNeedsUnmute] = useState(false);

  /**
   * play(), falling back to muted playback if the browser blocks autoplay with
   * sound (e.g. after a reload with no click yet). The user can then unmute.
   */
  function safePlay(v: HTMLVideoElement | null) {
    if (!v) return;
    v.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError" && !v.muted) {
        v.muted = true;
        setNeedsUnmute(true);
        void v.play().catch(() => {});
      }
    });
  }

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
    lastRepositionAt.current = performance.now();
    seekingRef.current = false;
  }

  /** ms buffered ahead of the playhead. */
  function bufferedAheadMs(): number {
    const v = videoRef.current;
    if (!v) return 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
        return (v.buffered.end(i) - v.currentTime) * 1000;
      }
    }
    return 0;
  }

  /** Repositions only if we haven't just done so; prefers an instant (buffered) seek. */
  function maybeReposition(targetMs: number, withLead: boolean) {
    const sinceLast = performance.now() - lastRepositionAt.current;
    const buffered = stream.isBuffered(targetMs + LOCAL_SEEK_LEAD_MS);
    if (!buffered && sinceLast < DRIFT.repositionMinIntervalMs) return false;
    const lead = !withLead ? 0 : buffered ? LOCAL_SEEK_LEAD_MS : restartMsRef.current + 1000;
    void reposition(targetMs + lead);
    return true;
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
        if (Math.abs(ahead) > PAUSED_ALIGN_MS && performance.now() > cooldownUntil.current) {
          // Close enough and not buffered → leave it; the few seconds don't matter.
          if (stream.isBuffered(expected) || Math.abs(ahead) > DRIFT.ignoreMs) maybeReposition(expected, false);
        }
        return;
      }

      if (v.paused) {
        if (ahead > 0 && ahead < HOLD_MAX_MS) {
          // Ahead after a seek: wait for the room, starting precisely on time.
          if (ahead < SYNC_LOOP_MS * 2 && holdTimer.current === undefined) {
            holdTimer.current = window.setTimeout(() => {
              holdTimer.current = undefined;
              safePlay(videoRef.current);
            }, ahead);
          }
          return;
        }
        // Within tolerance (or we can't reposition yet): just play.
        if (ahead > -DRIFT.hardSeekMs || !maybeReposition(expected, true)) safePlay(v);
        return;
      }

      if (bufferingRef.current || performance.now() < cooldownUntil.current) {
        v.playbackRate = 1;
        nudgingRef.current = false;
        return;
      }
      const c = correctionFor(actual, expected, {
        nudging: nudgingRef.current,
        bufferedAheadMs: bufferedAheadMs(),
        sinceRepositionMs: performance.now() - lastRepositionAt.current,
      });
      if (c.kind === "seek") {
        v.playbackRate = 1;
        nudgingRef.current = false;
        maybeReposition(expected, true);
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

  const playerReadyRef = useRef(false);
  useEffect(() => {
    playerReadyRef.current = playerReady;
  }, [playerReady]);

  function sendStatus() {
    if (!connected) return;
    send({
      type: "status",
      playerReady: playerReadyRef.current,
      buffering: bufferingRef.current,
      driftMs: driftRef.current === null ? null : Math.round(driftRef.current),
      positionMs: playerReadyRef.current ? Math.round(mediaTimeMs()) : null,
    });
  }
  function setBuffering(b: boolean) {
    if (bufferingRef.current === b) return;
    bufferingRef.current = b;
    sendStatus(); // the room may need to pause for us — tell it now
  }

  // --- status to the room; the reference player keeps the anchor fresh ---
  useEffect(() => {
    if (!connected) return;
    const status = window.setInterval(sendStatus, STATUS_MS);
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
      safePlay(v);
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
      safePlay(videoRef.current);
      control("play");
    }
  }

  async function getReady() {
    setCanPlay(false);
    const a = anchorRef.current;
    const now = serverNow();
    // If the room is already playing, load a little ahead and let the hold logic start us on time.
    const at = expectedPositionMs(a, now) + (a.status === "playing" && now >= a.anchorServerTime ? INITIAL_RESTART_MS : 0);
    if (await load(at)) {
      send({ type: "ready", ready: true });
      writeAutoload(roomId, true);
    }
  }

  // After a reload or reopened link, reload the video automatically once connected.
  const autoloadTried = useRef(false);
  useEffect(() => {
    if (autoloadTried.current || !connected || phase.kind !== "idle" || !readAutoload(roomId)) return;
    autoloadTried.current = true;
    void getReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once when the socket first connects
  }, [connected, phase.kind, roomId]);

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
            setBuffering(true);
          }}
          onPlaying={() => setBuffering(false)}
          onCanPlay={() => {
            setBuffering(false);
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
          extra={
            <TrackMenu
              apiBase={stream.apiBase}
              onChanged={async () => {
                // Reload in place; the room follows as usual (and waits if it takes a moment).
                await stream.reloadHere();
              }}
            />
          }
        />
      </div>

      {needsUnmute && (
        <button
          className="button unmute"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = false;
            setNeedsUnmute(false);
          }}
        >
          🔇 Playing muted (your browser blocked sound) — click to turn sound on
        </button>
      )}

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
          {props.waitingFor.length > 0 ? (
            <strong>Waiting for {props.waitingFor.join(", ")}…</strong>
          ) : countdown !== null ? (
            <strong>{playback.seq > 1 ? "Resuming" : "Starting"} in {countdown}…</strong>
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
