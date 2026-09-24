import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { _resetStores, saveSession, type HostSession } from "@/lib/session/store";
import {
  _resetRooms,
  configureRoomPersistence,
  createRoom,
  endRoom,
  flushRooms,
  getRoom,
  joinRoom,
  leaveRoom,
  resolveGuest,
} from "./hub";
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
    return { room: r.room, host, guest, guestId: j.participant.id };
  }
  const lastPlayback = (c: Client) =>
    [...c.messages].reverse().find((m): m is Extract<ServerMessage, { type: "playback" }> => m.type === "playback")
      ?.playback;
  const control = (c: Client, action: string, positionMs: number, latencyMs = 0) =>
    c.ws.send(JSON.stringify({ type: "control", action, positionMs, latencyMs }));

  it("records who acted, back-dated by their latency", async () => {
    const { room, host, guest } = await setup();
    const before = Date.now();
    control(host, "pause", 61_000, 40);
    const pb = await until(() => lastPlayback(guest));
    expect(pb).toMatchObject({ status: "paused", positionMs: 61_000, by: room.hostParticipantId, seq: 1 });
    expect(pb.anchorServerTime).toBeLessThanOrEqual(Date.now() - 40);
    expect(pb.anchorServerTime).toBeGreaterThanOrEqual(before - 40);
    host.ws.close();
    guest.ws.close();
  });

  it("lets guests pause and skip by default, and the host can lock them out", async () => {
    const { room, host, guest, guestId } = await setup();
    control(guest, "seek", 90_000);
    await until(() => (lastPlayback(host)?.by === guestId ? true : undefined));

    // A guest can't change permissions…
    guest.ws.send(JSON.stringify({ type: "permissions", participantId: guestId, playPause: true, seek: true }));
    await until(() => guest.messages.find((m) => m.type === "error" && /Only the host/.test(m.message)));

    // …the host can.
    host.ws.send(JSON.stringify({ type: "permissions", participantId: guestId, playPause: true, seek: false }));
    await until(() => (lastState(guest)?.participants.find((p) => p.id === guestId)?.permissions.seek === false ? true : undefined));
    control(guest, "seek", 10_000);
    await until(() => guest.messages.find((m) => m.type === "error" && /hasn't allowed/.test(m.message)));
    expect(getRoom(room.id)!.playback.positionMs).toBe(90_000);
    control(guest, "pause", 95_000); // still allowed
    await until(() => (lastPlayback(host)?.positionMs === 95_000 ? true : undefined));

    // "*" applies to every guest.
    host.ws.send(JSON.stringify({ type: "permissions", participantId: "*", playPause: false, seek: false }));
    await until(() => (lastState(host)?.participants.find((p) => p.id === guestId)?.permissions.playPause === false ? true : undefined));
    host.ws.close();
    guest.ws.close();
  });

  it("schedules Start Together a moment ahead for everyone (host only)", async () => {
    const { host, guest } = await setup();
    guest.ws.send(JSON.stringify({ type: "start", positionMs: 0 }));
    await until(() => guest.messages.find((m) => m.type === "error" && /Only the host can start/.test(m.message)));

    const before = Date.now();
    host.ws.send(JSON.stringify({ type: "start", positionMs: 0 }));
    const pb = await until(() => lastPlayback(guest));
    expect(pb).toMatchObject({ status: "playing", by: null });
    expect(pb.anchorServerTime - before).toBeGreaterThanOrEqual(2000);
    host.ws.close();
    guest.ws.close();
  });

  it("only takes ticks from whoever sets the pace, and ticks never un-pause", async () => {
    const { room, host, guest } = await setup();
    control(host, "play", 1000);
    await until(() => (lastPlayback(guest)?.status === "playing" ? true : undefined));
    control(guest, "tick", 50_000); // not the reference player → ignored
    control(host, "tick", 4000);
    await until(() => (lastPlayback(guest)?.positionMs === 4000 ? true : undefined));
    expect(getRoom(room.id)!.playback.positionMs).toBe(4000);

    control(host, "pause", 5000);
    await until(() => (lastPlayback(guest)?.status === "paused" ? true : undefined));
    control(host, "tick", 9000);
    await new Promise((r) => setTimeout(r, 100));
    expect(getRoom(room.id)!.playback).toMatchObject({ status: "paused", positionMs: 5000 });
    host.ws.close();
    guest.ws.close();
  });

  it("shares each guest's drift and player state with the room", async () => {
    const { host, guest } = await setup();
    guest.ws.send(JSON.stringify({ type: "status", playerReady: true, buffering: false, driftMs: 82, positionMs: 1000 }));
    const lexi = await until(() => {
      const p = lastState(host)?.participants.find((x) => x.name === "Lexi");
      return p?.playerReady ? p : undefined;
    });
    expect(lexi).toMatchObject({ playerReady: true, buffering: false });
    await until(() => (lastState(host)?.participants.find((x) => x.name === "Lexi")?.driftMs === 82 ? true : undefined), 3000);
    host.ws.close();
    guest.ws.close();
  });
});

