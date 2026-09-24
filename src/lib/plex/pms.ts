import type { z } from "zod";
import { plexHeaders, plexRequest, type PlexClientInfo } from "./client";

/**
 * A connection to one Plex Media Server: the verified base URL plus the
 * server's access token. SECURITY: server-side only.
 */
export type PmsTarget = {
  client: PlexClientInfo;
  baseUrl: string;
  token: string;
};

export type Page = { start: number; size: number };

/** JSON GET against PMS. `path` must start with "/" and is built by our code, never taken from a browser. */
export async function pmsGet<T>(
  target: PmsTarget,
  label: string,
  path: string,
  schema: z.ZodType<T>,
  opts: { query?: Record<string, string>; page?: Page } = {},
): Promise<T> {
  const url = new URL(target.baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers = plexHeaders(target.client, target.token);
  if (opts.page) {
    // Pagination per the docs: send both headers; the response says what it actually returned.
    headers["X-Plex-Container-Start"] = String(opts.page.start);
    headers["X-Plex-Container-Size"] = String(opts.page.size);
  }
  return plexRequest(`pms:${label}`, url.toString(), { method: "GET", headers }, schema);
}

/** Raw GET (for images). Same headers and redirect policy as pmsGet. */
export async function pmsFetchRaw(target: PmsTarget, path: string, query: Record<string, string>): Promise<Response> {
  const url = new URL(target.baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = plexHeaders(target.client, target.token);
  headers.Accept = "image/*";
  return fetch(url, {
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}
