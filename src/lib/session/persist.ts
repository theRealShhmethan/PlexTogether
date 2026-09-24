import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { HostSession } from "./store";

/**
 * Optional on-disk persistence for host sessions, so a restart doesn't sign
 * the host out.
 *
 * SECURITY: the file holds Plex tokens (the account token, the active
 * profile's token, the selected server's token), so it is encrypted with
 * AES-256-GCM using SESSION_SECRET (32 random bytes, from .env.local — never
 * committed). Without SESSION_SECRET, nothing is written and sessions stay
 * in memory only. Tampering or a wrong key makes the file unreadable, in
 * which case we start empty (everyone signs in again) rather than fail.
 *
 * JWT-mode sessions are not persisted: their device key is a non-extractable
 * CryptoKey by design.
 */

const FILE_VERSION = 1;
const AAD = Buffer.from("plextogether-sessions-v1");

const FileSchema = z.object({
  v: z.literal(FILE_VERSION),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export type PersistConfig = { key: Buffer; path: string };

/** Parses SESSION_SECRET (base64/base64url of 32 bytes). Throws with a helpful message if malformed. */
export function parseSessionSecret(secret: string): Buffer {
  const key = Buffer.from(secret.trim(), "base64url");
  if (key.length !== 32) {
    throw new Error("SESSION_SECRET must be 32 random bytes, base64-encoded (see .env.example for how to generate one)");
  }
  return key;
}

export function encryptSessions(sessions: HostSession[], key: Buffer): string {
  const persistable = sessions
    .filter((s) => s.plex.mode === "legacy")
    // The server list is a cache (and full of tokens); it's re-fetched on demand.
    .map((s) => ({ ...s, servers: undefined }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(persistable), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: FILE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

/** Returns the stored sessions, or null if the file can't be authenticated/parsed. */
export function decryptSessions(file: string, key: Buffer): HostSession[] | null {
  try {
    const f = FileSchema.parse(JSON.parse(file));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(f.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(f.data, "base64")), decipher.final()]).toString("utf8");
    const sessions = JSON.parse(plain) as HostSession[];
    return Array.isArray(sessions) ? sessions.filter((s) => s?.plex?.mode === "legacy") : null;
  } catch {
    return null;
  }
}

export function loadSessionsFromDisk(cfg: PersistConfig): HostSession[] {
  let file: string;
  try {
    file = readFileSync(cfg.path, "utf8");
  } catch {
    return []; // No file yet.
  }
  const sessions = decryptSessions(file, cfg.key);
  if (sessions === null) {
    console.warn("[sessions] saved session file could not be decrypted (key changed or file damaged); starting fresh");
    return [];
  }
  return sessions;
}

export function writeSessionsToDisk(cfg: PersistConfig, sessions: HostSession[]): void {
  try {
    mkdirSync(dirname(cfg.path), { recursive: true });
    const tmp = `${cfg.path}.tmp`;
    // mode 0o600 is honoured on macOS/Linux; on Windows the file inherits the folder's ACLs.
    writeFileSync(tmp, encryptSessions(sessions, cfg.key), { mode: 0o600 });
    renameSync(tmp, cfg.path);
  } catch (err) {
    // Persistence is a convenience; failing to save must not break requests.
    console.error(`[sessions] could not save sessions: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}