describe("buffering pauses the room and resumes together", () => {
  async function playingRoom() {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    const host = await connect(r.room.id, `pt_session=${session.id}`);
    const guest = await connect(r.room.id, `pt_guest=${j.secret}`);
    host.ws.send(JSON.stringify({ type: "control", action: "play", positionMs: 60_000, latencyMs: 0 }));
    await until(() => (getRoom(r.room.id)?.playback.status === "playing" ? true : undefined));
    return { room: r.room, host, guest };
  }
  const status = (c: Client, buffering: boolean, positionMs: number) =>
    c.ws.send(JSON.stringify({ type: "status", playerReady: true, buffering, driftMs: 0, positionMs }));

  it("ignores short hiccups", async () => {
    const { room, host, guest } = await playingRoom();
    status(guest, true, 61_000);
    await new Promise((r) => setTimeout(r, 300));
    status(guest, false, 61_300);
    await new Promise((r) => setTimeout(r, 1600));
    expect(getRoom(room.id)!.playback.status).toBe("playing");
    host.ws.close();
    guest.ws.close();
  });

  it("pauses everyone at the stalled player's position, then resumes together", async () => {
    const { room, host, guest } = await playingRoom();
    status(guest, true, 61_000);
    const paused = await until(() => (getRoom(room.id)?.playback.status === "paused" ? getRoom(room.id)!.playback : undefined), 3000);
    expect(paused).toMatchObject({ positionMs: 61_000, by: null });
    expect(await until(() => lastState(host)?.waitingFor.length ? lastState(host)!.waitingFor : undefined)).toEqual(["Lexi"]);

    const before = Date.now();
    status(guest, false, 61_000);
    const resumed = await until(() => (getRoom(room.id)?.playback.status === "playing" ? getRoom(room.id)!.playback : undefined));
    expect(resumed.positionMs).toBe(61_000);
    expect(resumed.anchorServerTime - before).toBeGreaterThanOrEqual(1000); // scheduled a moment ahead
    expect(getRoom(room.id)!.waitingFor.size).toBe(0);
    host.ws.close();
    guest.ws.close();
  });

  it("a deliberate play overrides the wait", async () => {
    const { room, host, guest } = await playingRoom();
    status(guest, true, 61_000);
    await until(() => (getRoom(room.id)?.playback.status === "paused" ? true : undefined), 3000);
    host.ws.send(JSON.stringify({ type: "control", action: "play", positionMs: 61_000, latencyMs: 0 }));
    await until(() => (getRoom(room.id)?.waitingFor.size === 0 ? true : undefined));
    expect(getRoom(room.id)!.playback.by).toBe(room.hostParticipantId);
    host.ws.close();
    guest.ws.close();
  });
});

