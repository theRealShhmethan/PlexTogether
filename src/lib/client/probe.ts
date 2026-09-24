/**
 * Picks the Plex server address THIS browser can actually reach.
 *
 * PlexTogether's server checks addresses from where it runs (e.g. on the NAS,
 * next to Plex), but the viewer may be elsewhere — so the browser tests them
 * too. A `no-cors` GET of /identity (no token) resolves if the host answered
 * and rejects on network failure; that's all we need to know.
 *
 * On an HTTPS page only https:// addresses are usable (mixed content), and
 * relay is a last resort (Plex caps its bandwidth).
 */
export type Candidate = { index: number; uri: string; protocol: "http" | "https"; local: boolean; relay: boolean };

const PROBE_TIMEOUT_MS = 4000;

function rank(c: Candidate): number {
  return (c.relay ? 20 : c.local ? 0 : 10) + (c.protocol === "https" ? 0 : 2);
}

async function reachable(c: Candidate): Promise<number | null> {
  const started = performance.now();
  try {
    await fetch(`${c.uri.replace(/\/+$/, "")}/identity`, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return performance.now() - started;
  } catch {
    return null;
  }
}

/** Index of the best reachable candidate, or null if none answered. */
export async function pickConnection(candidates: Candidate[], secureContext: boolean): Promise<number | null> {
  const usable = candidates.filter((c) => !secureContext || c.protocol === "https");
  const results = await Promise.all(usable.map(async (c) => ({ c, ms: await reachable(c) })));
  const ok = results.filter((r): r is { c: Candidate; ms: number } => r.ms !== null);
  ok.sort((a, b) => rank(a.c) - rank(b.c) || a.ms - b.ms);
  return ok[0]?.c.index ?? null;
}
