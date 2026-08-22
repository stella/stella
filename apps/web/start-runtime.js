import { env, file, serve } from "bun";
import { fileURLToPath } from "node:url";

import { withCrossOriginIsolationHeaders } from "./cross-origin-isolation.js";
import handler from "./dist/server/server.js";

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = "0.0.0.0";
const CLIENT_DIST_URL = new URL("dist/client/", import.meta.url);
const IMMUTABLE_ASSET_PREFIX = "/assets/";

const port = Number.parseInt(env["PORT"] ?? String(DEFAULT_PORT), 10);
const hostname = env["HOST"] ?? DEFAULT_HOST;

/** @typedef {{ fetch(request: Request): Response | Promise<Response> }} StartHandler */

/**
 * @param {unknown} candidate Imported TanStack Start handler candidate.
 * @returns {candidate is StartHandler} Whether the candidate exposes the Start fetch API.
 */
const isStartHandler = (candidate) =>
  typeof candidate === "object" &&
  candidate !== null &&
  "fetch" in candidate &&
  typeof candidate.fetch === "function";

/**
 * @param {unknown} candidate Imported TanStack Start handler candidate.
 * @returns {StartHandler} Validated TanStack Start request handler.
 */
const createStartHandler = (candidate) => {
  if (!isStartHandler(candidate)) {
    throw new TypeError(
      "TanStack Start server bundle must export a fetch handler.",
    );
  }

  return candidate;
};

const startHandler = createStartHandler(handler);

const SERVER_DIST_URL = new URL("dist/server/", import.meta.url);

/**
 * @param {unknown} error Import failure.
 * @returns {boolean} Whether the failure broke module resolution or linking.
 */
const isModuleGraphError = (error) =>
  typeof error === "object" &&
  error !== null &&
  (("name" in error && error.name === "ResolveMessage") ||
    ("code" in error && error.code === "ERR_MODULE_NOT_FOUND") ||
    // Linking failures (e.g. an import binding the resolved file does not
    // export) surface as SyntaxError, never from evaluating browser-only
    // code — evaluation happens after the whole subtree linked.
    error instanceof SyntaxError);

/**
 * Import the entire server module graph before accepting traffic.
 *
 * The SSR bundle externalizes npm dependencies and splits routes into lazily
 * imported chunks, so a missing runtime dependency otherwise surfaces on the
 * first request that reaches it — after the deploy's health checks passed and
 * the previous tasks drained. Loading every chunk here turns that class into
 * a boot failure: the rollout never becomes healthy and the previous release
 * keeps serving.
 *
 * Only resolution and linking failures are fatal. Some route chunks are
 * browser-only and throw on evaluation outside a browser (e.g. module-scope
 * `window` reads); ESM links the full static subtree before evaluating, so
 * tolerating those cannot hide a broken module graph.
 *
 * @returns {Promise<number>} Number of server modules resolved.
 */
const loadServerModuleGraph = async () => {
  const chunkGlob = new Bun.Glob("**/*.js");
  const chunkPaths = await Array.fromAsync(
    chunkGlob.scan({ cwd: fileURLToPath(SERVER_DIST_URL) }),
  );
  if (chunkPaths.length === 0) {
    throw new Error("dist/server contains no modules; broken build output");
  }

  const results = await Promise.all(
    chunkPaths.map(async (chunkPath) => {
      try {
        await import(new URL(chunkPath, SERVER_DIST_URL).href);
        return null;
      } catch (error) {
        return { chunkPath, error };
      }
    }),
  );
  const failures = results.filter((result) => result !== null);
  /** @param {{ chunkPath: string, error: unknown }} failure Failed chunk import. */
  const describe = ({ chunkPath, error }) =>
    `dist/server/${chunkPath}: ${error instanceof Error ? error.message : String(error)}`;
  for (const failure of failures.filter(
    ({ error }) => !isModuleGraphError(error),
  )) {
    // eslint-disable-next-line no-console -- boot boundary; the wrapper has no logger and this must reach container logs
    console.warn(
      `server chunk threw on evaluation (browser-only chunk, tolerated) — ${describe(failure)}`,
    );
  }
  const fatal = failures.filter(({ error }) => isModuleGraphError(error));
  if (fatal.length > 0) {
    throw new Error(
      `server module graph failed to resolve:\n${fatal.map(describe).join("\n")}`,
    );
  }

  return chunkPaths.length - failures.length;
};

const serverModuleCount = await loadServerModuleGraph();

// `--smoke` proves the graph resolves inside a candidate filesystem (the
// Docker runner stage, CI) without binding a port, then exits.
if (process.argv.includes("--smoke")) {
  // eslint-disable-next-line no-console -- smoke-mode proof line for image build and CI logs
  console.log(`web runtime ok: ${serverModuleCount} server modules resolved`);
  process.exit(0);
}

/** @param {URL} requestUrl Parsed incoming request URL. */
const toClientAssetUrl = (requestUrl) => {
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith("/")) {
    return null;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  const fileName = segments.at(-1);
  if (!fileName?.includes(".")) {
    return null;
  }

  const assetUrl = new URL(segments.join("/"), CLIENT_DIST_URL);
  if (!assetUrl.href.startsWith(CLIENT_DIST_URL.href)) {
    return null;
  }

  return assetUrl;
};

/** @param {Request} request Incoming HTTP request. */
const serveClientAsset = async (request) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  const requestUrl = new URL(request.url);
  const assetUrl = toClientAssetUrl(requestUrl);
  if (!assetUrl) {
    return null;
  }

  const assetFile = file(assetUrl);
  if (!(await assetFile.exists())) {
    return null;
  }

  const headers = new Headers();
  if (assetFile.type) {
    headers.set("content-type", assetFile.type);
  }
  headers.set(
    "cache-control",
    requestUrl.pathname.startsWith(IMMUTABLE_ASSET_PREFIX)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
  );

  return new Response(request.method === "HEAD" ? null : assetFile, {
    headers,
  });
};

serve({
  hostname,
  port,
  // Longer than the load balancer's 60 s idle timeout (Bun defaults to
  // 10 s). The balancer may reuse an idle backend connection any time
  // before its own timeout expires, so the server must never close first:
  // a request written onto a closing connection is lost in flight and the
  // client hangs with no response.
  idleTimeout: 75,
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/health") {
      return new Response("ok", {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const assetResponse = await serveClientAsset(request);
    if (assetResponse) {
      return withCrossOriginIsolationHeaders(requestUrl, assetResponse);
    }

    return withCrossOriginIsolationHeaders(
      requestUrl,
      await startHandler.fetch(request),
    );
  },
});
