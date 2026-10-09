import { panic } from "better-result";
import { env } from "bun";
import { fileURLToPath } from "node:url";

import {
  createStartRuntime,
  serveStartRuntime,
  verifyServerModuleGraph,
} from "@stll/start-runtime";
import { loadLocalModule } from "@stll/start-runtime/local-module-loader";

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = "0.0.0.0";
const SERVER_DIRECTORY_URL = new URL("server/", import.meta.url);
const CLIENT_DIRECTORY_URL = new URL("client/", import.meta.url);
// The server entry is a build output next to this file, so it is loaded at runtime
// from the server directory rather than imported statically.
const loadedServerEntry = await loadLocalModule({
  root: fileURLToPath(SERVER_DIRECTORY_URL),
  modulePath: "server.js",
});
const serverEntry = loadedServerEntry.isErr()
  ? panic("Cannot load the web server entry", loadedServerEntry.error)
  : loadedServerEntry.value;
const handler =
  typeof serverEntry === "object" &&
  serverEntry !== null &&
  "default" in serverEntry
    ? serverEntry.default
    : null;

const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

const runtime = createStartRuntime({
  clientDirectoryUrl: CLIENT_DIRECTORY_URL,
  handler,
  responseHeaders: CROSS_ORIGIN_ISOLATION_HEADERS,
});

const verification = await verifyServerModuleGraph({
  serverDirectoryUrl: SERVER_DIRECTORY_URL,
});
for (const failure of verification.toleratedFailures) {
  process.stderr.write(
    `server chunk threw on evaluation (browser-only chunk, tolerated) — ${failure}\n`,
  );
}

if (process.argv.includes("--smoke")) {
  process.stdout.write(
    `web runtime ok: ${verification.loadedModuleCount} server modules resolved\n`,
  );
  process.exit(0);
}

serveStartRuntime({
  fetch: runtime.fetch,
  hostname: env["HOST"] ?? DEFAULT_HOST,
  // Longer than the load balancer's 60 s idle timeout. The server must not
  // close an idle backend connection before the balancer may reuse it.
  idleTimeout: 75,
  port: Number.parseInt(env["PORT"] ?? String(DEFAULT_PORT), 10),
});
