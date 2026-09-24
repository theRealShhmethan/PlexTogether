import { z } from "zod";
import { jsonError } from "@/lib/http/security";
import { ImagePathSchema } from "@/lib/plex/library";
import { pmsFetchRaw } from "@/lib/plex/pms";
import { requireSelectedServer } from "@/lib/servers/target";

/**
 * Poster/artwork proxy. Plex image URLs need the server token, so the browser
 * asks us instead and we fetch from PMS server-side.
 *
 * SECURITY: only paths matching ImagePathSchema (/library/metadata/<id>/thumb|art|banner/<ts>)
 * are accepted, so this can't be used to reach any other PMS endpoint.
 */
const ParamsSchema = z.object({
  path: ImagePathSchema,
  w: z.coerce.number().int().min(32).max(1200),
  h: z.coerce.number().int().min(32).max(1200),
});

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const params = ParamsSchema.safeParse({ path: sp.get("path"), w: sp.get("w"), h: sp.get("h") });
  if (!params.success) return jsonError(400, "Invalid image request");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  const { path, w, h } = params.data;

  let res: Response;
  try {
    // Ask PMS to resize (documented /photo/:/transcode). The source `url` is a
    // path on the same server; the token travels in the request header.
    res = await pmsFetchRaw(host.target, "/photo/:/transcode", {
      url: path,
      width: String(w),
      height: String(h),
      minSize: "1",
      upscale: "1",
    });
    // Fall back to the original image if the transcoder refuses.
    if (!res.ok) res = await pmsFetchRaw(host.target, path, {});
  } catch {
    return jsonError(502, "Could not load image");
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) {
    await res.body?.cancel();
    return jsonError(502, "Could not load image");
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": type,
      // Private: per-user, never cached by shared proxies.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