describe("recovery", () => {
  it("stops waiting for someone whose connection is gone", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    const host = await connect(r.room.id, `pt_session=${session.id}`);
    const guest = await connect(r.room.id, `pt_guest=${j.secret}`);
    host.ws.send(JSON.stringify({ type: "control", action: "play", positionMs: 1000, latencyMs: 0 }));
    await until(() => (getRoom(r.room.id)?.playback.status === "playing" ? true : undefined));
    guest.ws.send(JSON.stringify({ type: "status", playerReady: true, buffering: true, driftMs: 0, positionMs: 2000 }));
    await until(() => (getRoom(r.room.id)?.waitingFor.size ? true : undefined), 3000);

    guest.ws.close();
    const resumed = await until(() =>
      getRoom(r.room.id)?.playback.status === "playing" ? getRoom(r.room.id)!.playback : undefined,
    );
    expect(resumed.positionMs).toBe(2000);
    expect(getRoom(r.room.id)!.waitingFor.size).toBe(0);
    host.ws.close();
  });
});

describe("room persistence", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tempCfg() {
    const dir = mkdtempSync(join(tmpdir(), "pt-rooms-"));
    dirs.push(dir);
    return { key: randomBytes(32), path: join(dir, "rooms.enc.json") };
  }

  it("restores rooms and guest seats after a restart, paused where they were", () => {
    const cfg = tempCfg();
    configureRoomPersistence(cfg);
    const r = createRoom({ hostSessionId: "host-sess-SECRET", hostName: "Ethan", title: "Top Gun", item });
    if (!r.ok) throw new Error();
    const j = joinRoom(r.room.id, "Lexi");
    if (!j.ok) throw new Error();
    const room = getRoom(r.room.id)!;
    room.playback = { status: "playing", positionMs: 60_000, anchorServerTime: Date.now() - 5000, by: null, seq: 3 };
    flushRooms();

    const file = readFileSync(cfg.path, "utf8");
    expect(file).not.toContain("host-sess-SECRET");
    expect(file).not.toContain(j.secret);
    expect(file).not.toContain("Lexi");

    _resetRooms(); // "restart"
    expect(configureRoomPersistence(cfg)).toBe(1);
    const back = getRoom(r.room.id)!;
    expect(back.hostSessionId).toBe("host-sess-SECRET");
    expect(back.playback.status).toBe("paused");
    expect(back.playback.positionMs).toBeGreaterThanOrEqual(64_900);
    expect(back.playback.positionMs).toBeLessThan(66_000);
    expect(resolveGuest(j.secret)?.participant.name).toBe("Lexi");
    expect(back.participants.get(j.participant.id)).toMatchObject({ playerReady: false, buffering: false });
  });

  it("drops expired rooms and ignores a file it can't decrypt", () => {
    const cfg = tempCfg();
    configureRoomPersistence(cfg);
    const r = createRoom({ hostSessionId: "h", hostName: "Ethan", title: "T", item });
    if (!r.ok) throw new Error();
    getRoom(r.room.id)!.expiresAt = Date.now() + 50;
    flushRooms();
    _resetRooms();
    expect(configureRoomPersistence({ ...cfg, key: randomBytes(32) })).toBe(0);
    _resetRooms();
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(configureRoomPersistence(cfg)).toBe(0);
        done();
      }, 80),
    );
  });
});

describe("resume point", () => {
  it("starts the room where the host left off, and choosing a start keeps it waiting", async () => {
    const session = hostSession();
    const r = createRoom({ hostSessionId: session.id, hostName: "Ethan", title: "T", item: { ...item, resumeMs: 2_712_000 } });
    if (!r.ok) throw new Error();
    expect(getRoom(r.room.id)!.playback).toMatchObject({ status: "idle", positionMs: 2_712_000 });

    const host = await connect(r.room.id, `pt_session=${session.id}`);
    expect((await until(() => lastState(host)))!.resumeMs).toBe(2_712_000);

    // "From the beginning" before starting: still idle, now at 0.
    host.ws.send(JSON.stringify({ type: "control", action: "seek", positionMs: 0, latencyMs: 0 }));
    await until(() => (getRoom(r.room.id)?.playback.positionMs === 0 ? true : undefined));
    expect(getRoom(r.room.id)!.playback.status).toBe("idle");

    host.ws.send(JSON.stringify({ type: "start", positionMs: 0 }));
    await until(() => (getRoom(r.room.id)?.playback.status === "playing" ? true : undefined));
    host.ws.close();
  });
});
