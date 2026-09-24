import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { _resetStores, saveSession, type HostSession } from "@/lib/session/store";
import { _resetRooms, createRoom, endRoom, getRoom, joinRoom, leaveRoom, resolveGuest } from "./hub";
import type { PublicRoom, ServerMessage } from "./protocol";
import { handleRoomUpgrade } from "./socket";

const ORIGIN = "http://localhost:3000";
const item = { ratingKey: "70", serverId: "machine-1", serverName: "Synology-NAS", durationMs: 7_800_000 };
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => {
    if (!handleRoomUpgrade(req, socket, head, ORIGIN)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  _resetRooms();
  _resetStores();
});

function hostSession(id = "host-session"): HostSession {
  const s: HostSession = {
    id,
    clientIdentifier: "cid",
    plex: { mode: "legacy", token: "SECRET-PLEX-TOKEN" },
    user: { id: 1, title: "Ethan" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  saveSession(s);
  return s;
}

type Client = { ws: WebSocket; messages: ServerMessage[]; closed: Promise<{ code: number }> };

function connect(roomId: string, cookie: string, origin = ORIGIN): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms/${roomId}`, { headers: { cookie, origin } });
  const messages: ServerMessage[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages, closed }));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on("error", reject);
  });
}

async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

const lastState = (c: Client): PublicRoom | undefined =>
  [...c.messages].reverse().find((m): m is Extract<ServerMessage, { type: "state" }> => m.type === "state")?.room;

describe("room hub", () => {
  it("creates unguessable room ids and one room per host", () => {
    const a = createRoom({ hostSessionId: "h", hostName: "Ethan", title: "Top Gun", item });
    const b = createRoom({ hostSessionId: "h", hostName: "Ethan", title: "Heat", item });
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(a.room.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(getRoom(a.room.id)).toBeUndefined(); // replaced
    expect(getRoom(b.room.id)).toBeDefined();
  });

  it("gives guests a seat secret that dies when they leave or the room ends", () => {
    const r = createRoom({ hostSessionId: "h", hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    expect(resolveGuest(j.secret)?.participant.name).toBe("Lexi");
    leaveRoom(r.room.id, j.participant.id);
    expect(resolveGuest(j.secret)).toBeUndefined();

    const j2 = joinRoom(r.room.id, "Lexi");
    if (!j2.ok) throw new Error();
    endRoom(r.room.id, "host-ended");
    expect(resolveGuest(j2.secret)).toBeUndefined();
  });

  it("releases a browser's previous seat when it joins again", () => {
    const r = createRoom({ hostSessionId: "h", hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const first = joinRoom(r.room.id, "Lexi");
    if (!first.ok) throw new Error();
    const second = joinRoom(r.room.id, "Lexi 2", first.secret);
    if (!second.ok) throw new Error();
    expect(resolveGuest(first.secret)).toBeUndefined();
    expect(getRoom(r.room.id)!.participants.size).toBe(2);
  });
});

describe("room sockets", () => {
  it("identifies host and guest, broadcasts ready state, and never sends tokens", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "Top Gun", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();

    const host = await connect(r.room.id, `pt_session=${session.id}`);
    const guest = await connect(r.room.id, `pt_guest=${j.secret}`);

    const seen = await until(() => {
      const s = lastState(host);
      return s && s.participants.every((p) => p.connected) ? s : undefined;
    });
    expect(seen.participants.map((p) => [p.name, p.role])).toEqual([
      ["Ethan", "host"],
      ["Lexi", "guest"],
    ]);
    expect(seen.you).toBe(r.room.hostParticipantId);
    expect(lastState(guest)?.you).toBe(j.participant.id);

    guest.ws.send(JSON.stringify({ type: "ready", ready: true }));
    await until(() => lastState(host)?.participants.find((p) => p.name === "Lexi")?.ready || undefined);

    const all = JSON.stringify([...host.messages, ...guest.messages]);
    expect(all).not.toContain("SECRET-PLEX-TOKEN");
    expect(all).not.toContain(j.secret);

    host.ws.close();
    guest.ws.close();
  });

  it("answers pings with server time", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const host = await connect(r.room.id, `pt_session=${session.id}`);
    host.ws.send(JSON.stringify({ type: "ping", t: 123 }));
    const pong = await until(() => host.messages.find((m) => m.type === "pong"));
    expect(pong).toMatchObject({ type: "pong", t: 123 });
    host.ws.close();
  });

  it("rejects cross-origin connections before upgrading", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    await expect(connect(r.room.id, `pt_session=${session.id}`, "https://evil.example")).rejects.toThrow(/403/);
  });

  it("closes connections from non-participants, and from anyone once the room is gone", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const stranger = await connect(r.room.id, "pt_guest=made-up");
    expect((await stranger.closed).code).toBe(4001);
    const other = hostSession("someone-else");
    const notHost = await connect(r.room.id, `pt_session=${other.id}`);
    expect((await notHost.closed).code).toBe(4001);
    const missing = await connect("AAAAAAAAAAAAAAAAAAAAAA", `pt_session=${session.id}`);
    expect((await missing.closed).code).toBe(4004);
  });

  it("tells everyone when the host ends the room", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    const guest = await connect(r.room.id, `pt_guest=${j.secret}`);
    endRoom(r.room.id, "host-ended");
    expect(await guest.closed).toEqual({ code: 4010 });
    expect(guest.messages.some((m) => m.type === "ended" && m.reason === "host-ended")).toBe(true);
  });

  it("ignores malformed and oversized messages", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const host = await connect(r.room.id, `pt_session=${session.id}`);
    host.ws.send("not json");
    host.ws.send(JSON.stringify({ type: "ready", ready: "yes" }));
    await until(() => (host.messages.filter((m) => m.type === "error").length >= 2 ? true : undefined));
    host.ws.send("x".repeat(10_000));
    expect((await host.closed).code).toBe(1009); // "message too big"
  });
});

describe("playback sync over sockets", () => {
  async function setup() {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "Top Gun", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    const host = await connect(r.room.id, `pt_session=${session.id}`);
    const guest = await connect(r.room.id, `pt_guest=${j.secret}`);
    return { room: r.room, host, guest };
  }
  const lastPlayback = (c: Client) =>
    [...c.messages].reverse().find((m): m is Extract<ServerMessage, { type: "playback" }> => m.type === "playback")
      ?.playback;

  it("lets only the host control playback", async () => {
    const { host, guest } = await setup();
    guest.ws.send(JSON.stringify({ type: "host", action: "pause", positionMs: 5000, latencyMs: 0 }));
    await until(() => guest.messages.find((m) => m.type === "error" && /Only the host/.test(m.message)));
    expect(lastPlayback(host)).toBeUndefined();

    const before = Date.now();
    host.ws.send(JSON.stringify({ type: "host", action: "pause", positionMs: 61_000, latencyMs: 40 }));
    const pb = await until(() => lastPlayback(guest));
    expect(pb).toMatchObject({ status: "paused", positionMs: 61_000 });
    // Back-dated by the host's one-way latency.
    expect(pb.anchorServerTime).toBeLessThanOrEqual(Date.now() - 40);
    expect(pb.anchorServerTime).toBeGreaterThanOrEqual(before - 40);
    host.ws.close();
    guest.ws.close();
  });

  it("schedules Start Together a moment ahead, and ticks never un-pause", async () => {
    const { room, host, guest } = await setup();
    const before = Date.now();
    host.ws.send(JSON.stringify({ type: "start", positionMs: 0 }));
    const pb = await until(() => lastPlayback(guest));
    expect(pb.status).toBe("playing");
    expect(pb.anchorServerTime - before).toBeGreaterThanOrEqual(2000);

    host.ws.send(JSON.stringify({ type: "host", action: "pause", positionMs: 3000, latencyMs: 0 }));
    await until(() => (lastPlayback(guest)?.status === "paused" ? true : undefined));
    host.ws.send(JSON.stringify({ type: "host", action: "tick", positionMs: 9000, latencyMs: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(getRoom(room.id)!.playback).toMatchObject({ status: "paused", positionMs: 3000 });
    host.ws.close();
    guest.ws.close();
  });

  it("shares each guest's drift and player state with the room", async () => {
    const { host, guest } = await setup();
    guest.ws.send(JSON.stringify({ type: "status", playerReady: true, buffering: false, driftMs: 82 }));
    const lexi = await until(() => {
      const p = lastState(host)?.participants.find((x) => x.name === "Lexi");
      return p?.playerReady ? p : undefined;
    });
    expect(lexi).toMatchObject({ playerReady: true, buffering: false });
    // Drift-only changes are coalesced (≤1 broadcast/s).
    await until(() => (lastState(host)?.participants.find((x) => x.name === "Lexi")?.driftMs === 82 ? true : undefined), 3000);
    host.ws.close();
    guest.ws.close();
  });
});
