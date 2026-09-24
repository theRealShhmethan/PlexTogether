import { getCurrentSession } from "@/lib/session/host";
import { toPublicUser } from "@/lib/session/publicUser";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return Response.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ user: toPublicUser(session) }, { headers: { "Cache-Control": "no-store" } });
}
