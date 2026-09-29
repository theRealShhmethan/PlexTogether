import { z } from "zod";
import { plexHeaders, PlexApiError } from "./client";
import { PlexIdSchema } from "./library";
import { pmsGet, type PmsTarget } from "./pms";

/**
 * Audio and subtitle tracks (official PMS spec):
 *   GET /library/metadata/{id}              → Media → Part → Stream (streamType 2 = audio, 3 = subtitles)
 *   PUT /library/parts/{partId}?audioStreamID=&subtitleStreamID=
 *       "Set which streams (audio/subtitle) are selected by this user";
 *       subtitleStreamID=0 turns subtitles off.
 *
 * PLEX NOTE: the selection is saved on the Plex account (as in Plex's own
 * apps), and the transcoder uses it; changing it needs a new session, which
 * the player does by restarting at the current position.
 */

export type Track = {
  id: number;
  label: string;
  language: string | null;
  selected: boolean;
  /** Subtitles only: stored as a separate file rather than inside the video. */
  external?: boolean;
  /** Subtitles only: pictures, not text (PGS, VobSub…) — Plex burns these into the video, so they can't be retimed. */
  image?: boolean;
};

/** Plex's codec names for image-based subtitle formats. */
const IMAGE_SUBTITLE_CODECS = new Set(["pgs", "vobsub", "dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle", "xsub"]);

export type Tracks = { partId: number; audio: Track[]; subtitles: Track[] };

const StreamSchema = z
  .object({
    id: z.number().int(),
    streamType: z.number().int(),
    codec: z.string().optional(),
    language: z.string().optional(),
    languageCode: z.string().optional(),
    displayTitle: z.string().optional(),
    extendedDisplayTitle: z.string().optional(),
    title: z.string().optional(),
    selected: z.boolean().optional(),
    key: z.string().optional(),
  })
  .loose();

const MetadataSchema = z.object({
  MediaContainer: z.object({
    Metadata: z
      .array(
        z
          .object({
            Media: z
              .array(
                z
                  .object({
                    Part: z.array(z.object({ id: z.number().int(), Stream: z.array(z.unknown()).default([]) }).loose()).default([]),
                  })
                  .loose(),
              )
              .default([]),
          })
          .loose(),
      )
      .default([]),
  }),
});

function label(s: z.infer<typeof StreamSchema>): string {
  return s.extendedDisplayTitle || s.displayTitle || s.title || s.language || `Track ${s.id}`;
}

export async function getTracks(target: PmsTarget, ratingKey: string): Promise<Tracks> {
  const id = PlexIdSchema.parse(ratingKey);
  const res = await pmsGet(target, "tracks", `/library/metadata/${id}`, MetadataSchema);
  const part = res.MediaContainer.Metadata[0]?.Media[0]?.Part[0];
  if (!part) throw new PlexApiError("pms:tracks", 200, "This item has no playable file");
  const streams = part.Stream.flatMap((raw) => {
    const s = StreamSchema.safeParse(raw);
    return s.success ? [s.data] : [];
  });
  const toTrack = (s: z.infer<typeof StreamSchema>, sub: boolean): Track => ({
    id: s.id,
    label: label(s),
    language: s.languageCode ?? s.language ?? null,
    selected: s.selected === true,
    ...(sub ? { external: !!s.key, image: IMAGE_SUBTITLE_CODECS.has((s.codec ?? "").toLowerCase()) } : {}),
  });
  return {
    partId: part.id,
    audio: streams.filter((s) => s.streamType === 2).map((s) => toTrack(s, false)),
    subtitles: streams.filter((s) => s.streamType === 3).map((s) => toTrack(s, true)),
  };
}

export type SetTracksResult = { ok: true; tracks: Tracks } | { ok: false; error: string };

