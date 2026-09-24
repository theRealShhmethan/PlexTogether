/**
 * Plex endpoints, per the official docs at
 * https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex
 * (verified 2026-09-23, PMS API spec v1.2.3).
 */
export const PLEX_CLIENTS_API = "https://clients.plex.tv/api/v2";
export const PLEX_TV_API = "https://plex.tv/api/v2";
export const PLEX_AUTH_APP = "https://app.plex.tv/auth#?";

/** The `aud` claim Plex expects on device-signed JWTs. */
export const PLEX_JWT_AUDIENCE = "plex.tv";

/** Scope claim for the refresh flow (comma separated, per docs). */
export const PLEX_JWT_SCOPE = "username,email,friendly_name";

/** Plex JWTs are documented to expire after 7 days. */
export const PLEX_JWT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
