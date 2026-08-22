import { env as runtimeEnv } from "bun";

import {
  createStartRuntime,
  serveStartRuntime,
  verifyServerModuleGraph,
} from "@stll/start-runtime";

import { env } from "@/env";

import { withCrossOriginIsolationHeaders } from "../cross-origin-isolation.js";

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = "0.0.0.0";
const SERVER_DIRECTORY_URL = new URL("server/", import.meta.url);
const CLIENT_DIRECTORY_URL = new URL("client/", import.meta.url);
const outlookOrigin = new URL(env.VITE_OUTLOOK_ORIGIN).origin;

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
  fetch: async (request) =>
    withCrossOriginIsolationHeaders(
      new URL(request.url),
      await runtime.fetch(request),
      outlookOrigin,
    ),
  hostname: runtimeEnv["HOST"] ?? DEFAULT_HOST,
  // Longer than the load balancer's 60 s idle timeout. The server must not
  // close an idle backend connection before the balancer may reuse it.
  idleTimeout: 75,
  port: Number.parseInt(runtimeEnv["PORT"] ?? String(DEFAULT_PORT), 10),
});