/** Selects tracks after checking the ids belong to this item (never trust the browser's ids blindly). */
export async function setTracks(
  target: PmsTarget,
  ratingKey: string,
  choice: { audioStreamId?: number; subtitleStreamId?: number },
): Promise<SetTracksResult> {
  const current = await getTracks(target, ratingKey);
  const params = new URLSearchParams({ allParts: "1" });
  if (choice.audioStreamId !== undefined) {
    if (!current.audio.some((t) => t.id === choice.audioStreamId)) return { ok: false, error: "Unknown audio track" };
    params.set("audioStreamID", String(choice.audioStreamId));
  }
  if (choice.subtitleStreamId !== undefined) {
    if (choice.subtitleStreamId !== 0 && !current.subtitles.some((t) => t.id === choice.subtitleStreamId)) {
      return { ok: false, error: "Unknown subtitle track" };
    }
    params.set("subtitleStreamID", String(choice.subtitleStreamId));
  }
  const url = `${target.baseUrl.replace(/\/+$/, "")}/library/parts/${current.partId}?${params}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: plexHeaders(target.client, target.token),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PlexApiError("pms:set-tracks", null, "Could not reach Plex");
  }
  await res.body?.cancel();
  if (!res.ok) throw new PlexApiError("pms:set-tracks", res.status, `Plex returned HTTP ${res.status}`);
  return { ok: true, tracks: await getTracks(target, ratingKey) };
}

/**
 * Picks the audio track to switch to automatically, or null to leave it.
 * Leaves it alone if the selected track already matches a preferred
 * language; skips commentary tracks. `prefs` are lower-case language codes
 * or names (e.g. "eng", "en", "english"), matched against Plex's languageCode
 * and the track's label.
 */
export function preferredAudio(tracks: Tracks, prefs: string[]): number | null {
  const matches = (t: Track) => {
    const code = (t.language ?? "").toLowerCase();
    const label = t.label.toLowerCase();
    return prefs.some((p) => code === p || label.startsWith(p));
  };
  const selected = tracks.audio.find((t) => t.selected);
  if (selected && matches(selected)) return null;
  const candidate = tracks.audio.find((t) => matches(t) && !/commentary/i.test(t.label));
  return candidate && candidate.id !== selected?.id ? candidate.id : null;
}

// ---------------------------------------------------------------------------
// Finding subtitles online (Plex's subtitle search, as in Plex's own apps).
//
// UNDOCUMENTED: the official PMS spec lists /library/metadata/{id}/subtitles
// only for adding a subtitle you already have. Plex's apps (and
// python-plexapi's searchSubtitles/downloadSubtitles) use it to search:
//   GET /library/metadata/{id}/subtitles?language=en&hearingImpaired=0&forced=0
// and to download a result:
//   PUT /library/metadata/{id}/subtitles?key=<result key>
// The download is asynchronous; the new track appears on the item shortly after.
// See https://support.plex.tv/articles/subtitle-search/. Responses are
// validated loosely; anything unexpected fails with a clear error.
// ---------------------------------------------------------------------------

export type SubtitleResult = {
  title: string;
  language: string | null;
  provider: string | null;
  score: number | null;
  hearingImpaired: boolean;
  forced: boolean;
  perfectMatch: boolean;
};

const SearchResultSchema = z
  .object({
    key: z.string().min(1).max(2048),
    displayTitle: z.string().optional(),
    title: z.string().optional(),
    language: z.string().optional(),
    languageCode: z.string().optional(),
    providerTitle: z.string().optional(),
    score: z.coerce.number().optional(),
    hearingImpaired: z.union([z.boolean(), z.number(), z.string()]).optional(),
    forced: z.union([z.boolean(), z.number(), z.string()]).optional(),
    perfectMatch: z.union([z.boolean(), z.number(), z.string()]).optional(),
  })
  .loose();

const SearchResponseSchema = z.object({
  MediaContainer: z
    .object({ Stream: z.array(z.unknown()).default([]), Metadata: z.array(z.unknown()).default([]) })
    .loose(),
});

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

/** Two-letter language codes offered in the search (ISO 639-1, as Plex expects). */
export const SUBTITLE_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "nl", "sv", "no", "da", "fi", "pl",
  "tr", "ru", "ar", "he", "hi", "ja", "ko", "zh", "vi", "th", "id", "el",
] as const;

/**
 * Searches for subtitles. Returns results for display plus their keys, which
 * the caller keeps server-side (the browser only ever refers to results by index).
 */
export async function searchSubtitles(
  target: PmsTarget,
  ratingKey: string,
  opts: { language: string; hearingImpaired: boolean },
): Promise<{ results: SubtitleResult[]; keys: string[] }> {
  const id = PlexIdSchema.parse(ratingKey);
  const res = await pmsGet(target, "subtitle-search", `/library/metadata/${id}/subtitles`, SearchResponseSchema, {
    // hearingImpaired: 0 = prefer non-SDH, 1 = prefer SDH (python-plexapi's documented values).
    query: { language: opts.language, hearingImpaired: opts.hearingImpaired ? "1" : "0", forced: "0" },
  });
  const raw = [...res.MediaContainer.Stream, ...res.MediaContainer.Metadata];
  const parsed = raw
    .map((r) => SearchResultSchema.safeParse(r))
    .flatMap((r) => (r.success ? [r.data] : []))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 25);
  return {
    keys: parsed.map((r) => r.key),
    results: parsed.map((r) => ({
      title: r.displayTitle || r.title || "Subtitle",
      language: r.languageCode ?? r.language ?? null,
      provider: r.providerTitle ?? null,
      score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null,
      hearingImpaired: truthy(r.hearingImpaired),
      forced: truthy(r.forced),
      perfectMatch: truthy(r.perfectMatch),
    })),
  };
}

export type DownloadResult = { ok: true; tracks: Tracks; newTrackId: number | null } | { ok: false; error: string };

/**
 * Asks Plex to download a search result and attach it to the item, then
 * waits (up to `waitMs`) for the new subtitle track and selects it.
 */
export async function downloadSubtitle(
  target: PmsTarget,
  ratingKey: string,
  resultKey: string,
  waitMs = 20_000,
): Promise<DownloadResult> {
  const id = PlexIdSchema.parse(ratingKey);
  const before = new Set((await getTracks(target, ratingKey)).subtitles.map((t) => t.id));
  const url = `${target.baseUrl.replace(/\/+$/, "")}/library/metadata/${id}/subtitles?${new URLSearchParams({ key: resultKey })}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: plexHeaders(target.client, target.token),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PlexApiError("pms:subtitle-download", null, "Could not reach Plex");
  }
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "Plex didn't allow this account to add subtitles (usually only the server's owner can)." };
  }
  if (!res.ok) throw new PlexApiError("pms:subtitle-download", res.status, `Plex returned HTTP ${res.status}`);

  // The download finishes in the background; poll for the new track.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const tracks = await getTracks(target, ratingKey);
    const added = tracks.subtitles.find((t) => !before.has(t.id));
    if (added) {
      const selected = await setTracks(target, ratingKey, { subtitleStreamId: added.id });
      return { ok: true, tracks: selected.ok ? selected.tracks : tracks, newTrackId: added.id };
    }
  }
  return { ok: true, tracks: await getTracks(target, ratingKey), newTrackId: null };
}
