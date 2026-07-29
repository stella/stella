import { panic } from "better-result";
import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.resolve(APP_ROOT, "dist");
const DEV_PORT = 3002;
const API_TARGET = new URL(
  process.env["STELLA_API_URL"] ?? "http://localhost:3001",
);
const CERT_PATH = path.resolve(APP_ROOT, ".certs", "localhost-cert.pem");
const KEY_PATH = path.resolve(APP_ROOT, ".certs", "localhost-key.pem");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const runBuild = () => {
  const build = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: APP_ROOT });
  if (build.success) {
    console.log("Outlook add-in rebuilt.");
    return true;
  }

  console.error(decode(build.stderr));
  return false;
};

const getStaticPath = (pathname: string): string | null => {
  const requestedPath = pathname === "/" ? "/taskpane.html" : pathname;
  const normalizedPath = path.normalize(decodeURIComponent(requestedPath));
  const filePath = path.resolve(DIST_DIR, `.${normalizedPath}`);

  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) {
    return null;
  }

  return filePath;
};

const proxyApi = async (request: Request, requestUrl: URL) => {
  const targetUrl = new URL(API_TARGET);
  const apiPath = requestUrl.pathname.replace(/^\/api/u, "");
  targetUrl.pathname = `${API_TARGET.pathname.replace(/\/$/u, "")}${apiPath}`;
  targetUrl.search = requestUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const init: RequestInit = {
    headers,
    method: request.method,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  return fetch(targetUrl, init);
};

const serveStatic = (pathname: string) => {
  const filePath = getStaticPath(pathname);
  if (!filePath || !existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }

  const contentType = CONTENT_TYPES[path.extname(filePath)];
  const headers = contentType ? { "Content-Type": contentType } : {};
  return new Response(Bun.file(filePath), {
    headers,
  });
};

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
  panic(
    "Outlook add-ins need HTTPS. Run `bun --filter @stll/outlook cert` first.",
  );
}

if (!runBuild()) {
  process.exit(1);
}

let rebuildTimer: Timer | null = null;
const scheduleRebuild = () => {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    runBuild();
  }, 100);
};

for (const directory of ["src", "public"]) {
  watch(
    path.resolve(APP_ROOT, directory),
    { recursive: true },
    scheduleRebuild,
  );
}

Bun.serve({
  fetch: async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname.startsWith("/api")) {
      return await proxyApi(request, requestUrl);
    }

    return serveStatic(requestUrl.pathname);
  },
  hostname: "localhost",
  port: DEV_PORT,
  tls: {
    cert: readFileSync(CERT_PATH),
    key: readFileSync(KEY_PATH),
  },
});

console.log(
  `Stella Outlook add-in: https://localhost:${DEV_PORT}/taskpane.html`,
);
console.log(`Proxying /api to ${API_TARGET.toString()}`);
