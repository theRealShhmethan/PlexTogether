/**
 * Playback sync maths (shared control: whoever acted last sets the pace).
 *
 * The server keeps the room's playback as an anchor: "at server time T the
 * room was at position P, playing or paused", plus who set it. Whoever acted
 * last sets the pace; everyone else computes where playback should be now,
 * compares that with their own player and corrects.
 *
 * TUNED FROM TESTING (2026-09-24): the brief's original thresholds (ignore
 * <250 ms, hard seek >2 s) corrected far too often. With Plex, a hard seek
 * outside the buffer is a brand-new transcode session, and on a NAS that
 * made both players buffer continuously. A few seconds apart is fine for
 * watching together, so now:
 *
 *   |drift| <  3 s      → leave it
 *   3 s – 8 s           → nudge playbackRate by 4% (≈ 1 s caught up per 25 s),
 *                         speeding up only if well buffered, so the player never
 *                         outruns the transcoder
 *   >  8 s              → reposition, at most once per repositionMinIntervalMs
 */

export type PlaybackAnchor = {
  status: "idle" | "playing" | "paused";
  /** Position (ms) at `anchorServerTime`. */
  positionMs: number;
  /** Server time (ms since epoch) the position refers to. May be in the future for a scheduled start. */
  anchorServerTime: number;
  /** Participant whose player is the reference; null for a scheduled Start Together (everyone follows). */
  by: string | null;
  /** Increments on every change. */
  seq: number;
};

export const DRIFT = {
  ignoreMs: 3000,
  hardSeekMs: 8000,
  /** Rate nudging continues until back within this (hysteresis). */
  settleMs: 1000,
  rateStep: 0.04,
  /** Speed up only with at least this much buffered ahead. */
  minBufferToSpeedUpMs: 15_000,
  /** Never reposition more often than this. */
  repositionMinIntervalMs: 30_000,
} as const;

/** Where playback should be at `serverNow` (ms). A scheduled start holds at the anchor position until it's due. */
export function expectedPositionMs(anchor: PlaybackAnchor, serverNow: number): number {
  if (anchor.status !== "playing") return anchor.positionMs;
  return anchor.positionMs + Math.max(0, serverNow - anchor.anchorServerTime);
}

export type Correction = { kind: "none"; rate: 1 } | { kind: "rate"; rate: number } | { kind: "seek"; toMs: number };

export type CorrectionContext = {
  /** A rate correction is already in progress (keep going until within settleMs). */
  nudging: boolean;
  /** How much is buffered ahead of the playhead (ms). */
  bufferedAheadMs: number;
  /** ms since this player last repositioned (Infinity if never). */
  sinceRepositionMs: number;
};

/** Decides how to correct a follower at `actualMs` when the room is at `expectedMs`. */
export function correctionFor(actualMs: number, expectedMs: number, ctx: CorrectionContext): Correction {
  const drift = actualMs - expectedMs; // positive = this player is ahead
  const abs = Math.abs(drift);
  if (abs > DRIFT.hardSeekMs && ctx.sinceRepositionMs >= DRIFT.repositionMinIntervalMs) {
    return { kind: "seek", toMs: expectedMs };
  }
  if (abs < DRIFT.settleMs || (!ctx.nudging && abs < DRIFT.ignoreMs)) return { kind: "none", rate: 1 };
  if (drift > 0) return { kind: "rate", rate: 1 - DRIFT.rateStep }; // ahead → slow down (always safe)
  // Behind → speed up, but only with a healthy buffer; otherwise wait it out.
  if (ctx.bufferedAheadMs < DRIFT.minBufferToSpeedUpMs) return { kind: "none", rate: 1 };
  return { kind: "rate", rate: 1 + DRIFT.rateStep };
}

/** Short label like "In sync · 0.4 s". */
export function driftLabel(driftMs: number | null): string {
  if (driftMs === null) return "Not synced yet";
  const abs = Math.abs(driftMs);
  const secs = abs < 1000 ? `${Math.round(abs)} ms` : `${(abs / 1000).toFixed(1)} s`;
  if (abs < DRIFT.ignoreMs) return `In sync · ${secs}`;
  return `Catching up · ${driftMs > 0 ? "+" : "−"}${(abs / 1000).toFixed(1)} s`;
}
