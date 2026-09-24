import { z } from "zod";
import { getConfig } from "@/lib/config";
import { isSameOrigin, jsonError } from "@/lib/http/security";
import { reportTimeline } from "@/lib/plex/playback";
import { noStore, pmsErrorResponse, requireSelectedServer } from "@/lib/servers/target";
import { saveSession } from "@/lib/session/store";

const BodySchema = z.object({
  sessionId: z.uuid(),
  state: z.enum(["playing", "paused", "buffering", "stopped"]),
  timeMs: z.number().min(0).max(24 * 60 * 60 * 1000),
});

/**
 * The player's progress reports, forwarded to PMS /:/timeline (keeps Plex's
 * session alive and saves the resume position). Only the current playback
 * session is accepted.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request, getConfig().appOrigin)) return jsonError(403, "Cross-origin request rejected");
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Invalid timeline report");

  const host = await requireSelectedServer();
  if (host instanceof Response) return host;
  const playback = host.session.playback;
  if (!playback || playback.sessionId !== body.data.sessionId) return jsonError(409, "Not the current playback session");

  try {
    await reportTimeline(
      host.target,
      playback.sessionId,
      playback.ratingKey,
      body.data.state,
      body.data.timeMs,
      playback.durationMs,
    );
    if (body.data.state === "stopped") {
      host.session.playback = undefined;
      saveSession(host.session);
    }
    return Response.json({ ok: true }, { headers: noStore });
  } catch (err) {
    return pmsErrorResponse(err, "playback progress");
  }
}
