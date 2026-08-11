import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type DeploymentHeaders = {
  rules: Array<{
    headers: Record<string, string>;
    path: string;
  }>;
  schemaVersion: number;
  version: string;
};

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.resolve(APP_ROOT, "dist");
const DEPLOYMENT_HEADERS_PATH = path.resolve(
  DIST_DIR,
  "deployment-headers.json",
);
const DEFAULT_PORT = 3002;

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const getStaticPath = (pathname: string): string | null => {
  const requestedPath = pathname === "/" ? "/taskpane.html" : pathname;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    return null;
  }
  if (
    !decodedPath.startsWith("/") ||
    decodedPath.includes("\0") ||
    decodedPath.includes("\\") ||
    path.posix.normalize(decodedPath) !== decodedPath
  ) {
    return null;
  }
  const filePath = path.resolve(DIST_DIR, `.${decodedPath}`);

  if (filePath !== DIST_DIR && !filePath.startsWith(`${DIST_DIR}${path.sep}`)) {
    return null;
  }

  return filePath;
};

const matchesRule = (pathname: string, rulePath: string): boolean => {
  if (!rulePath.includes("*")) {
    return pathname === rulePath;
  }
  const [prefix, suffix] = rulePath.split("*");
  return pathname.startsWith(prefix ?? "") && pathname.endsWith(suffix ?? "");
};

const readDeploymentHeaders = (): DeploymentHeaders => {
  if (!existsSync(DEPLOYMENT_HEADERS_PATH)) {
    panic(
      "Production hosting requires a production artifact. Run `bun --filter @stll/outlook build -- --env=prod` first.",
    );
  }
  return JSON.parse(readFileSync(DEPLOYMENT_HEADERS_PATH, "utf-8"));
};

const deploymentHeaders = readDeploymentHeaders();
const port = Number(process.env["STELLA_OUTLOOK_PORT"] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  panic("STELLA_OUTLOOK_PORT must be a valid TCP port.");
}

Bun.serve({
  fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        headers: { Allow: "GET, HEAD" },
        status: 405,
      });
    }
    const requestUrl = new URL(request.url);
    const filePath = getStaticPath(requestUrl.pathname);
    if (!filePath || !existsSync(filePath)) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    for (const rule of deploymentHeaders.rules) {
      if (!matchesRule(requestUrl.pathname, rule.path)) {
        continue;
      }
      for (const [key, value] of Object.entries(rule.headers)) {
        headers.set(key, value);
      }
    }
    const contentType = CONTENT_TYPES[path.extname(filePath)];
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    return new Response(request.method === "HEAD" ? null : Bun.file(filePath), {
      headers,
    });
  },
  hostname: "0.0.0.0",
  port,
});

console.log(
  `Serving Outlook production artifact ${deploymentHeaders.version} on port ${port}.`,
);
