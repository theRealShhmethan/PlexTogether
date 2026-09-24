import { listSections } from "@/lib/plex/library";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";

/** Movie and TV libraries on the selected server. */
export async function GET() {
  const ctx = await requireSelectedServer();
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json({ libraries: await listSections(ctx.target) }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "libraries");
  }
}
