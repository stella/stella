import { env } from "bun";

import {
  createStartRuntime,
  serveStartRuntime,
  verifyServerModuleGraph,
} from "@stll/start-runtime";

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = "0.0.0.0";
const SERVER_DIRECTORY_URL = new URL("server/", import.meta.url);
const CLIENT_DIRECTORY_URL = new URL("client/", import.meta.url);
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
} as const;

const serverEntry: unknown = await import(
  new URL("server/server.js", import.meta.url).href
);
const handler =
  typeof serverEntry === "object" &&
  serverEntry !== null &&
  "default" in serverEntry
    ? serverEntry.default
    : null;
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
