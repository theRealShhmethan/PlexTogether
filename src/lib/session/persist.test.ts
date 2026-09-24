import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateDeviceKey } from "@/lib/plex/deviceKey";
import {
  decryptSessions,
  encryptSessions,
  loadSessionsFromDisk,
  parseSessionSecret,
  writeSessionsToDisk,
} from "./persist";
import type { HostSession } from "./store";

const key = randomBytes(32);

function legacySession(): HostSession {
  return {
    id: "sess-1",
    clientIdentifier: "cid",
    plex: { mode: "legacy", token: "ACCOUNT-TOKEN-SECRET" },
    user: { id: 1, title: "Elliot" },
    profile: { uuid: "bbb", title: "Ethan", token: "PROFILE-TOKEN-SECRET" },
    servers: [],
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("session persistence", () => {
  it("round-trips sessions, including the active profile, and drops the server cache", () => {
    const [restored] = decryptSessions(encryptSessions([legacySession()], key), key)!;
    expect(restored.profile).toEqual({ uuid: "bbb", title: "Ethan", token: "PROFILE-TOKEN-SECRET" });
    expect(restored.plex).toEqual({ mode: "legacy", token: "ACCOUNT-TOKEN-SECRET" });
    expect(restored.servers).toBeUndefined();
  });

  it("never writes tokens in plaintext", () => {
    const file = encryptSessions([legacySession()], key);
    expect(file).not.toContain("TOKEN-SECRET");
    expect(file).not.toContain("Ethan");
  });

  it("rejects a tampered file or the wrong key", () => {
    const file = JSON.parse(encryptSessions([legacySession()], key));
    const data = Buffer.from(file.data, "base64");
    data[0] ^= 1;
    expect(decryptSessions(JSON.stringify({ ...file, data: data.toString("base64") }), key)).toBeNull();
    expect(decryptSessions(encryptSessions([legacySession()], key), randomBytes(32))).toBeNull();
    expect(decryptSessions("not json", key)).toBeNull();
  });

  it("does not persist JWT sessions (their device key is non-extractable)", async () => {
    const jwt: HostSession = {
      ...legacySession(),
      id: "sess-2",
      plex: { mode: "jwt", token: "t", expiresAt: 0, deviceKey: await generateDeviceKey() },
    };
    const restored = decryptSessions(encryptSessions([legacySession(), jwt], key), key)!;
    expect(restored.map((s) => s.id)).toEqual(["sess-1"]);
  });

  it("writes atomically to disk and reads back; a missing file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-sessions-"));
    dirs.push(dir);
    const cfg = { key, path: join(dir, "nested", "sessions.enc.json") };
    expect(loadSessionsFromDisk(cfg)).toEqual([]);
    writeSessionsToDisk(cfg, [legacySession()]);
    expect(readFileSync(cfg.path, "utf8")).not.toContain("TOKEN-SECRET");
    expect(loadSessionsFromDisk(cfg).map((s) => s.id)).toEqual(["sess-1"]);
  });

  it("validates SESSION_SECRET length", () => {
    expect(parseSessionSecret(randomBytes(32).toString("base64url"))).toHaveLength(32);
    expect(() => parseSessionSecret("too-short")).toThrow(/32 random bytes/);
  });
});
