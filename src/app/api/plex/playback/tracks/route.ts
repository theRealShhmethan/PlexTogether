import { handleGetTracks, handleSetTracks } from "@/lib/servers/playbackRoutes";

/** Audio/subtitle tracks for the host's pick. */
export async function GET() {
  return handleGetTracks(null);
}

export async function POST(request: Request) {
  return handleSetTracks(request, null);
}
