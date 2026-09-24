/**
 * PlexTogether server: Next.js plus the room WebSockets on one port.
 * (Next.js route handlers can't hold WebSocket connections, so the
 * documented custom-server setup is used.)
 *
 *   npm run dev    → development (hot reload)
 *   npm start      → production (run `npm run build` first)
 */
import { createServer } from "node:http";
import { loadEnvConfig } from "@next/env";
import next from "next";

const production = process.argv.includes("--production");
// Load .env / .env.local before anything reads process.env.
loadEnvConfig(process.cwd(), !production);

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const appOrigin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;

async function main() {
  // Imported after env is loaded (the room code reads session storage).
  const { handleRoomUpgrade } = await import("./src/lib/rooms/socket");

  const app = next({ dev: !production, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => void handle(req, res));
  // Room sockets are ours; everything else (e.g. dev hot reload) is left to
  // the listener Next.js attaches itself — it ignores paths it doesn't route.
  server.on("upgrade", (req, socket, head) => {
    handleRoomUpgrade(req, socket, head, appOrigin);
  });
  server.listen(port, () => {
    console.log(`> PlexTogether ready on http://localhost:${port} (${production ? "production" : "development"})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
