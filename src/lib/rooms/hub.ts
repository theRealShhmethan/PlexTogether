import { randomBytes } from "node:crypto";
import { readSealedFile, writeSealedFile } from "@/lib/crypto/sealedFile";
import { expectedPositionMs, type PlaybackAnchor } from "@/lib/sync/drift";
import type { ChatMessage, Permissions, PublicRoom, Reaction, ServerMessage } from "./protocol";

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
 *
 * PERSISTENCE: with SESSION_SECRET set, rooms are also saved (encrypted — they
 * contain seat secrets and the host's session id) so a server restart doesn't
 * end watch parties. Restored rooms come back paused where they were.
 */

export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_PARTICIPANTS = 8;
const MAX_ROOMS = 100;
const SWEEP_INTERVAL_MS = 60_000;
/** "Start Together" schedules playback this far ahead so every player can start on time. */
export const START_DELAY_MS = 2500;
/** Status updates are coalesced into at most one state broadcast per room per this interval. */
const STATUS_BROADCAST_MS = 1000;
/** Someone buffering this long pauses the room for everyone. Shorter hiccups are ignored. */
export const BUFFER_GRACE_MS = 1500;
/** After buffering ends, everyone resumes together this far ahead. */
export const RESUME_DELAY_MS = 1500;

export type Participant = {
  id: string;
  name: string;
  role: "host" | "guest";
  ready: boolean;
  joinedAt: number;
  playerReady: boolean;
  buffering: boolean;
  driftMs: number | null;
  permissions: Permissions;
  /** Last reported media position (ms). */
  positionMs: number | null;
  /** When this player started buffering (for the grace period). */
  bufferingSince: number | null;
};

/** What the room plays. Identifies the item on the host's server; no tokens. */
export type RoomItem = {
  ratingKey: string;
  serverId: string;
  serverName: string;
  durationMs: number | null;
  /** The host's Plex resume point when the room was created; the room starts there. */
  resumeMs?: number | null;
  /** For episodes: the next episode in the show. */
  next?: { ratingKey: string; title: string } | null;
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
  /**
   * Participants whose buffering auto-paused the room, and the anchor seq of
   * that auto-pause (if anyone acts after it, we don't auto-resume over them).
   */
  waitingFor: Set<string>;
  autoPauseSeq: number | null;
  bufferTimer?: ReturnType<typeof setTimeout>;
  /** Start automatically once everyone's player is loaded (after "next episode"). */
  autoStart: boolean;
  /** Recent chat (memory only, not saved to disk). */
  chat: ChatMessage[];
  /** Per-participant timestamps of recent chat/reactions, for rate limiting. */
  chatTimes: Map<string, number[]>;
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
  persist: { key: Buffer; path: string } | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
};

const g = globalThis as typeof globalThis & { __plexTogetherRooms?: Hub };
const hub: Hub = (g.__plexTogetherRooms ??= {
  rooms: new Map(),
  guests: new Map(),
  sockets: new Map(),
  sweeper: null,
  persist: null,
  saveTimer: null,
});

if (!hub.sweeper) {
  hub.sweeper = setInterval(() => sweepExpired(), SWEEP_INTERVAL_MS);
  hub.sweeper.unref?.();
}

const randomToken = (bytes: number) => randomBytes(bytes).toString("base64url");

// ---------- persistence ----------

const ROOMS_PURPOSE = "plextogether-rooms-v1";
const SAVE_DEBOUNCE_MS = 1000;

type SavedParticipant = Pick<Participant, "id" | "name" | "role" | "ready" | "joinedAt" | "permissions">;
type SavedRoom = Omit<
  Room,
  "participants" | "waitingFor" | "autoPauseSeq" | "broadcastTimer" | "bufferTimer" | "chat" | "chatTimes" | "autoStart"
> & {
  participants: SavedParticipant[];
};
type Snapshot = { savedAt: number; rooms: SavedRoom[]; guests: [string, { roomId: string; participantId: string }][] };

function snapshot(): Snapshot {
  return {
    savedAt: Date.now(),
    rooms: [...hub.rooms.values()].map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      hostSessionId: r.hostSessionId,
      hostParticipantId: r.hostParticipantId,
      item: r.item,
      playback: r.playback,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      participants: [...r.participants.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        ready: p.ready,
        joinedAt: p.joinedAt,
        permissions: p.permissions,
      })),
    })),
    guests: [...hub.guests.entries()],
  };
}

