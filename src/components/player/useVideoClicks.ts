"use client";

import { useEffect, useRef, type RefObject } from "react";

/** A second click within this long counts as a double-click. */
const DOUBLE_CLICK_MS = 250;

export function toggleFullscreen(el: HTMLElement | null) {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el?.requestFullscreen();
}

/**
 * Click on the video = play/pause; double-click = fullscreen. The single
 * click waits briefly so a double-click doesn't also pause and resume
 * (which in a room would send two control messages to everyone).
 */
export function useVideoClicks(onSingleClick: () => void, containerRef: RefObject<HTMLElement | null>) {
  const timer = useRef<number | undefined>(undefined);
  const single = useRef(onSingleClick);
  useEffect(() => {
    single.current = onSingleClick;
  }, [onSingleClick]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return {
    onClick: () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => single.current(), DOUBLE_CLICK_MS);
    },
    onDoubleClick: () => {
      window.clearTimeout(timer.current);
      toggleFullscreen(containerRef.current);
    },
  };
}
