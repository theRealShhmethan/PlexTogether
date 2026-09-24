import { z } from "zod";

export type PlexClientInfo = {
  clientIdentifier: string;
  product: string;
  version: string;
};

/**
 * Error from a Plex HTTP call. Deliberately carries only the endpoint label
 * and status — never request headers or query strings, which may contain
 * tokens or device JWTs.
 */
export class PlexApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PlexApiError";
  }
}

/** Standard X-Plex-* identification headers. */
export function plexHeaders(client: PlexClientInfo, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Product": client.product,
    "X-Plex-Version": client.version,
    "X-Plex-Client-Identifier": client.clientIdentifier,
    "X-Plex-Platform": "Web",
    "X-Plex-Device-Name": `${client.product} (host)`,
  };
  // SECURITY: tokens are only ever sent as a header on server-to-plex.tv
  // requests, never as a query parameter (which can end up in logs).
  if (token) headers["X-Plex-Token"] = token;
  return headers;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * fetch + timeout + status check + schema validation. Throws PlexApiError on
 * network failure, non-2xx status, or a response that doesn't match `schema`.
 */
export async function plexRequest<T>(
  endpoint: string,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
    throw new PlexApiError(endpoint, null, `Could not reach Plex (${reason})`);
  }
  if (!res.ok) {
    throw new PlexApiError(endpoint, res.status, `Plex returned HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PlexApiError(endpoint, res.status, "Plex returned a non-JSON response");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PlexApiError(endpoint, res.status, "Plex returned an unexpected response shape");
  }
  return parsed.data;
}
