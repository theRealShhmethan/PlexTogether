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

describe("correctionFor", () => {
  it.each([
    [100, "none", 1],
    [-200, "none", 1],
    [400, "rate", 0.95], // ahead → slow down
    [-400, "rate", 1.05], // behind → speed up
    [1500, "rate", 0.9],
    [-1500, "rate", 1.1],
  ])("drift %i ms → %s (rate %f)", (drift, kind, rate) => {
    const c = correctionFor(10_000 + drift, 10_000, false);
    expect(c.kind).toBe(kind);
    if (c.kind !== "seek") expect(c.rate).toBeCloseTo(rate);
  });

  it("hard-seeks beyond 2 s", () => {
    expect(correctionFor(13_000, 10_000, false)).toEqual({ kind: "seek", toMs: 10_000 });
    expect(correctionFor(7_000, 10_000, true)).toEqual({ kind: "seek", toMs: 10_000 });
  });

  it("keeps nudging until well inside the dead zone (hysteresis)", () => {
    expect(correctionFor(10_200, 10_000, true).kind).toBe("rate");
    expect(correctionFor(10_200, 10_000, false).kind).toBe("none");
    expect(correctionFor(10_050, 10_000, true).kind).toBe("none");
  });
});

describe("driftLabel", () => {
  it("formats", () => {
    expect(driftLabel(82)).toBe("Synced · 82 ms");
    expect(driftLabel(-1200)).toBe("Catching up · −1.2 s");
    expect(driftLabel(null)).toBe("Not synced yet");
  });
});
