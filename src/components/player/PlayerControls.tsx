"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { formatTime } from "@/lib/format/time";
import { toggleFullscreen as toggleFs } from "./useVideoClicks";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  mediaTimeMs: () => number;
  durationMs: () => number | null;
  /** null → play/pause and seeking are disabled (guests follow the host). */
  onTogglePlay: (() => void) | null;
  onSeek: ((ms: number) => void) | null;
  /** Shown instead of the time while a new stream is being prepared. */
  busyLabel?: string | null;
  /** Extra controls (e.g. the audio/subtitle menu), placed before fullscreen. */
  extra?: ReactNode;
};

/** Hide the control bar (and cursor) after this long without mouse/keyboard activity. */
const IDLE_HIDE_MS = 10_000;
/** Arrow-key skips add up; the seek happens once the keys go quiet for this long. */
const SKIP_COMMIT_MS = 500;
const SKIP_MS = 10_000;
const SKIP_BIG_MS = 30_000;

/** Keys should do nothing while the user is typing (chat, search boxes, menus). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Custom controls in MEDIA time. The browser's built-in bar would show only
 * the current Plex session (which may start mid-movie) and seek inside it,
 * so seeking goes through our seek logic instead.
 */
export function PlayerControls({
  videoRef,
  containerRef,
  mediaTimeMs,
  durationMs,
  onTogglePlay,
  onSeek,
  busyLabel,
  extra,
}: Props) {
  const [now, setNow] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [dragMs, setDragMs] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ id: number; text: string } | null>(null);
  const [visible, setVisible] = useState(true);
  const pendingSkip = useRef<number | null>(null);
  const skipTimer = useRef<number | undefined>(undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  /** The pointer is over the bar: never hide it then. */
  const hoverRef = useRef(false);
  const flashSeq = useRef(0);

  // Latest props for the global key handler.
  const live = useRef({ onTogglePlay, onSeek, mediaTimeMs, durationMs });
  useEffect(() => {
    live.current = { onTogglePlay, onSeek, mediaTimeMs, durationMs };
  }, [onTogglePlay, onSeek, mediaTimeMs, durationMs]);

  const showFlash = (text: string) => {
    const id = ++flashSeq.current;
    setFlash({ id, text });
    window.setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), 700);
  };

  /** Any activity shows the controls and restarts the 10 s hide timer. */
  /** (Re)starts the hide timer. */
  const startHideTimer = () => {
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      // Still hovering the bar: keep it and check again later.
      if (hoverRef.current) startHideTimer();
      else setVisible(false);
    }, IDLE_HIDE_MS);
  };
  const poke = () => {
    setVisible(true);
    startHideTimer();
  };

  // Any mouse/touch activity on the page shows the bar. Listening on the
  // document (not just the player box) also covers fullscreen and overlays.
  useEffect(() => {
    const onActivity = () => poke();
    document.addEventListener("mousemove", onActivity);
    document.addEventListener("pointermove", onActivity);
    document.addEventListener("pointerdown", onActivity);
    document.addEventListener("touchstart", onActivity, { passive: true });
    startHideTimer(); // visible to begin with
    return () => {
      document.removeEventListener("mousemove", onActivity);
      document.removeEventListener("pointermove", onActivity);
      document.removeEventListener("pointerdown", onActivity);
      document.removeEventListener("touchstart", onActivity);
      window.clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poke only uses refs and setters
  }, []);

  // Hidden only while playing (never while paused), via a class on the player box.
  const hidden = !visible && !paused && dragMs === null;
  useEffect(() => {
    containerRef.current?.classList.toggle("idle", hidden);
  }, [hidden, containerRef]);

  // Keyboard shortcuts: Space/K play-pause, ←/→ (J/L) skip 10 s (Shift: 30 s),
  // ↑/↓ volume, F fullscreen, M mute.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const v = videoRef.current;
      if (!v) return;
      const { onTogglePlay: toggle, onSeek: seek, mediaTimeMs: nowMs, durationMs: totalMs } = live.current;
      const key = e.key;
      const skip = (delta: number) => {
        if (!seek) return;
        const base = pendingSkip.current ?? nowMs();
        const total = totalMs() ?? Number.MAX_SAFE_INTEGER;
        const target = Math.min(Math.max(0, base + delta), Math.max(0, total - 1000));
        pendingSkip.current = target;
        setDragMs(target);
        showFlash(`${delta > 0 ? "»" : "«"} ${formatTime(target)}`);
        window.clearTimeout(skipTimer.current);
        skipTimer.current = window.setTimeout(() => {
          const t = pendingSkip.current;
          pendingSkip.current = null;
          setDragMs(null);
          if (t !== null) seek(t);
        }, SKIP_COMMIT_MS);
      };

      if (key === " " || key === "k" || key === "K") {
        // A focused button already handles Space itself.
        if (key === " " && e.target instanceof HTMLButtonElement) return;
        if (!toggle) return;
        e.preventDefault();
        showFlash(v.paused ? "▶" : "❚❚");
        toggle();
      } else if (key === "ArrowLeft" || key === "j" || key === "J") {
        if (!seek) return;
        e.preventDefault();
        skip(-(e.shiftKey ? SKIP_BIG_MS : SKIP_MS));
      } else if (key === "ArrowRight" || key === "l" || key === "L") {
        if (!seek) return;
        e.preventDefault();
        skip(e.shiftKey ? SKIP_BIG_MS : SKIP_MS);
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        e.preventDefault();
        v.volume = Math.min(1, Math.max(0, Math.round((v.volume + (key === "ArrowUp" ? 0.05 : -0.05)) * 100) / 100));
        v.muted = v.volume === 0;
        showFlash(`🔊 ${Math.round(v.volume * 100)}%`);
      } else if (key === "m" || key === "M") {
        v.muted = !v.muted;
        showFlash(v.muted ? "🔇" : "🔊");
      } else if (key === "f" || key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void containerRef.current?.requestFullscreen();
      } else {
        return;
      }
      poke();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(skipTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poke/props are read through refs and stable setters
  }, [videoRef, containerRef]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current;
      setNow(mediaTimeMs());
      setTotal(durationMs());
      if (v) {
        setPaused(v.paused);
        setMuted(v.muted);
        setVolume(v.volume);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [videoRef, mediaTimeMs, durationMs]);

  const commit = () => {
    if (dragMs !== null && onSeek) onSeek(dragMs);
    setDragMs(null);
  };

  const toggleFullscreen = () => toggleFs(containerRef.current);

  const shown = dragMs ?? now;
  return (
    <>
      {flash && (
        <div key={flash.id} className="key-flash" aria-hidden="true">
          {flash.text}
        </div>
      )}
      <div
      className="controls"
      onPointerEnter={() => {
        hoverRef.current = true;
        poke();
      }}
      onPointerLeave={() => {
        hoverRef.current = false;
        poke();
      }}
    >
        <button
          className="ctl"
          onClick={() => onTogglePlay?.()}
          disabled={!onTogglePlay}
          aria-label={paused ? "Play" : "Pause"}
          title={onTogglePlay ? undefined : "The host controls playback"}
        >
          {paused ? "▶" : "❚❚"}
        </button>
        <input
          className="seek"
          type="range"
          min={0}
          max={total ?? 0}
          step={1000}
          value={Math.min(shown, total ?? shown)}
          disabled={!onSeek || !total}
          aria-label="Seek"
          onChange={(e) => setDragMs(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
        />
        <span className="time">{busyLabel ?? `${formatTime(shown)} / ${total ? formatTime(total) : "--:--"}`}</span>
        <button
          className="ctl"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = !v.muted;
          }}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? "🔇" : "🔊"}
        </button>
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          aria-label="Volume"
          onChange={(e) => {
            const v = videoRef.current;
            if (!v) return;
            v.volume = Number(e.target.value);
            v.muted = v.volume === 0;
          }}
        />
        {extra}
        <button className="ctl" onClick={toggleFullscreen} aria-label="Fullscreen">
          ⛶
        </button>
      </div>
    </>
  );
}
