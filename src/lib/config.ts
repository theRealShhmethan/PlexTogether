import "server-only";
import { z } from "zod";
import type { PlexAuthMode } from "@/lib/plex/auth";
import { parseSessionSecret } from "@/lib/session/persist";

/**
 * Server-side configuration, read from environment variables.
 * See `.env.example`. Nothing in here is exposed to the browser
 * (no NEXT_PUBLIC_ prefix), and none of it is a secret today.
 */
const EnvSchema = z.object({
  // Public origin of this app, e.g. http://localhost:3000.
  // Used for the Plex forwardUrl and for same-origin checks on POST routes.
  APP_URL: z.url().default("http://localhost:3000"),
  // Shown in the user's plex.tv "Authorized Devices" list.
  PLEX_PRODUCT_NAME: z.string().min(1).max(64).default("PlexTogether"),
  // "legacy" (default) or "jwt". JWT is Plex's recommended flow, but Plex Media
  // Server currently rejects JWTs — see src/lib/plex/auth.ts.
  PLEX_AUTH_MODE: z.enum(["legacy", "jwt"]).default("legacy"),
  // 32 random bytes (base64). When set, sessions are saved encrypted to
  // SESSION_STORE_PATH so a restart doesn't sign you out. SECRET — .env.local only.
  SESSION_SECRET: z.string().min(1).optional(),
  SESSION_STORE_PATH: z.string().min(1).default(".data/sessions.enc.json"),
  // Audio language chosen automatically the first time a title is played
  // (comma-separated codes/names, matched case-insensitively). Manual choices always win.
  PREFERRED_AUDIO_LANGUAGES: z.string().default("eng,en,english"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type AppConfig = {
  appOrigin: string;
  productName: string;
  productVersion: string;
  authMode: PlexAuthMode;
  preferredAudio: string[];
  /** null → sessions are memory-only. */
  sessionPersist: { key: Buffer; path: string } | null;
  isProduction: boolean;
};

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const env = EnvSchema.parse(process.env);
  const url = new URL(env.APP_URL);
  cached = {
    appOrigin: url.origin,
    productName: env.PLEX_PRODUCT_NAME,
    productVersion: "0.1.0",
    authMode: env.PLEX_AUTH_MODE,
    preferredAudio: env.PREFERRED_AUDIO_LANGUAGES.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    sessionPersist: env.SESSION_SECRET
      ? { key: parseSessionSecret(env.SESSION_SECRET), path: env.SESSION_STORE_PATH }
      : null,
    isProduction: env.NODE_ENV === "production",
  };
  return cached;
}
