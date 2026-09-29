import { handleDownloadSubtitle, handleSearchSubtitles } from "@/lib/servers/playbackRoutes";

/** Find subtitles online for the host's pick (GET), and download one (POST). */
export async function GET(request: Request) {
  return handleSearchSubtitles(request, null);
}

export async function POST(request: Request) {
  return handleDownloadSubtitle(request, null);
}
