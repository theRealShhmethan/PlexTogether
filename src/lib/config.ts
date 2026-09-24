import "server-only";
import { z } from "zod";
import type { PlexAuthMode } from "@/lib/plex/auth";

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
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type AppConfig = {
  appOrigin: string;
  productName: string;
  productVersion: string;
  authMode: PlexAuthMode;
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
    isProduction: env.NODE_ENV === "production",
  };
  return cached;
}
