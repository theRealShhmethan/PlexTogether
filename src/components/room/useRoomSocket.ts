"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOSE, ROOM_SOCKET_PATH, type ClientMessage, type PublicRoom, type ServerMessage } from "@/lib/rooms/protocol";
import { ClockSync } from "@/lib/sync/clock";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "ended" | "not-participant";

/** A quick burst of pings on connect gives a good clock estimate fast; then keep it fresh. */
const PING_BURST = 5;
const PING_BURST_GAP_MS = 250;
const PING_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Keeps a WebSocket to the room open, reconnecting with backoff, and exposes
 * the latest room state plus a server-clock estimate for playback sync.
 * (Phase 8 will add state recovery on top of this.)
 */
export function useRoomSocket(roomId: string, initial: PublicRoom) {
  const [room, setRoom] = useState<PublicRoom>(initial);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const clockRef = useRef(new ClockSync());

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;
    const burstTimers: number[] = [];

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}${ROOM_SOCKET_PATH}${roomId}`);
      wsRef.current = ws;
      const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping", t: Date.now() }));

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        for (let i = 0; i < PING_BURST; i++) burstTimers.push(window.setTimeout(ping, i * PING_BURST_GAP_MS));
        pingTimer = window.setInterval(ping, PING_MS);
      };
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "state":
            setRoom(msg.room);
            break;
          case "playback":
            setRoom((r) => ({ ...r, playback: msg.playback }));
            break;
          case "pong": {
            const sample = clockRef.current.addSample(msg.t, msg.serverTime, Date.now());
            if (sample) setRttMs(Math.round(sample.rttMs));
            break;
          }
          case "ended":
            setEndedReason(msg.reason);
            setStatus("ended");
            break;
        }
      };
      ws.onclose = (ev) => {
        window.clearInterval(pingTimer);
        burstTimers.splice(0).forEach((t) => window.clearTimeout(t));
        if (stopped) return;
        if (ev.code === CLOSE.ended || ev.code === CLOSE.notFound) {
          setStatus("ended");
          return;
        }
        if (ev.code === CLOSE.unauthorized) {
          setStatus("not-participant");
          return;
        }
        setStatus("reconnecting");
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      burstTimers.forEach((t) => window.clearTimeout(t));
      wsRef.current?.close();
    };
  }, [roomId]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** Estimated server time now (ms). */
  const serverNow = useCallback(() => clockRef.current.serverNow(), []);

  return { room, status, endedReason, rttMs, send, serverNow };
}
