"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOSE, ROOM_SOCKET_PATH, type ClientMessage, type PublicRoom, type ServerMessage } from "@/lib/rooms/protocol";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "ended" | "not-participant";

const PING_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Keeps a WebSocket to the room open, reconnecting with backoff, and exposes
 * the latest room state. (Phase 8 will add state recovery on top of this.)
 */
export function useRoomSocket(roomId: string, initial: PublicRoom) {
  const [room, setRoom] = useState<PublicRoom>(initial);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}${ROOM_SOCKET_PATH}${roomId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("open");
        const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
        ping();
        pingTimer = window.setInterval(ping, PING_MS);
      };
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "state") setRoom(msg.room);
        else if (msg.type === "pong") setRttMs(Math.round(performance.now() - msg.t));
        else if (msg.type === "ended") {
          setEndedReason(msg.reason);
          setStatus("ended");
        }
      };
      ws.onclose = (ev) => {
        window.clearInterval(pingTimer);
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
      wsRef.current?.close();
    };
  }, [roomId]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { room, status, endedReason, rttMs, send };
}
