"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

/**
 * Subtitles drawn by the player (not the browser, not burned in by Plex), so
 * each viewer can shift their timing and size. Plex sends text subtitles as a
 * WebVTT track in the HLS stream; hls.js (or Safari) turns it into a TextTrack
 * on the <video>, which we keep hidden and read the cues from.
 *
 * Settings live in this browser only: the delay per title (a subtitle file is
 * usually off by the same amount all the way through), size and style for all.
 */

export const SUBTITLE_SIZES = { small: 0.8, medium: 1, large: 1.25, huge: 1.6 } as const;
export type SubtitleSize = keyof typeof SUBTITLE_SIZES;
export const SUBTITLE_STYLES = ["outline", "box"] as const;
export type SubtitleStyle = (typeof SUBTITLE_STYLES)[number];

/** Delay limits (a wrong-release file can be off by minutes) and keyboard step. */
export const MAX_DELAY_MS = 300_000;
export const DELAY_STEP_MS = 100;

const STYLE_KEY = "pt_sub_style";
const DELAY_KEY = "pt_sub_delay";
/** Remember delays for this many titles at most. */
const MAX_REMEMBERED = 100;

export function clampDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(ms)));
}

/** "+0.3 s", "−1.25 s", "0 s". Positive = subtitles appear later. */
export function formatDelay(ms: number): string {
  if (ms === 0) return "0 s";
  const s = Math.abs(ms) / 1000;
  const text = Number.isInteger(s * 10) ? s.toFixed(1) : String(Math.round(s * 1000) / 1000);
  return `${ms > 0 ? "+" : "−"}${text} s`;
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered (private mode etc.) — still works for this visit */
  }
}

function readDelays(): Record<string, number> {
  const raw = readJson(DELAY_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = clampDelay(v);
  return out;
}

export type SubtitleSettings = {
  delayMs: number;
  setDelayMs: (ms: number) => void;
  /** Adds to the delay; returns the new value. */
  nudge: (deltaMs: number) => number;
  size: SubtitleSize;
  setSize: (s: SubtitleSize) => void;
  style: SubtitleStyle;
  setStyle: (s: SubtitleStyle) => void;
};

/** This viewer's subtitle settings for the title `itemKey` (remembered in this browser). */
export function useSubtitleSettings(itemKey: string): SubtitleSettings {
  const [delayMs, setDelayState] = useState(0);
  const [size, setSizeState] = useState<SubtitleSize>("medium");
  const [style, setStyleState] = useState<SubtitleStyle>("outline");
  /** Latest delay, so quick repeated nudges add up before a re-render. */
  const delayRef = useRef(0);

  useEffect(() => {
    // Browser-only storage: read after mount so server and client render alike.
    delayRef.current = readDelays()[itemKey] ?? 0;
    setDelayState(delayRef.current);
    const saved = readJson(STYLE_KEY) as { size?: string; style?: string } | null;
    if (saved?.size && Object.hasOwn(SUBTITLE_SIZES, saved.size)) setSizeState(saved.size as SubtitleSize);
    if (saved?.style && (SUBTITLE_STYLES as readonly string[]).includes(saved.style)) setStyleState(saved.style as SubtitleStyle);
  }, [itemKey]);

  const setDelayMs = useCallback(
    (ms: number) => {
      const value = clampDelay(ms);
      delayRef.current = value;
      setDelayState(value);
      const delays = readDelays();
      delete delays[itemKey];
      if (value !== 0) delays[itemKey] = value;
      // Newest last; drop the oldest beyond the cap.
      const entries = Object.entries(delays).slice(-MAX_REMEMBERED);
      writeJson(DELAY_KEY, Object.fromEntries(entries));
    },
    [itemKey],
  );

  const nudge = useCallback(
    (deltaMs: number) => {
      setDelayMs(delayRef.current + deltaMs);
      return delayRef.current;
    },
    [setDelayMs],
  );

  const setSize = useCallback(
    (s: SubtitleSize) => {
      setSizeState(s);
      writeJson(STYLE_KEY, { size: s, style });
    },
    [style],
  );
  const setStyle = useCallback(
    (s: SubtitleStyle) => {
      setStyleState(s);
      writeJson(STYLE_KEY, { size, style: s });
    },
    [size],
  );

  return { delayMs, setDelayMs, nudge, size, setSize, style, setStyle };
}

/** A run of cue text with the formatting WebVTT allows (<i>, <b>, <u>). */
export type CueSpan = { text: string; i?: boolean; b?: boolean; u?: boolean };

/**
 * Parses WebVTT cue text into lines of formatted spans. Only i/b/u are kept;
 * every other tag (voice, class, ruby, timestamps) is dropped, and entities
 * are decoded. The result is rendered as React text, never as HTML.
 */
export function parseCueText(text: string): CueSpan[][] {
  const lines: CueSpan[][] = [];
  const on = { i: 0, b: 0, u: 0 };
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line: CueSpan[] = [];
    for (const part of rawLine.split(/(<[^>]*>)/)) {
      if (!part) continue;
      const tag = /^<(\/?)([a-z]+)/i.exec(part);
      if (tag) {
        const name = tag[2].toLowerCase() as keyof typeof on;
        if (name in on) on[name] = Math.max(0, on[name] + (tag[1] ? -1 : 1));
        continue;
      }
      if (part.startsWith("<")) continue;
      const decoded = part
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&lrm;|&rlm;/g, "")
        .replace(/&amp;/g, "&");
      line.push({ text: decoded, ...(on.i ? { i: true } : {}), ...(on.b ? { b: true } : {}), ...(on.u ? { u: true } : {}) });
    }
    if (line.some((s) => s.text.trim())) lines.push(line);
  }
  return lines;
}

