import { z } from "zod";
import { pmsGet, type Page, type PmsTarget } from "./pms";

/**
 * Library browsing, using endpoints from the official PMS API spec
 * (https://developer.plex.tv/pms/): /library/sections/all,
 * /library/sections/{id}/all, /library/metadata/{id},
 * /library/metadata/{id}/allLeaves and /hubs/search.
 *
 * Only movie and TV libraries are exposed; music/photo are out of scope.
 */

/** Plex ids (section keys, ratingKeys) are numeric strings. Validate before putting them in a path. */
export const PlexIdSchema = z.string().regex(/^\d{1,12}$/);

/**
 * Plex image paths look like /library/metadata/123/thumb/1699999999. Only
 * these are proxied — never arbitrary paths or external URLs.
 */
export const ImagePathSchema = z.string().regex(/^\/library\/metadata\/\d{1,12}\/(thumb|art|banner)\/\d{1,14}$/);

const MediaSchema = z.object({ id: z.union([z.number(), z.string()]).optional() }).loose();

const MetadataSchema = z.object({
  ratingKey: z.string(),
  type: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  summary: z.string().optional(),
  duration: z.number().optional(),
  thumb: z.string().optional(),
  art: z.string().optional(),
  contentRating: z.string().optional(),
  index: z.number().int().optional(),
  parentIndex: z.number().int().optional(),
  parentTitle: z.string().optional(),
  grandparentTitle: z.string().optional(),
  grandparentThumb: z.string().optional(),
  grandparentRatingKey: z.string().optional(),
  leafCount: z.number().int().optional(),
  Media: z.array(MediaSchema).optional(),
});
type RawMetadata = z.infer<typeof MetadataSchema>;

const MetadataContainerSchema = z.object({
  MediaContainer: z.object({
    size: z.number().int().optional(),
    totalSize: z.number().int().optional(),
    offset: z.number().int().optional(),
    Metadata: z.array(z.unknown()).default([]),
  }),
});

const SectionsSchema = z.object({
  MediaContainer: z.object({
    Directory: z
      .array(z.object({ key: z.string(), title: z.string(), type: z.string() }).loose())
      .default([]),
  }),
});

const SearchSchema = z.object({
  MediaContainer: z.object({
    Hub: z.array(z.object({ type: z.string(), Metadata: z.array(z.unknown()).default([]) }).loose()).default([]),
  }),
});

// ---------- public shapes (safe for the browser) ----------

export type LibrarySection = { id: string; title: string; type: "movie" | "show" };

export type LibraryItem = {
  ratingKey: string;
  type: "movie" | "show" | "episode";
  title: string;
  year: number | null;
  summary: string | null;
  durationMs: number | null;
  contentRating: string | null;
  /** Same-origin proxy URL, or null. */
  poster: string | null;
  showTitle: string | null;
  showRatingKey: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeCount: number | null;
  /** Movies/episodes with at least one media version. */
  playable: boolean;
};

export type ItemPage = { items: LibraryItem[]; start: number; total: number | null };

export function imageProxyUrl(path: string | undefined, width: number, height: number): string | null {
  if (!path || !ImagePathSchema.safeParse(path).success) return null;
  return `/api/plex/image?${new URLSearchParams({ path, w: String(width), h: String(height) })}`;
}

/** Parses Metadata entries one by one, dropping unsupported types and malformed entries. */
function toItems(raw: unknown[]): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const entry of raw) {
    const parsed = MetadataSchema.safeParse(entry);
    if (parsed.success) {
      const item = toItem(parsed.data);
      if (item) items.push(item);
    }
  }
  return items;
}

function toItem(m: RawMetadata): LibraryItem | null {
  if (m.type !== "movie" && m.type !== "show" && m.type !== "episode") return null;
  const isEpisode = m.type === "episode";
  return {
    ratingKey: m.ratingKey,
    type: m.type,
    title: m.title,
    year: m.year ?? null,
    summary: m.summary || null,
    durationMs: m.duration ?? null,
    contentRating: m.contentRating ?? null,
    poster: isEpisode
      ? imageProxyUrl(m.thumb, 400, 225) ?? imageProxyUrl(m.grandparentThumb, 300, 450)
      : imageProxyUrl(m.thumb, 300, 450),
    showTitle: isEpisode ? (m.grandparentTitle ?? null) : null,
    showRatingKey: isEpisode ? (m.grandparentRatingKey ?? null) : null,
    seasonNumber: isEpisode ? (m.parentIndex ?? null) : null,
    episodeNumber: isEpisode ? (m.index ?? null) : null,
    episodeCount: m.type === "show" ? (m.leafCount ?? null) : null,
    playable: m.type !== "show" && (m.Media?.length ?? 0) > 0,
  };
}

// ---------- queries ----------

export async function listSections(target: PmsTarget): Promise<LibrarySection[]> {
  const res = await pmsGet(target, "sections", "/library/sections/all", SectionsSchema);
  return res.MediaContainer.Directory.filter((d) => d.type === "movie" || d.type === "show").map((d) => ({
    id: d.key,
    title: d.title,
    type: d.type as "movie" | "show",
  }));
}

export async function listSectionItems(target: PmsTarget, sectionId: string, page: Page): Promise<ItemPage> {
  const id = PlexIdSchema.parse(sectionId);
  const res = await pmsGet(target, "section-items", `/library/sections/${id}/all`, MetadataContainerSchema, { page });
  const mc = res.MediaContainer;
  return { items: toItems(mc.Metadata), start: mc.offset ?? page.start, total: mc.totalSize ?? null };
}

export async function getItem(target: PmsTarget, ratingKey: string): Promise<LibraryItem | null> {
  const id = PlexIdSchema.parse(ratingKey);
  const res = await pmsGet(target, "metadata", `/library/metadata/${id}`, MetadataContainerSchema);
  return toItems(res.MediaContainer.Metadata)[0] ?? null;
}

/** All episodes of a show, in order ("leaves" of the show's hierarchy). */
export async function listEpisodes(target: PmsTarget, showRatingKey: string): Promise<LibraryItem[]> {
  const id = PlexIdSchema.parse(showRatingKey);
  const res = await pmsGet(target, "episodes", `/library/metadata/${id}/allLeaves`, MetadataContainerSchema);
  return toItems(res.MediaContainer.Metadata).filter((i) => i.type === "episode");
}

export async function search(target: PmsTarget, query: string): Promise<LibraryItem[]> {
  const res = await pmsGet(target, "search", "/hubs/search", SearchSchema, { query: { query, limit: "20" } });
  const hubs = res.MediaContainer.Hub.filter((h) => h.type === "movie" || h.type === "show" || h.type === "episode");
  return hubs.flatMap((h) => toItems(h.Metadata));
}
