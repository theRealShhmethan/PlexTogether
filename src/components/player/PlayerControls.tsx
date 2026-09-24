"use client";

import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { formatTime } from "@/lib/format/time";

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

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  };

  const shown = dragMs ?? now;
  return (
    <div className="controls">
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
      <span className="time">
        {busyLabel ?? `${formatTime(shown)} / ${total ? formatTime(total) : "--:--"}`}
      </span>
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
  );
}
