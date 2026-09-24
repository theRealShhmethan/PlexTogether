import { randomBytes } from "node:crypto";
import type { PlaybackAnchor } from "@/lib/sync/drift";
import type { PublicRoom, ServerMessage } from "./protocol";

/**
 * In-memory rooms (v0.1; lost on restart).
 *
 * WHY globalThis: this module is loaded twice in one process — once by the
 * custom server (WebSockets, plain Node) and once inside Next.js's bundle
 * (route handlers). Keeping all state on globalThis means both copies see
 * the same rooms and sockets, so a join over HTTP is broadcast to sockets.
 *
 * SECURITY: rooms hold no Plex tokens. A guest's seat is an opaque random
 * secret in an HttpOnly cookie; the room id itself is the invite capability
 * (128 random bits).
 */

export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_PARTICIPANTS = 8;
const MAX_ROOMS = 100;
const SWEEP_INTERVAL_MS = 60_000;
/** "Start Together" schedules playback this far ahead so every player can start on time. */
export const START_DELAY_MS = 2500;
/** Status updates are coalesced into at most one state broadcast per room per this interval. */
const STATUS_BROADCAST_MS = 1000;

export type Participant = {
  id: string;
  name: string;
  role: "host" | "guest";
  ready: boolean;
  joinedAt: number;
  playerReady: boolean;
  buffering: boolean;
  driftMs: number | null;
};

/** What the room plays. Identifies the item on the host's server; no tokens. */
export type RoomItem = {
  ratingKey: string;
  serverId: string;
  serverName: string;
  durationMs: number | null;
};

export type Room = {
  id: string;
  code: string;
  title: string;
  hostSessionId: string;
  hostParticipantId: string;
  participants: Map<string, Participant>;
  item: RoomItem;
  playback: PlaybackAnchor;
  createdAt: number;
  expiresAt: number;
  /** Pending coalesced state broadcast. */
  broadcastTimer?: ReturnType<typeof setTimeout>;
};

/** What the hub needs from a socket; implemented by server.ts with `ws`. */
export type RoomConnection = {
  participantId: string;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
};

type Hub = {
  rooms: Map<string, Room>;
  /** guest secret → seat */
  guests: Map<string, { roomId: string; participantId: string }>;
  sockets: Map<string, Set<RoomConnection>>;
  sweeper: ReturnType<typeof setInterval> | null;
};

const g = globalThis as typeof globalThis & { __plexTogetherRooms?: Hub };
const hub: Hub = (g.__plexTogetherRooms ??= { rooms: new Map(), guests: new Map(), sockets: new Map(), sweeper: null });

if (!hub.sweeper) {
  hub.sweeper = setInterval(() => sweepExpired(), SWEEP_INTERVAL_MS);
  hub.sweeper.unref?.();
}

const randomToken = (bytes: number) => randomBytes(bytes).toString("base64url");

/** "7K2QXD"-style label from the id. Display only. */
function roomCode(id: string): string {
  return id.slice(0, 6).toUpperCase().replace(/[-_]/g, "X");
}

// ---------- queries ----------

export function getRoom(id: string): Room | undefined {
  const room = hub.rooms.get(id);
  if (room && room.expiresAt <= Date.now()) {
    endRoom(id, "expired");
    return undefined;
  }
  return room;
}

export function roomForHost(hostSessionId: string): Room | undefined {
  for (const room of hub.rooms.values()) if (room.hostSessionId === hostSessionId) return getRoom(room.id);
  return undefined;
}

/** Resolves a guest cookie to its seat, if the room and seat still exist. */
export function resolveGuest(secret: string | undefined): { room: Room; participant: Participant } | undefined {
  if (!secret) return undefined;
  const seat = hub.guests.get(secret);
  const room = seat && getRoom(seat.roomId);
  const participant = room?.participants.get(seat!.participantId);
  if (!room || !participant) {
    hub.guests.delete(secret);
    return undefined;
  }
  return { room, participant };
}

export function isConnected(roomId: string, participantId: string): boolean {
  for (const c of hub.sockets.get(roomId) ?? []) if (c.participantId === participantId) return true;
  return false;
}

export function publicRoom(room: Room, viewerId: string): PublicRoom {
  return {
    id: room.id,
    code: room.code,
    title: room.title,
    participants: [...room.participants.values()]
      .sort((a, b) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === "host" ? -1 : 1))
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        ready: p.ready,
        connected: isConnected(room.id, p.id),
        playerReady: p.playerReady,
        buffering: p.buffering,
        driftMs: p.driftMs,
      })),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    you: viewerId,
    playback: room.playback,
  };
}

// ---------- mutations ----------

export type CreateResult = { ok: true; room: Room } | { ok: false; error: string };

/** One room per host: creating a new one ends their previous room. */
const newParticipant = (name: string, role: Participant["role"]): Participant => ({
  id: randomToken(9),
  name,
  role,
  ready: false,
  joinedAt: Date.now(),
  playerReady: false,
  buffering: false,
  driftMs: null,
});

export function createRoom(opts: {
  hostSessionId: string;
  hostName: string;
  title: string;
  item: RoomItem;
}): CreateResult {
  const existing = roomForHost(opts.hostSessionId);
  if (existing) endRoom(existing.id, "replaced");
  if (hub.rooms.size >= MAX_ROOMS) return { ok: false, error: "Too many active rooms on this server. Try again later." };

  const now = Date.now();
  const id = randomToken(16);
  const host = newParticipant(opts.hostName, "host");
  const room: Room = {
    id,
    code: roomCode(id),
    title: opts.title,
    hostSessionId: opts.hostSessionId,
    hostParticipantId: host.id,
    participants: new Map([[host.id, host]]),
    item: opts.item,
    playback: { status: "idle", positionMs: 0, anchorServerTime: now },
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
  };
  hub.rooms.set(id, room);
  return { ok: true, room };
}

