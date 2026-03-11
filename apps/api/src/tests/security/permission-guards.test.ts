import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Endpoints that are intentionally unguarded.
 * Key: file basename relative to handlers/ (e.g. "dev/routes.ts").
 * Value: array of "METHOD /path" strings.
 *
 * Adding an entry here requires code review approval.
 */
const ALLOWLIST: Record<string, string[]> = {
  // Dev-only routes; guarded by env.isDev check
  "dev/routes.ts": [
    "POST /seed",
    "POST /clean",
    "POST /rebuild-search",
    "POST /clear-cache",
  ],
  // Read-like POST: search with body, no state mutation
  "search/routes.ts": ["POST /"],
  // Read-like POST: full-text search with body, no state mutation
  "case-law/routes.ts": ["POST /decisions/search"],
  // Read-like POSTs: file analysis / preview, no persistent state
  "templates/routes.ts": [
    "POST /discover",
    "POST /manifest",
    "POST /:templateId/fill-preview",
  ],
  // Read-like POST: file upload for chat context, no state mutation
  "chat/routes.ts": ["POST /upload-context-file"],
  // User preference: tracks last-active workspace per user
  "workspaces/routes.ts": ["POST /last-active"],
  // Read-like POST: stamp validation check, no state mutation
  "entities/routes.ts": ["POST /check-stamp"],
};

const HANDLERS_DIR = resolve(import.meta.dir, "../../handlers");

/** Match `.put(`, `.post(`, `.patch(`, `.delete(` calls. */
const MUTATION_RE = /\.(put|post|patch|delete)\(\s*["'`](.*?)["'`]/g;

/** Quick check: does the file contain any mutation calls? */
const HAS_MUTATION_RE = /\.(put|post|patch|delete)\(/m;

/** Matches `permissions:` macro property or `permission(` function. */
const PERMISSION_RE = /\bpermissions?\s*[:(]/;

/** Matches the start of a chained Elysia method call. */
const CHAIN_RE = /^\s*\.\s*(get|put|post|patch|delete|group)\s*\(/;

type Endpoint = {
  method: string;
  path: string;
  line: number;
  hasPermission: boolean;
};

const parseRouteFile = (filePath: string): Endpoint[] => {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const endpoints: Endpoint[] = [];

  for (const match of source.matchAll(MUTATION_RE)) {
    const method = (match[1] ?? "").toUpperCase();
    const path = match[2] ?? "";
    const matchIndex = match.index ?? 0;

    // Find the line number of this match
    const lineNumber = source.slice(0, matchIndex).split("\n").length;

    // Scan forward from the match, stopping at the next
    // chained method call or after 40 lines.
    const scanEnd = Math.min(lineNumber + 40, lines.length);
    const windowLines: string[] = [];
    for (let i = lineNumber; i < scanEnd; i++) {
      const line = lines[i] ?? "";
      if (CHAIN_RE.test(line)) {
        break;
      }
      windowLines.push(line);
    }
    const window = windowLines.join("\n");

    const hasPermission = PERMISSION_RE.test(window);

    endpoints.push({
      method,
      path,
      line: lineNumber,
      hasPermission,
    });
  }

  return endpoints;
};

describe("permission guards", () => {
  // Discover all route files
  const handlerDirs = readdirSync(HANDLERS_DIR, {
    withFileTypes: true,
  }).filter((d) => d.isDirectory());

  for (const dir of handlerDirs) {
    const routeFile = resolve(HANDLERS_DIR, dir.name, "routes.ts");

    let source: string;
    try {
      source = readFileSync(routeFile, "utf8");
    } catch {
      continue; // No routes.ts in this handler dir
    }

    // Skip if file has no mutations at all
    if (!HAS_MUTATION_RE.test(source)) {
      continue;
    }

    const relPath = `${dir.name}/routes.ts`;
    const allowedEndpoints = ALLOWLIST[relPath] ?? [];
    const endpoints = parseRouteFile(routeFile);

    for (const ep of endpoints) {
      const label = `${ep.method} ${ep.path}`;
      const isAllowed = allowedEndpoints.includes(label);

      if (isAllowed) {
        continue;
      }

      test(`${relPath}:${ep.line} — ${label} has permission guard`, () => {
        expect(ep.hasPermission).toBe(true);
      });
    }
  }

  test("allowlist contains no stale entries", () => {
    for (const [relPath, allowed] of Object.entries(ALLOWLIST)) {
      const routeFile = resolve(HANDLERS_DIR, relPath);
      let endpoints: Endpoint[];
      try {
        endpoints = parseRouteFile(routeFile);
      } catch (error) {
        throw new Error(
          `Allowlist entry "${relPath}" refers to a non-existent file`,
          { cause: error },
        );
      }
      const found = new Set(endpoints.map((ep) => `${ep.method} ${ep.path}`));

      for (const label of allowed) {
        expect(found.has(label)).toBe(true);
      }
    }
  });
});
