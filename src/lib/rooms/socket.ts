import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { COOKIE_GUEST, COOKIE_SESSION, readCookie } from "@/lib/session/cookieNames";
import { getSession } from "@/lib/session/store";
import {
  attachSocket,
  detachSocket,
  getRoom,
  controlPlayback,
  postChat,
  react,
  resolveGuest,
  setPermissions,
  setReady,
  startTogether,
  updateStatus,
  type RoomConnection,
} from "./hub";
import { CLOSE, ClientMessageSchema, ROOM_SOCKET_PATH, RoomIdSchema, type ServerMessage } from "./protocol";

/**
 * Room WebSockets, served by the custom server (server.ts) at
 * /ws/rooms/<roomId>. Only used from plain Node — not bundled by Next.js.
 *
 * SECURITY:
 * - Origin must equal APP_URL's origin (blocks cross-site WebSocket hijacking;
 *   browsers send cookies on WS upgrades regardless of origin).
 * - The host is identified by their session cookie; guests by their seat cookie.
 * - Every inbound message is size-limited and schema-validated.
 */

const MAX_MESSAGE_BYTES = 4 * 1024;
const HEARTBEAT_MS = 30_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
const alive = new WeakMap<WebSocket, boolean>();

setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Who is connecting? Returns their participant id in the room, or null. */
function identify(req: IncomingMessage, roomId: string): string | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const session = getSession(readCookie(req.headers.cookie, COOKIE_SESSION));
  if (session && session.id === room.hostSessionId) return room.hostParticipantId;
  const guest = resolveGuest(readCookie(req.headers.cookie, COOKIE_GUEST));
  if (guest && guest.room.id === roomId) return guest.participant.id;
  return null;
}

/** Returns true if the upgrade was ours (a room socket), false to let Next.js handle it. */
export function handleRoomUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, appOrigin: string): boolean {
  const url = new URL(req.url ?? "/", "http://placeholder");
  if (!url.pathname.startsWith(ROOM_SOCKET_PATH)) return false;

  if (req.headers.origin !== appOrigin) {
    reject(socket, 403, "Forbidden");
    return true;
  }
  const roomId = RoomIdSchema.safeParse(url.pathname.slice(ROOM_SOCKET_PATH.length));
  if (!roomId.success) {
    reject(socket, 404, "Not Found");
    return true;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const participantId = identify(req, roomId.data);
    if (!participantId) {
      // Close with a reason the client can act on (rejoin vs. room gone).
      ws.close(getRoom(roomId.data) ? CLOSE.unauthorized : CLOSE.notFound, "not a participant");
      return;
    }
    const conn: RoomConnection = {
      participantId,
      send: (message: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return conn.send({ type: "error", message: "Invalid message" });
      }
      const msg = ClientMessageSchema.safeParse(parsed);
      if (!msg.success) return conn.send({ type: "error", message: "Invalid message" });
      switch (msg.data.type) {
        case "ready":
          setReady(roomId.data, participantId, msg.data.ready);
          break;
        case "ping":
          conn.send({ type: "pong", t: msg.data.t, serverTime: Date.now() });
          break;
        case "status":
          updateStatus(roomId.data, participantId, msg.data);
          break;
        case "control":
          if (!controlPlayback(roomId.data, participantId, msg.data.action, msg.data.positionMs, msg.data.latencyMs)) {
            conn.send({ type: "error", message: "The host hasn't allowed you to do that" });
          }
          break;
        case "start":
          if (!startTogether(roomId.data, participantId, msg.data.positionMs)) {
            conn.send({ type: "error", message: "Only the host can start the watch party" });
          }
          break;
        case "chat":
        case "react": {
          const r =
            msg.data.type === "chat"
              ? postChat(roomId.data, participantId, msg.data.text)
              : react(roomId.data, participantId, msg.data.emoji);
          if (r === "rate-limited") conn.send({ type: "error", message: "Slow down a little — too many messages." });
          break;
        }
        case "permissions": {
          const { participantId: target, playPause, seek } = msg.data;
          if (!setPermissions(roomId.data, participantId, target, { playPause, seek })) {
            conn.send({ type: "error", message: "Only the host can change permissions" });
          }
          break;
        }
      }
    });
    ws.on("close", () => detachSocket(roomId.data, conn));
    ws.on("error", () => ws.terminate());
    attachSocket(roomId.data, conn);
  });
  return true;
}