export type JoinResult = { ok: true; participant: Participant; secret: string } | { ok: false; error: string };

export function joinRoom(roomId: string, name: string, previousSecret?: string): JoinResult {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: "This watch party has ended or the link is wrong." };
  if (room.participants.size >= MAX_PARTICIPANTS) return { ok: false, error: "This watch party is full." };

  // A browser holds one guest seat at a time; joining again releases the old one.
  const previous = resolveGuest(previousSecret);
  if (previous) leaveRoom(previous.room.id, previous.participant.id);

  const participant = newParticipant(name, "guest");
  room.participants.set(participant.id, participant);
  const secret = randomToken(32);
  hub.guests.set(secret, { roomId, participantId: participant.id });
  broadcast(room);
  return { ok: true, participant, secret };
}

export function leaveRoom(roomId: string, participantId: string): void {
  const room = hub.rooms.get(roomId);
  if (!room || participantId === room.hostParticipantId) return;
  room.participants.delete(participantId);
  for (const [secret, seat] of hub.guests) if (seat.participantId === participantId) hub.guests.delete(secret);
  for (const c of hub.sockets.get(roomId) ?? []) {
    if (c.participantId === participantId) c.close(4010, "left");
  }
  broadcast(room);
}

export function setReady(roomId: string, participantId: string, ready: boolean): void {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p || p.ready === ready) return;
  p.ready = ready;
  broadcast(room);
}

// ---------- playback (host-authoritative) ----------

export type HostAction = "play" | "pause" | "seek" | "tick";

/**
 * Applies the host player's action. The anchor is back-dated by the host's
 * estimated one-way latency, so "position P at server time T" refers to when
 * the host was actually there.
 */
export function hostPlayback(roomId: string, action: HostAction, positionMs: number, latencyMs: number): void {
  const room = getRoom(roomId);
  if (!room) return;
  const anchorServerTime = Date.now() - latencyMs;
  const current = room.playback.status;
  // A tick only re-anchors ongoing playback (it corrects the host's own drift); it never un-pauses.
  if (action === "tick" && current !== "playing") return;
  const status = action === "pause" ? "paused" : action === "seek" ? (current === "idle" ? "paused" : current) : "playing";
  room.playback = { status, positionMs, anchorServerTime };
  broadcastPlayback(room);
}

/** Everyone starts together from `positionMs`, START_DELAY_MS from now. */
export function startTogether(roomId: string, positionMs: number): void {
  const room = getRoom(roomId);
  if (!room) return;
  room.playback = { status: "playing", positionMs, anchorServerTime: Date.now() + START_DELAY_MS };
  broadcastPlayback(room);
}

export function updateStatus(
  roomId: string,
  participantId: string,
  status: { playerReady: boolean; buffering: boolean; driftMs: number | null },
): void {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p) return;
  const important = p.playerReady !== status.playerReady || p.buffering !== status.buffering;
  Object.assign(p, status);
  if (important) broadcast(room);
  else scheduleBroadcast(room);
}

function broadcastPlayback(room: Room): void {
  for (const c of hub.sockets.get(room.id) ?? []) c.send({ type: "playback", playback: room.playback });
}

function scheduleBroadcast(room: Room): void {
  if (room.broadcastTimer) return;
  room.broadcastTimer = setTimeout(() => {
    room.broadcastTimer = undefined;
    if (hub.rooms.has(room.id)) broadcast(room);
  }, STATUS_BROADCAST_MS);
  room.broadcastTimer.unref?.();
}

export function endRoom(roomId: string, reason: "host-ended" | "expired" | "replaced"): void {
  const room = hub.rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.broadcastTimer);
  hub.rooms.delete(roomId);
  for (const [secret, seat] of hub.guests) if (seat.roomId === roomId) hub.guests.delete(secret);
  const sockets = hub.sockets.get(roomId);
  hub.sockets.delete(roomId);
  for (const c of sockets ?? []) {
    c.send({ type: "ended", reason });
    c.close(4010, reason);
  }
}

export function sweepExpired(now = Date.now()): void {
  for (const room of [...hub.rooms.values()]) if (room.expiresAt <= now) endRoom(room.id, "expired");
}

// ---------- sockets ----------

export function attachSocket(roomId: string, conn: RoomConnection): void {
  const set = hub.sockets.get(roomId) ?? new Set();
  set.add(conn);
  hub.sockets.set(roomId, set);
  const room = hub.rooms.get(roomId);
  if (room) broadcast(room);
}

export function detachSocket(roomId: string, conn: RoomConnection): void {
  const set = hub.sockets.get(roomId);
  if (!set?.delete(conn)) return;
  if (set.size === 0) hub.sockets.delete(roomId);
  const room = hub.rooms.get(roomId);
  if (room) broadcast(room);
}

/** Sends each connection its own view of the room (their `you`). */
export function broadcast(room: Room): void {
  clearTimeout(room.broadcastTimer);
  room.broadcastTimer = undefined;
  for (const c of hub.sockets.get(room.id) ?? []) c.send({ type: "state", room: publicRoom(room, c.participantId) });
}

/** Test helper. */
export function _resetRooms(): void {
  hub.rooms.clear();
  hub.guests.clear();
  hub.sockets.clear();
}
