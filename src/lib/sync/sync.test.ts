import { describe, expect, it } from "vitest";
import { ClockSync } from "./clock";
import { correctionFor, driftLabel, expectedPositionMs, type PlaybackAnchor } from "./drift";

describe("ClockSync", () => {
  it("estimates the server offset from the lowest-latency sample", () => {
    const c = new ClockSync();
    // Server is 5000 ms ahead. Sample 1: 200 ms round trip, asymmetric-ish.
    c.addSample(1000, 6150, 1200); // offset = 6150 + 100 - 1200 = 5050
    c.addSample(2000, 7020, 2040); // rtt 40: offset = 7020 + 20 - 2040 = 5000
    expect(c.best()).toEqual({ offsetMs: 5000, rttMs: 40 });
    expect(c.serverNow(10_000)).toBe(15_000);
  });

  it("ignores impossible samples", () => {
    const c = new ClockSync();
    expect(c.addSample(2000, 0, 1000)).toBeNull();
    expect(c.ready).toBe(false);
    expect(c.serverNow(123)).toBe(123);
  });
});

describe("expectedPositionMs", () => {
  const playing: PlaybackAnchor = { status: "playing", positionMs: 60_000, anchorServerTime: 1_000_000, by: null, seq: 1 };

  it("advances with server time while playing", () => {
    expect(expectedPositionMs(playing, 1_002_500)).toBe(62_500);
  });

  it("holds at the anchor for a scheduled (future) start and while paused", () => {
    expect(expectedPositionMs(playing, 999_000)).toBe(60_000);
    expect(expectedPositionMs({ ...playing, status: "paused" }, 2_000_000)).toBe(60_000);
  });
});

const ctx = { nudging: false, bufferedAheadMs: 30_000, sinceRepositionMs: Infinity };

describe("correctionFor", () => {
  it.each([
    [1000, "none", 1],
    [-2500, "none", 1],
    [4000, "rate", 0.96], // ahead → slow down
    [-4000, "rate", 1.04], // behind → speed up (well buffered)
  ])("drift %i ms → %s (rate %f)", (drift, kind, rate) => {
    const c = correctionFor(100_000 + drift, 100_000, ctx);
    expect(c.kind).toBe(kind);
    if (c.kind !== "seek") expect(c.rate).toBeCloseTo(rate);
  });

  it("never speeds up on a thin buffer (it would just stall)", () => {
    expect(correctionFor(96_000, 100_000, { ...ctx, bufferedAheadMs: 5000 })).toEqual({ kind: "none", rate: 1 });
    // Slowing down is always fine.
    expect(correctionFor(104_000, 100_000, { ...ctx, bufferedAheadMs: 0 }).kind).toBe("rate");
  });

  it("repositions beyond 8 s, but not more than once per 30 s", () => {
    expect(correctionFor(110_000, 100_000, ctx)).toEqual({ kind: "seek", toMs: 100_000 });
    expect(correctionFor(110_000, 100_000, { ...ctx, sinceRepositionMs: 5000 }).kind).toBe("rate");
  });

  it("keeps nudging until within 1 s (hysteresis)", () => {
    expect(correctionFor(102_000, 100_000, { ...ctx, nudging: true }).kind).toBe("rate");
    expect(correctionFor(102_000, 100_000, ctx).kind).toBe("none");
    expect(correctionFor(100_500, 100_000, { ...ctx, nudging: true }).kind).toBe("none");
  });
});

describe("driftLabel", () => {
  it("formats", () => {
    expect(driftLabel(82)).toBe("In sync · 82 ms");
    expect(driftLabel(-2400)).toBe("In sync · 2.4 s");
    expect(driftLabel(-5200)).toBe("Catching up · −5.2 s");
    expect(driftLabel(null)).toBe("Not synced yet");
  });
});
