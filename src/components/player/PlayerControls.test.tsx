// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerControls } from "./PlayerControls";

function Harness({ onToggle }: { onToggle: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={boxRef} className="video-box" data-testid="box">
      <video ref={videoRef} data-testid="video" />
      <PlayerControls
        videoRef={videoRef}
        containerRef={boxRef}
        mediaTimeMs={() => 60_000}
        durationMs={() => 3_600_000}
        onTogglePlay={onToggle}
        onSeek={() => {}}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlayerControls auto-hide", () => {
  it("hides after 10 s of no activity while playing, and comes back on mouse movement", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Harness onToggle={() => {}} />);
    const video = getByTestId("video") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    const box = getByTestId("box");

    act(() => vi.advanceTimersByTime(10_500));
    expect(box.classList.contains("idle")).toBe(true);

    act(() => {
      video.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(300));
    expect(box.classList.contains("idle")).toBe(false);
  });

  it("comes back on movement anywhere on the page (e.g. fullscreen overlays)", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Harness onToggle={() => {}} />);
    const video = getByTestId("video") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    act(() => vi.advanceTimersByTime(10_500));
    expect(getByTestId("box").classList.contains("idle")).toBe(true);
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(getByTestId("box").classList.contains("idle")).toBe(false);
  });

  it("stays visible while the pointer is over the bar", () => {
    vi.useFakeTimers();
    const { getByTestId, container } = render(<Harness onToggle={() => {}} />);
    const video = getByTestId("video") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    const bar = container.querySelector(".controls")!;
    act(() => {
      fireEvent.pointerOver(bar);
    });
    act(() => vi.advanceTimersByTime(35_000));
    expect(getByTestId("box").classList.contains("idle")).toBe(false);
    act(() => {
      fireEvent.pointerOut(bar);
    });
    act(() => vi.advanceTimersByTime(10_500));
    expect(getByTestId("box").classList.contains("idle")).toBe(true);
  });

  it("never hides while paused", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Harness onToggle={() => {}} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(getByTestId("box").classList.contains("idle")).toBe(false);
  });
});

describe("video clicks", () => {
  it("single click toggles play after a short wait; double-click goes fullscreen without toggling play", async () => {
    vi.useFakeTimers();
    const { useVideoClicks } = await import("./useVideoClicks");
    const toggle = vi.fn();
    const requestFullscreen = vi.fn(async () => {});
    function Clicks() {
      const box = useRef<HTMLDivElement>(null);
      const handlers = useVideoClicks(toggle, box);
      return (
        <div ref={box} data-testid="fsbox">
          <video data-testid="v" {...handlers} />
        </div>
      );
    }
    const { getByTestId } = render(<Clicks />);
    (getByTestId("fsbox") as HTMLDivElement).requestFullscreen = requestFullscreen;

    fireEvent.click(getByTestId("v"));
    expect(toggle).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(toggle).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId("v"));
    fireEvent.click(getByTestId("v"));
    fireEvent.doubleClick(getByTestId("v"));
    act(() => vi.advanceTimersByTime(300));
    expect(toggle).toHaveBeenCalledTimes(1); // unchanged
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});