function renderSpan(s: CueSpan, key: number): ReactNode {
  let node: ReactNode = s.text;
  if (s.u) node = <u>{node}</u>;
  if (s.b) node = <b>{node}</b>;
  if (s.i) node = <i>{node}</i>;
  return <span key={key}>{node}</span>;
}

const isSubtitleTrack = (t: TextTrack) => t.kind === "subtitles" || t.kind === "captions";

/**
 * The subtitle track to read: the one hls.js / Safari has enabled, kept
 * hidden so the browser doesn't draw it as well. If none is enabled (native
 * HLS in Safari), the first subtitle track is turned on.
 */
export function activeSubtitleTrack(tracks: TextTrackList): TextTrack | null {
  const list = Array.from({ length: tracks.length }, (_, i) => tracks[i]).filter(isSubtitleTrack);
  let active = list.find((t) => t.mode !== "disabled") ?? null;
  if (!active && list.length > 0) active = list[0];
  if (active && active.mode !== "hidden") active.mode = "hidden";
  return active;
}

/** Text of the cues showing at `timeS` (already shifted by the delay). */
export function cuesAt(track: TextTrack, timeS: number): string[] {
  const cues = track.cues;
  if (!cues) return [];
  const out: string[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i] as TextTrackCue & { text?: string };
    if (c.startTime <= timeS && timeS < c.endTime && c.text) out.push(c.text);
  }
  return out;
}

/** How often the overlay checks the time (cue changes appear within this). */
const TICK_MS = 50;

/** Draws the current subtitle cues over the video, shifted by the viewer's delay. */
export function SubtitleOverlay({
  videoRef,
  settings,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  settings: Pick<SubtitleSettings, "delayMs" | "size" | "style">;
}) {
  const [texts, setTexts] = useState<string[]>([]);
  const { delayMs } = settings;

  useEffect(() => {
    // null: the first check after a delay change always updates what is shown.
    let last: string | null = null;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      const track = v ? activeSubtitleTrack(v.textTracks) : null;
      // Positive delay = show later: look up what was due `delay` ago.
      const now = v && track ? cuesAt(track, v.currentTime - delayMs / 1000) : [];
      const key = now.join("\u0000");
      if (key !== last) {
        last = key;
        setTexts(now);
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [videoRef, delayMs]);

  if (texts.length === 0) return null;
  return (
    <div
      className={`subtitle-overlay sub-${settings.style}`}
      style={{ "--sub-scale": SUBTITLE_SIZES[settings.size] } as CSSProperties}
      aria-live="off"
    >
      {texts.map((t, ci) => (
        <div key={ci} className="subtitle-cue">
          {parseCueText(t).map((line, li) => (
            <span key={li} className="subtitle-line">
              {line.map(renderSpan)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
