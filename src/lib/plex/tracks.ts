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
};

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
    ...(sub ? { external: !!s.key } : {}),
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
