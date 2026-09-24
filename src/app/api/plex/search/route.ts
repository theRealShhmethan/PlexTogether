import { z } from "zod";
import { jsonError } from "@/lib/http/security";
import { search } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";

const QuerySchema = z.string().trim().min(1).max(100);

/** Searches movies, shows and episodes on the selected server. */
export async function GET(request: Request) {
  const q = QuerySchema.safeParse(new URL(request.url).searchParams.get("q") ?? "");
  if (!q.success) return jsonError(400, "Enter 1–100 characters to search");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  try {
    return Response.json({ items: await search(host.target, q.data) }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "search results");
  }
}
