// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampDelay, cuesAt, formatDelay, parseCueText, SubtitleOverlay, useSubtitleSettings } from "./subtitles";

type FakeCue = { startTime: number; endTime: number; text: string };

function fakeTrack(cues: FakeCue[], mode: TextTrackMode = "hidden") {
  return { kind: "subtitles", mode, cues: Object.assign([...cues], { length: cues.length }) } as unknown as TextTrack;
}

function fakeVideo(track: TextTrack) {
  const tracks = Object.assign([track], { length: 1 }) as unknown as TextTrackList;
  return { currentTime: 0, textTracks: tracks } as unknown as HTMLVideoElement;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("parseCueText", () => {
  it("keeps lines and i/b/u, drops other tags, decodes entities", () => {
    expect(parseCueText("<v Bob>Hello &amp; <i>welcome</i></v>\n<b>Bold</b> &lt;3")).toEqual([
      [{ text: "Hello & " }, { text: "welcome", i: true }],
      [{ text: "Bold", b: true }, { text: " <3" }],
    ]);
  });

  it("never turns cue text into markup", () => {
    const lines = parseCueText('<img src=x onerror="alert(1)">Hi<script>x</script>');
    expect(lines).toEqual([[{ text: "Hi" }, { text: "x" }]]);
  });

  it("skips empty lines", () => {
    expect(parseCueText("One\n\n  \nTwo")).toEqual([[{ text: "One" }], [{ text: "Two" }]]);
  });
});

describe("delay helpers", () => {
  it("formats with sign (positive = later)", () => {
    expect(formatDelay(0)).toBe("0 s");
    expect(formatDelay(300)).toBe("+0.3 s");
    expect(formatDelay(-1250)).toBe("−1.25 s");
    expect(formatDelay(2000)).toBe("+2.0 s");
  });

  it("clamps to ±5 minutes and rejects junk", () => {
    expect(clampDelay(999_999)).toBe(300_000);
    expect(clampDelay(-999_999)).toBe(-300_000);
    expect(clampDelay(Number.NaN)).toBe(0);
  });
});

describe("cuesAt", () => {
  it("returns the cues showing at a time (end exclusive)", () => {
    const track = fakeTrack([
      { startTime: 1, endTime: 3, text: "A" },
      { startTime: 2, endTime: 4, text: "B" },
    ]);
    expect(cuesAt(track, 0.5)).toEqual([]);
    expect(cuesAt(track, 2.5)).toEqual(["A", "B"]);
    expect(cuesAt(track, 3)).toEqual(["B"]);
  });
});

describe("useSubtitleSettings", () => {
  it("remembers the delay per title and style for all titles", () => {
    const a = renderHook(() => useSubtitleSettings("100"));
    act(() => {
      a.result.current.nudge(100);
      a.result.current.nudge(100);
      a.result.current.setSize("large");
    });
    expect(a.result.current.delayMs).toBe(200);
    a.unmount();

    expect(renderHook(() => useSubtitleSettings("100")).result.current).toMatchObject({ delayMs: 200, size: "large" });
    expect(renderHook(() => useSubtitleSettings("200")).result.current).toMatchObject({ delayMs: 0, size: "large" });
  });

  it("ignores stored values it doesn't know", () => {
    window.localStorage.setItem("pt_sub_style", JSON.stringify({ size: "toString", style: "neon" }));
    window.localStorage.setItem("pt_sub_delay", JSON.stringify({ 5: "soon" }));
    expect(renderHook(() => useSubtitleSettings("5")).result.current).toMatchObject({
      delayMs: 0,
      size: "medium",
      style: "outline",
    });
  });
});

describe("SubtitleOverlay", () => {
  beforeEach(() => vi.useFakeTimers());

  it("draws the cue due `delay` ago, and keeps the browser from drawing it too", () => {
    const track = fakeTrack([{ startTime: 10, endTime: 12, text: "Hello" }], "showing");
    const video = fakeVideo(track);
    const ref = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
    ref.current = video;

    const { container, rerender } = render(
      <SubtitleOverlay videoRef={ref} settings={{ delayMs: 0, size: "medium", style: "outline" }} />,
    );
    video.currentTime = 10.5;
    act(() => void vi.advanceTimersByTime(100));
    expect(container.textContent).toBe("Hello");
    expect(track.mode).toBe("hidden");

    // Delayed by 1 s: at 10.5 s nothing is due yet; at 11.2 s the 10–12 s cue is.
    rerender(<SubtitleOverlay videoRef={ref} settings={{ delayMs: 1000, size: "medium", style: "outline" }} />);
    act(() => void vi.advanceTimersByTime(100));
    expect(container.textContent).toBe("");
    video.currentTime = 11.2;
    act(() => void vi.advanceTimersByTime(100));
    expect(container.textContent).toBe("Hello");
  });
});
