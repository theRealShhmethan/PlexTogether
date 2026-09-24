import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Small encrypted JSON files (AES-256-GCM) for data that must survive a
 * restart but contains secrets: saved sessions and rooms.
 *
 * SECURITY: the key is SESSION_SECRET (32 random bytes from .env.local, never
 * committed). `purpose` is bound in as additional authenticated data, so a
 * sessions file can't be passed off as a rooms file or vice versa. A wrong
 * key, a tampered file or a different purpose all fail authentication; the
 * caller then starts empty rather than trusting the contents.
 */

const FILE_VERSION = 1;

const FileSchema = z.object({
  v: z.literal(FILE_VERSION),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

/** Parses SESSION_SECRET (base64/base64url of 32 bytes). Throws with a helpful message if malformed. */
export function parseSessionSecret(secret: string): Buffer {
  const key = Buffer.from(secret.trim(), "base64url");
  if (key.length !== 32) {
    throw new Error("SESSION_SECRET must be 32 random bytes, base64-encoded (see .env.example for how to generate one)");
  }
  return key;
}

export function seal(value: unknown, key: Buffer, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: FILE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

/** The decrypted value, or null if the file can't be authenticated or parsed. */
export function open(file: string, key: Buffer, purpose: string): unknown {
  try {
    const f = FileSchema.parse(JSON.parse(file));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(f.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(f.data, "base64")), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

/** Reads and decrypts; returns undefined if there's no file, null if it can't be opened. */
export function readSealedFile(path: string, key: Buffer, purpose: string): unknown {
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return open(file, key, purpose);
}

/** Encrypts and writes atomically (temp file + rename). Never throws. */
export function writeSealedFile(path: string, key: Buffer, purpose: string, value: unknown, label: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // mode 0o600 is honoured on macOS/Linux; on Windows the file inherits the folder's ACLs.
    writeFileSync(tmp, seal(value, key, purpose), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // Persistence is a convenience; failing to save must not break requests.
    console.error(`[${label}] could not save: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}
