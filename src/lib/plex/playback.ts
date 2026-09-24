import { randomUUID } from "node:crypto";
import { z } from "zod";
import { plexHeaders, plexRequest, PlexApiError } from "./client";
import { PlexIdSchema } from "./library";
import type { PmsTarget } from "./pms";

/**
 * Browser playback via Plex's universal transcoder (official PMS spec,
 * https://developer.plex.tv/pms/):
 *
 *   GET  /video/:/transcode/universal/decision   → what Plex will do per stream
 *   GET  /video/:/transcode/universal/start.m3u8 → HLS playlist (same params)
 *   POST /:/timeline                             → progress, every ~10 s + on state change
 *   POST /security/token                         → short-lived token for the browser
 *
 * We always ask for HLS with direct stream allowed: compatible video/audio
 * is copied (cheap remux), anything else is transcoded to H.264/AAC, which
 * every target browser plays through hls.js / MSE. True direct play of the
 * original file is left for later (most libraries are MKV, which browsers
 * can't play directly anyway).
 */

/** H.264 + AAC in MPEG-TS over HLS: the lowest common denominator for Chrome/Edge/Safari via MSE. */
const PROFILE_EXTRA = [
  "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac&replace=true)",
].join("+");

export type PlaybackOptions = {
  ratingKey: string;
  /** "lan" lets Plex copy/transcode at full quality; "wan" caps bitrate. */
  location: "lan" | "wan";
  /**
   * Where the transcode starts (ms into the media). PLEX NOTE: the transcoder
   * produces the stream in order from this point, so jumping far ahead inside
   * a session stalls until it catches up. Plex clients start a new session
   * with `offset` instead, and so do we.
   */
  offsetMs?: number;
  quality?: Quality;
};

/** Validates an offset from a browser: 0 to 24 h, in ms. */
export function parseOffsetMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(0, value), 86_400_000) : 0;
}

export type StreamDecision = {
  kind: "video" | "audio" | "subtitle";
  codec: string | null;
  decision: string | null;
  language: string | null;
};

export type PlaybackDecision = {
  /** Plex's overall verdict: 1xxx means playback can succeed. */
  code: number | null;
  text: string | null;
  /** "directplay" | "transcode" | ... (per part, from Plex). */
  partDecision: string | null;
  /** Plex's own explanations (e.g. why it transcodes), de-duplicated. */
  reasons: string[];
  container: string | null;
  videoResolution: string | null;
  streams: StreamDecision[];
};

export type PlaybackStart = {
  sessionId: string;
  /** HLS playlist on PMS. Needs the transient token appended by the player. */
  playlistUrl: string;
  /** Short-lived (≤48 h, dies on PMS restart) token for the browser's media requests. */
  transientToken: string;
  decision: PlaybackDecision;
};

const StreamSchema = z
  .object({
    streamType: z.number().int().optional(),
    codec: z.string().optional(),
    decision: z.string().optional(),
    language: z.string().optional(),
    languageCode: z.string().optional(),
  })
  .loose();

const DecisionSchema = z.object({
  MediaContainer: z
    .object({
      generalDecisionCode: z.number().int().optional(),
      generalDecisionText: z.string().optional(),
      directPlayDecisionText: z.string().optional(),
      transcodeDecisionText: z.string().optional(),
      Metadata: z
        .array(
          z
            .object({
              Media: z
                .array(
                  z
                    .object({
                      container: z.string().optional(),
                      videoResolution: z.string().optional(),
                      Part: z
                        .array(z.object({ decision: z.string().optional(), Stream: z.array(StreamSchema).default([]) }).loose())
                        .default([]),
                    })
                    .loose(),
                )
                .default([]),
            })
            .loose(),
        )
        .default([]),
    })
    .loose(),
});

const TransientTokenSchema = z.object({ MediaContainer: z.object({ token: z.string().min(1) }).loose() });

const STREAM_KINDS: Record<number, StreamDecision["kind"]> = { 1: "video", 2: "audio", 3: "subtitle" };

/** Query parameters shared by decision and start — they must match for Plex to reuse the decision. */
export function transcodeParams(opts: PlaybackOptions, sessionId: string): Record<string, string> {
  const ratingKey = PlexIdSchema.parse(opts.ratingKey);
  const params: Record<string, string> = {
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "hls",
    // Direct play of the original file isn't used (see file comment); copy streams when possible.
    directPlay: "0",
    directStream: "1",
    directStreamAudio: "1",
    // Burn in the profile's selected subtitle, if any; simplest cross-browser option for now.
    subtitles: "burn",
    location: opts.location,
    transcodeSessionId: sessionId,
    session: sessionId,
  };
  // Documented: "Offset from the start of the media (in seconds)".
  if (opts.offsetMs && opts.offsetMs > 0) params.offset = (Math.floor(opts.offsetMs / 100) / 10).toFixed(1);
  const cap = QUALITY_CAPS[opts.quality === "auto" || !opts.quality ? (opts.location === "wan" ? "1080" : "original") : opts.quality];
  if (cap) {
    params.videoBitrate = String(cap.videoKbps);
    params.peakBitrate = String(cap.peakKbps);
    params.videoResolution = cap.resolution;
  }
  return params;
}

/**
 * Per-viewer quality. "auto" = full quality on a local connection, 1080p/8 Mbps
 * remotely. A cap below the source's bitrate/resolution makes Plex transcode.
 */
export const QUALITIES = ["auto", "original", "1080", "720", "480"] as const;
export type Quality = (typeof QUALITIES)[number];

