import { z } from "zod";

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
};

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
};

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), ready: z.boolean() }),
  // Round-trip timing; Phase 7 uses it for clock-offset estimates.
  z.object({ type: z.literal("ping"), t: z.number().finite() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "state"; room: PublicRoom }
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
