import { z } from "zod";
import type { PlaybackAnchor } from "@/lib/sync/drift";

/**
 * Room WebSocket protocol, shared by the server (server.ts) and browsers.
 * Every inbound message is validated; nothing here ever carries a Plex token.
 */

export type PublicParticipant = {
  id: string;
  name: string;
  role: "host" | "guest";
  ready: boolean;
  connected: boolean;
  /** Player loaded and able to follow playback. */
  playerReady: boolean;
  buffering: boolean;
  /** Last reported distance from the room's reference player (ms, + = ahead); null if not playing. */
  driftMs: number | null;
  /** What this participant may do (the host can always do everything). */
  permissions: Permissions;
};

export type Permissions = { playPause: boolean; seek: boolean };

export type PublicRoom = {
  id: string;
  /** Short, human-friendly label. NOT a secret and NOT enough to join — the full id is. */
  code: string;
  title: string;
  participants: PublicParticipant[];
  createdAt: number;
  expiresAt: number;
  /** The viewer's own participant id. */
  you: string;
  /** The room's playback: who last played/paused/seeked, where, and when. */
  playback: PlaybackAnchor;
  durationMs: number | null;
  /** Where the host left off on Plex when the room was created (null = start at the beginning). */
  resumeMs: number | null;
  /** Names of people whose buffering has paused the room ("Waiting for Lexi…"). */
  waitingFor: string[];
};

const PositionMs = z.number().finite().min(0).max(24 * 60 * 60 * 1000);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), ready: z.boolean() }),
  // Round-trip timing for clock-offset estimates. `t` is the client's Date.now().
  z.object({ type: z.literal("ping"), t: z.number().finite() }),
  // What this participant's player just did (allowed per their permissions).
  // `latencyMs` ≈ one-way delay, used to back-date the anchor.
  z.object({
    type: z.literal("control"),
    action: z.enum(["play", "pause", "seek", "tick"]),
    positionMs: PositionMs,
    latencyMs: z.number().finite().min(0).max(5000),
  }),
  // Host only: everyone starts together from `positionMs`, a moment from now.
  z.object({ type: z.literal("start"), positionMs: PositionMs }),
  // Host only: a guest's permissions ("*" = every guest).
  z.object({
    type: z.literal("permissions"),
    participantId: z.string().min(1).max(64),
    playPause: z.boolean(),
    seek: z.boolean(),
  }),
  // Anyone: their player's state, for sync display (and Phase 8 buffering).
  z.object({
    type: z.literal("status"),
    playerReady: z.boolean(),
    buffering: z.boolean(),
    // Where this player is (media time); used to pause the room at a buffering player's position.
    positionMs: PositionMs.nullable(),
    driftMs: z.number().finite().min(-86_400_000).max(86_400_000).nullable(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "state"; room: PublicRoom }
  // Sent on every host playback change; cheaper than a full state message.
  | { type: "playback"; playback: PlaybackAnchor }
  | { type: "ended"; reason: "host-ended" | "expired" | "replaced" | "removed" }
  | { type: "pong"; t: number; serverTime: number }
  | { type: "error"; message: string };

/** Display names: trimmed, 1–32 characters, no control characters. */
export const DisplayNameSchema = z
  .string()
  .transform((s) => s.normalize("NFC").replace(/[\p{C}]/gu, "").replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "Enter a name").max(32, "Keep it under 32 characters"));

/** Room ids are 16 random bytes, base64url (22 chars). */
export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const ROOM_SOCKET_PATH = "/ws/rooms/";

/** WebSocket close codes (4000–4999 are application-defined). */
export const CLOSE = {
  unauthorized: 4001,
  notFound: 4004,
  ended: 4010,
} as const;