/** Writes the rooms file now (e.g. on shutdown). */
export function flushRooms(): void {
  if (hub.saveTimer) clearTimeout(hub.saveTimer);
  hub.saveTimer = null;
  if (hub.persist) writeSealedFile(hub.persist.path, hub.persist.key, ROOMS_PURPOSE, snapshot(), "rooms");
}

/** Schedules a save soon; cheap to call on every change. */
function markDirty(): void {
  if (!hub.persist || hub.saveTimer) return;
  hub.saveTimer = setTimeout(flushRooms, SAVE_DEBOUNCE_MS);
  hub.saveTimer.unref?.();
}

/**
 * Enables persistence and restores saved rooms (call once at startup). Live
 * state (connections, buffering, drift) isn't restored; a room that was
 * playing comes back paused at the position it had reached when saved.
 */
export function configureRoomPersistence(cfg: { key: Buffer; path: string } | null): number {
  hub.persist = cfg;
  if (!cfg) return 0;
  const value = readSealedFile(cfg.path, cfg.key, ROOMS_PURPOSE) as Snapshot | null | undefined;
  if (value === undefined) return 0;
  if (value === null || !Array.isArray(value.rooms)) {
    console.warn("[rooms] saved rooms file could not be decrypted (key changed or file damaged); starting fresh");
    return 0;
  }
  const now = Date.now();
  let restored = 0;
  for (const saved of value.rooms) {
    if (!saved?.id || saved.expiresAt <= now || hub.rooms.has(saved.id)) continue;
    const a = saved.playback;
    const playback: PlaybackAnchor =
      a.status === "playing"
        ? {
            status: "paused",
            positionMs: expectedPositionMs(a, value.savedAt),
            anchorServerTime: now,
            by: null,
            seq: a.seq + 1,
          }
        : a;
    const participants = new Map<string, Participant>();
    for (const p of saved.participants) {
      participants.set(p.id, { ...newParticipant(p.name, p.role), ...p });
    }
    hub.rooms.set(saved.id, {
      ...saved,
      participants,
      playback,
      waitingFor: new Set(),
      autoPauseSeq: null,
      autoStart: false,
      chat: [],
      chatTimes: new Map(),
    });
    restored++;
  }
  for (const [secret, seat] of value.guests ?? []) if (hub.rooms.has(seat.roomId)) hub.guests.set(secret, seat);
  return restored;
}

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
        permissions: p.permissions,
      })),
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    you: viewerId,
    playback: room.playback,
    durationMs: room.item.durationMs,
    resumeMs: room.item.resumeMs ?? null,
    itemKey: room.item.ratingKey,
    next: room.item.next ? { title: room.item.next.title } : null,
    autoStart: room.autoStart,
    waitingFor: [...room.waitingFor].map((id) => room.participants.get(id)?.name).filter((n): n is string => !!n),
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
  // Guests may pause and skip by default; the host can change it per guest.
  permissions: { playPause: true, seek: true },
  positionMs: null,
  bufferingSince: null,
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
    playback: { status: "idle", positionMs: opts.item.resumeMs ?? 0, anchorServerTime: now, by: null, seq: 0 },
    waitingFor: new Set(),
    autoPauseSeq: null,
    autoStart: false,
    chat: [],
    chatTimes: new Map(),
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
  };
  hub.rooms.set(id, room);
  markDirty();
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
  markDirty();
  broadcast(room);
  return { ok: true, participant, secret };
}

export function leaveRoom(roomId: string, participantId: string): void {
  const room = hub.rooms.get(roomId);
  if (!room || participantId === room.hostParticipantId) return;
  room.participants.delete(participantId);
  room.waitingFor.delete(participantId);
  for (const [secret, seat] of hub.guests) if (seat.participantId === participantId) hub.guests.delete(secret);
  for (const c of hub.sockets.get(roomId) ?? []) {
    if (c.participantId === participantId) c.close(4010, "left");
  }
  markDirty();
  broadcast(room);
}

export function setReady(roomId: string, participantId: string, ready: boolean): void {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p || p.ready === ready) return;
  p.ready = ready;
  markDirty();
  broadcast(room);
}

// ---------- playback ----------

export type ControlAction = "play" | "pause" | "seek" | "tick";

/** SECURITY: the server enforces permissions; the browser only hides controls. */
export function canControl(room: Room, participantId: string, action: ControlAction): boolean {
  if (participantId === room.hostParticipantId) return true;
  const p = room.participants.get(participantId);
  if (!p) return false;
  if (action === "tick") return room.playback.by === participantId;
  return action === "seek" ? p.permissions.seek : p.permissions.playPause;
}

