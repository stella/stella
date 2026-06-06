import handler from "./dist/server/server.js";

const DEFAULT_PORT = 3002;
const DEFAULT_HOST = "0.0.0.0";
const CLIENT_DIST_URL = new URL("dist/client/", import.meta.url);
const IMMUTABLE_ASSET_PREFIX = "/assets/";

const port = Number.parseInt(Bun.env.PORT ?? String(DEFAULT_PORT), 10);
const hostname = Bun.env.HOST ?? DEFAULT_HOST;

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

  const file = Bun.file(assetUrl);
  if (!(await file.exists())) {
    return null;
  }

  const headers = new Headers();
  if (file.type) {
    headers.set("content-type", file.type);
  }
  headers.set(
    "cache-control",
    requestUrl.pathname.startsWith(IMMUTABLE_ASSET_PREFIX)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
  );

  return new Response(request.method === "HEAD" ? null : file, { headers });
};

Bun.serve({
  hostname,
  port,
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
      return assetResponse;
    }

    return await startHandler.fetch(request);
  },
});
