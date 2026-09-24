import { handleConnections } from "@/lib/servers/playbackRoutes";

/** The selected server's addresses, for the browser to pick one it can reach. */
export async function GET() {
  return handleConnections(null);
}