/**
 * Applies a participant's play/pause/seek. Their player becomes the reference
 * everyone else follows. The anchor is back-dated by their estimated one-way
 * latency, so "position P at server time T" refers to when they were actually
 * there. Returns false if they aren't allowed.
 */
export function controlPlayback(
  roomId: string,
  participantId: string,
  action: ControlAction,
  positionMs: number,
  latencyMs: number,
): boolean {
  const room = getRoom(roomId);
  if (!room || !canControl(room, participantId, action)) return false;
  const current = room.playback;
  // A tick only refreshes ongoing playback from the reference player; it never un-pauses.
  if (action === "tick" && (current.status !== "playing" || current.by !== participantId)) return true;
  // Seeking before the start (choosing resume vs beginning) keeps the room waiting for Start Together.
  const status = action === "pause" ? "paused" : action === "seek" ? current.status : "playing";
  room.playback = { status, positionMs, anchorServerTime: Date.now() - latencyMs, by: participantId, seq: current.seq + 1 };
  // A deliberate action overrides any buffering wait.
  clearWaiting(room);
  broadcastPlayback(room);
  return true;
}

/** Host only: everyone starts together from `positionMs`, START_DELAY_MS from now. */
export function startTogether(roomId: string, participantId: string, positionMs: number): boolean {
  const room = getRoom(roomId);
  if (!room || participantId !== room.hostParticipantId) return false;
  room.playback = {
    status: "playing",
    positionMs,
    anchorServerTime: Date.now() + START_DELAY_MS,
    by: null,
    seq: room.playback.seq + 1,
  };
  clearWaiting(room);
  room.autoStart = false;
  broadcastPlayback(room);
  return true;
}

// ---------- what's playing ----------

/**
 * Host only: switch the room to another title (same link, same people).
 * Everyone's player reloads it; the room waits at its resume point for Start
 * Together — or starts by itself once all are loaded if `autoStart` (next episode).
 */
export function changeItem(
  roomId: string,
  byId: string,
  change: { title: string; item: RoomItem; autoStart: boolean },
): boolean {
  const room = getRoom(roomId);
  if (!room || byId !== room.hostParticipantId) return false;
  room.item = change.item;
  room.title = change.title;
  room.autoStart = change.autoStart;
  room.playback = {
    status: "idle",
    positionMs: change.item.resumeMs ?? 0,
    anchorServerTime: Date.now(),
    by: null,
    seq: room.playback.seq + 1,
  };
  room.waitingFor.clear();
  room.autoPauseSeq = null;
  for (const p of room.participants.values()) {
    p.playerReady = false;
    p.buffering = false;
    p.bufferingSince = null;
    p.driftMs = null;
    p.positionMs = null;
  }
  broadcastPlayback(room);
  broadcast(room);
  return true;
}

// ---------- chat & reactions ----------

const CHAT_HISTORY = 100;
/** At most this many chat messages/reactions per participant per window. */
const CHAT_RATE = { count: 8, windowMs: 10_000 };

function allowChat(room: Room, participantId: string, now: number): boolean {
  const times = (room.chatTimes.get(participantId) ?? []).filter((t) => now - t < CHAT_RATE.windowMs);
  if (times.length >= CHAT_RATE.count) {
    room.chatTimes.set(participantId, times);
    return false;
  }
  times.push(now);
  room.chatTimes.set(participantId, times);
  return true;
}

/** Plain text only: control characters removed, whitespace collapsed. Rendered as text (never HTML). */
export function cleanChatText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export type ChatResult = "ok" | "rate-limited" | "empty" | "not-found";

export function postChat(roomId: string, participantId: string, rawText: string): ChatResult {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p) return "not-found";
  const text = cleanChatText(rawText);
  if (!text) return "empty";
  const now = Date.now();
  if (!allowChat(room, participantId, now)) return "rate-limited";
  const message: ChatMessage = { id: randomToken(8), from: p.id, name: p.name, text, at: now };
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
  for (const c of hub.sockets.get(room.id) ?? []) c.send({ type: "chat", message });
  return "ok";
}

export function react(roomId: string, participantId: string, emoji: Reaction): ChatResult {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p) return "not-found";
  const now = Date.now();
  if (!allowChat(room, participantId, now)) return "rate-limited";
  for (const c of hub.sockets.get(room.id) ?? []) c.send({ type: "reaction", from: p.id, name: p.name, emoji, at: now });
  return "ok";
}

// ---------- buffering: pause for everyone, resume together ----------

function clearWaiting(room: Room): void {
  const had = room.waitingFor.size > 0;
  room.waitingFor.clear();
  room.autoPauseSeq = null;
  if (had) scheduleBroadcast(room);
}