const QUALITY_CAPS: Record<Exclude<Quality, "auto">, { videoKbps: number; peakKbps: number; resolution: string } | null> = {
  original: null,
  "1080": { videoKbps: 8000, peakKbps: 12000, resolution: "1920x1080" },
  "720": { videoKbps: 4000, peakKbps: 6000, resolution: "1280x720" },
  "480": { videoKbps: 1500, peakKbps: 2500, resolution: "854x480" },
};

function transcodeHeaders(target: PmsTarget, sessionId: string): Record<string, string> {
  return {
    ...plexHeaders(target.client, target.token),
    // Documented: "Generally should only be used to specify the Generic profile."
    "X-Plex-Client-Profile-Name": "Generic",
    "X-Plex-Client-Profile-Extra": PROFILE_EXTRA,
    "X-Plex-Session-Identifier": sessionId,
  };
}

function pmsUrl(target: PmsTarget, path: string, params: Record<string, string>): string {
  const url = new URL(target.baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function summarizeDecision(raw: z.infer<typeof DecisionSchema>): PlaybackDecision {
  const mc = raw.MediaContainer;
  const media = mc.Metadata[0]?.Media[0];
  const part = media?.Part[0];
  return {
    code: mc.generalDecisionCode ?? null,
    text: mc.generalDecisionText ?? null,
    partDecision: part?.decision ?? null,
    reasons: [...new Set([mc.transcodeDecisionText, mc.directPlayDecisionText].filter((t): t is string => !!t))],
    container: media?.container ?? null,
    videoResolution: media?.videoResolution ?? null,
    streams: (part?.Stream ?? [])
      .filter((s) => s.streamType !== undefined && STREAM_KINDS[s.streamType])
      .map((s) => ({
        kind: STREAM_KINDS[s.streamType!],
        codec: s.codec ?? null,
        decision: s.decision ?? null,
        language: s.language ?? s.languageCode ?? null,
      })),
  };
}

/**
 * SECURITY: the transient token has the same access as `target.token` but
 * expires on its own (≤48 h, or when PMS restarts), so it — never the
 * long-lived server token — is what the host's browser gets for media URLs.
 */
export async function createTransientToken(target: PmsTarget): Promise<string> {
  const res = await plexRequest(
    "pms:transient-token",
    pmsUrl(target, "/security/token", { type: "delegation", scope: "all" }),
    { method: "POST", headers: plexHeaders(target.client, target.token) },
    TransientTokenSchema,
  );
  return res.MediaContainer.token;
}

/**
 * @param playlistBaseUrl where the BROWSER will fetch the stream from — it may
 * differ from target.baseUrl (the address that works from this server), e.g.
 * when PlexTogether runs next to PMS but the viewer is elsewhere.
 */
export async function startPlayback(
  target: PmsTarget,
  opts: PlaybackOptions,
  playlistBaseUrl: string = target.baseUrl,
): Promise<PlaybackStart> {
  const sessionId = randomUUID();
  const params = transcodeParams(opts, sessionId);

  const raw = await plexRequest(
    "pms:decision",
    pmsUrl(target, "/video/:/transcode/universal/decision", params),
    { method: "GET", headers: transcodeHeaders(target, sessionId) },
    DecisionSchema,
  );
  const decision = summarizeDecision(raw);
  // 1xxx = playback can succeed; anything else is an error Plex explains in `text`.
  if (decision.code !== null && (decision.code < 1000 || decision.code >= 2000)) {
    throw new PlexApiError("pms:decision", 200, `Plex can't play this item: ${decision.text ?? `code ${decision.code}`}`);
  }

  const transientToken = await createTransientToken(target);
  // The playlist URL carries no token; the player adds the transient one to each request.
  const playlistUrl = pmsUrl({ ...target, baseUrl: playlistBaseUrl }, "/video/:/transcode/universal/start.m3u8", {
    ...params,
    "X-Plex-Client-Identifier": target.client.clientIdentifier,
    "X-Plex-Product": target.client.product,
    "X-Plex-Platform": "Web",
    "X-Plex-Client-Profile-Name": "Generic",
    "X-Plex-Client-Profile-Extra": PROFILE_EXTRA,
    "X-Plex-Session-Identifier": sessionId,
  });
  return { sessionId, playlistUrl, transientToken, decision };
}

export type TimelineState = "playing" | "paused" | "buffering" | "stopped";

/** Reports progress to PMS (updates resume position / Continue Watching, keeps the session alive). */
export async function reportTimeline(
  target: PmsTarget,
  sessionId: string,
  ratingKey: string,
  state: TimelineState,
  timeMs: number,
  durationMs: number | null,
): Promise<void> {
  const id = PlexIdSchema.parse(ratingKey);
  const params: Record<string, string> = {
    ratingKey: id,
    key: `/library/metadata/${id}`,
    state,
    time: String(Math.max(0, Math.round(timeMs))),
  };
  if (durationMs !== null) params.duration = String(Math.round(durationMs));
  const res = await fetch(pmsUrl(target, "/:/timeline", params), {
    method: "POST",
    headers: { ...plexHeaders(target.client, target.token), "X-Plex-Session-Identifier": sessionId },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) throw new PlexApiError("pms:timeline", null, "Could not reach Plex");
  await res.body?.cancel();
  if (!res.ok) throw new PlexApiError("pms:timeline", res.status, `Plex returned HTTP ${res.status}`);
}
