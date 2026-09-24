/**
 * Playback sync maths (host-authoritative).
 *
 * The server keeps the room's playback as an anchor: "at server time T the
 * host was at position P, playing or paused". Anyone can then compute where
 * playback should be now. Guests compare that with their own player and
 * correct as follows (thresholds from the project brief; tune after testing):
 *
 *   |drift| <  250 ms   → leave it
 *   250 ms – 2 s        → nudge playbackRate (±5% up to 750 ms, ±10% beyond),
 *                         which catches up smoothly without a visible jump
 *   >  2 s              → hard seek to the expected position
 */

export type PlaybackAnchor = {
  status: "idle" | "playing" | "paused";
  /** Position (ms) at `anchorServerTime`. */
  positionMs: number;
  /** Server time (ms since epoch) the position refers to. May be in the future for a scheduled start. */
  anchorServerTime: number;
};

export const DRIFT = {
  ignoreMs: 250,
  gentleMs: 750,
  hardSeekMs: 2000,
  /** Rate nudging stops once back within this. */
  settleMs: 100,
  gentleRate: 0.05,
  strongRate: 0.1,
} as const;

/** Where playback should be at `serverNow` (ms). A scheduled start holds at the anchor position until it's due. */
export function expectedPositionMs(anchor: PlaybackAnchor, serverNow: number): number {
  if (anchor.status !== "playing") return anchor.positionMs;
  return anchor.positionMs + Math.max(0, serverNow - anchor.anchorServerTime);
}

export type Correction = { kind: "none"; rate: 1 } | { kind: "rate"; rate: number } | { kind: "seek"; toMs: number };

/**
 * Decides how to correct a guest whose position is `actualMs` when it should be
 * `expectedMs`. `nudging` says a rate correction is already in progress, in
 * which case we keep nudging until within `settleMs` (hysteresis — avoids
 * flapping around the 250 ms edge).
 */
export function correctionFor(actualMs: number, expectedMs: number, nudging: boolean): Correction {
  const drift = actualMs - expectedMs; // positive = guest is ahead
  const abs = Math.abs(drift);
  if (abs > DRIFT.hardSeekMs) return { kind: "seek", toMs: expectedMs };
  if (abs < DRIFT.settleMs || (!nudging && abs < DRIFT.ignoreMs)) return { kind: "none", rate: 1 };
  const step = abs > DRIFT.gentleMs ? DRIFT.strongRate : DRIFT.gentleRate;
  // Ahead → slow down; behind → speed up.
  return { kind: "rate", rate: drift > 0 ? 1 - step : 1 + step };
}

/** Short label like "Synced · 82 ms". */
export function driftLabel(driftMs: number | null): string {
  if (driftMs === null) return "Not synced yet";
  const abs = Math.round(Math.abs(driftMs));
  if (abs < DRIFT.ignoreMs) return `Synced · ${abs} ms`;
  return `Catching up · ${driftMs > 0 ? "+" : "−"}${(abs / 1000).toFixed(1)} s`;
}