/**
 * Called when a participant's buffering state changes. If someone has been
 * buffering past the grace period while the room plays, pause the room at
 * their position (so they needn't seek) and wait for them. When nobody we're
 * waiting for is buffering any more, resume together a moment ahead.
 */
function evaluateBuffering(room: Room): void {
  const now = Date.now();
  const a = room.playback;
  const due = a.status === "playing" && now >= a.anchorServerTime;
  const stalled = [...room.participants.values()].filter(
    (p) => p.playerReady && p.buffering && p.bufferingSince !== null && now - p.bufferingSince >= BUFFER_GRACE_MS,
  );

  if (due && stalled.length > 0) {
    // Pause where the furthest-behind stalled player is.
    const expected = expectedPositionMs(a, now);
    const at = Math.min(expected, ...stalled.map((p) => p.positionMs ?? expected));
    room.playback = { status: "paused", positionMs: Math.max(0, at), anchorServerTime: now, by: null, seq: a.seq + 1 };
    room.autoPauseSeq = room.playback.seq;
    for (const p of stalled) room.waitingFor.add(p.id);
    broadcastPlayback(room);
    broadcast(room);
    return;
  }

  if (room.autoPauseSeq !== null) {
    // Someone new stalled while we were already waiting: wait for them too.
    for (const p of stalled) room.waitingFor.add(p.id);
    const stillWaiting = [...room.waitingFor].some((id) => {
      const p = room.participants.get(id);
      return p && p.buffering && p.playerReady;
    });
    if (!stillWaiting && room.playback.seq === room.autoPauseSeq) {
      room.playback = {
        status: "playing",
        positionMs: room.playback.positionMs,
        anchorServerTime: now + RESUME_DELAY_MS,
        by: null,
        seq: room.playback.seq + 1,
      };
      room.waitingFor.clear();
      room.autoPauseSeq = null;
      broadcastPlayback(room);
      broadcast(room);
    }
  }
}

/** Host only: sets a guest's permissions, or every guest's with "*". */
export function setPermissions(roomId: string, byId: string, targetId: string, permissions: Permissions): boolean {
  const room = getRoom(roomId);
  if (!room || byId !== room.hostParticipantId) return false;
  for (const p of room.participants.values()) {
    if (p.role === "guest" && (targetId === "*" || p.id === targetId)) p.permissions = { ...permissions };
  }
  markDirty();
  broadcast(room);
  return true;
}

export function updateStatus(
  roomId: string,
  participantId: string,
  status: { playerReady: boolean; buffering: boolean; driftMs: number | null; positionMs: number | null },
): void {
  const room = getRoom(roomId);
  const p = room?.participants.get(participantId);
  if (!room || !p) return;
  const important = p.playerReady !== status.playerReady || p.buffering !== status.buffering;
  if (status.buffering && !p.buffering) {
    p.bufferingSince = Date.now();
    // Re-check once the grace period has passed, even if no further status arrives.
    clearTimeout(room.bufferTimer);
    room.bufferTimer = setTimeout(() => {
      const r = hub.rooms.get(room.id);
      if (r) evaluateBuffering(r);
    }, BUFFER_GRACE_MS + 50);
    room.bufferTimer.unref?.();
  }
  if (!status.buffering) p.bufferingSince = null;
  Object.assign(p, status);
  evaluateBuffering(room);
  if (important) broadcast(room);
  else scheduleBroadcast(room);
}

function broadcastPlayback(room: Room): void {
  markDirty();
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
  clearTimeout(room.bufferTimer);
  hub.rooms.delete(roomId);
  markDirty();
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
  if (!room) return;
  conn.send({ type: "chatHistory", messages: room.chat });
  broadcast(room);
}

export function detachSocket(roomId: string, conn: RoomConnection): void {
  const set = hub.sockets.get(roomId);
  if (!set?.delete(conn)) return;
  if (set.size === 0) hub.sockets.delete(roomId);
  const room = hub.rooms.get(roomId);
  if (!room) return;
  const p = room.participants.get(conn.participantId);
  if (p && !isConnected(roomId, p.id)) {
    // Gone: don't hold the room for them. They catch up when they reconnect.
    p.playerReady = false;
    p.buffering = false;
    p.bufferingSince = null;
    p.driftMs = null;
    evaluateBuffering(room);
  }
  broadcast(room);
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
  hub.persist = null;
  if (hub.saveTimer) clearTimeout(hub.saveTimer);
  hub.saveTimer = null;
}
