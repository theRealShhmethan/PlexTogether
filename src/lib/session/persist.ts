import { open, readSealedFile, seal, writeSealedFile } from "@/lib/crypto/sealedFile";
import type { HostSession } from "./store";

/**
 * Optional on-disk persistence for host sessions, so a restart doesn't sign
 * the host out.
 *
 * SECURITY: the file holds Plex tokens (the account token, the active
 * profile's token, the selected server's token), so it is encrypted (see
 * src/lib/crypto/sealedFile.ts). Without SESSION_SECRET, nothing is written
 * and sessions stay in memory only. A tampered file or wrong key means we
 * start empty (everyone signs in again) rather than fail.
 *
 * JWT-mode sessions are not persisted: their device key is a non-extractable
 * CryptoKey by design.
 */

const PURPOSE = "plextogether-sessions-v1";

export { parseSessionSecret } from "@/lib/crypto/sealedFile";

export type PersistConfig = { key: Buffer; path: string };

function persistable(sessions: HostSession[]) {
  return (
    sessions
      .filter((s) => s.plex.mode === "legacy")
      // The server list is a cache (and full of tokens); it's re-fetched on demand.
      .map((s) => ({ ...s, servers: undefined }))
  );
}

function valid(value: unknown): HostSession[] | null {
  return Array.isArray(value) ? (value as HostSession[]).filter((s) => s?.plex?.mode === "legacy") : null;
}

export function encryptSessions(sessions: HostSession[], key: Buffer): string {
  return seal(persistable(sessions), key, PURPOSE);
}

/** Returns the stored sessions, or null if the file can't be authenticated/parsed. */
export function decryptSessions(file: string, key: Buffer): HostSession[] | null {
  return valid(open(file, key, PURPOSE));
}

export function loadSessionsFromDisk(cfg: PersistConfig): HostSession[] {
  const value = readSealedFile(cfg.path, cfg.key, PURPOSE);
  if (value === undefined) return []; // No file yet.
  const sessions = valid(value);
  if (sessions === null) {
    console.warn("[sessions] saved session file could not be decrypted (key changed or file damaged); starting fresh");
    return [];
  }
  return sessions;
}

export function writeSessionsToDisk(cfg: PersistConfig, sessions: HostSession[]): void {
  writeSealedFile(cfg.path, cfg.key, PURPOSE, persistable(sessions), "sessions");
}
