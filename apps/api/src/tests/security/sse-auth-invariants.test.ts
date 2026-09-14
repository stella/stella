import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

// The browser half of this invariant (EventSource carries no credentials in the
// URL) lives in apps/web/src/sse-auth-invariants.test.ts: Turbo selects a test
// suite by package, so a guard over web source only runs when apps/web is what
// changed.
const HANDLERS = nodePath.join(import.meta.dirname, "../../handlers");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;

const listSourceFiles = (directory: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = nodePath.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }

    if (
      !SOURCE_EXTENSIONS.has(nodePath.extname(entry.name)) ||
      TEST_FILE_PATTERN.test(entry.name)
    ) {
      continue;
    }

    files.push(path);
  }

  return files;
};

const readSource = (path: string) => readFileSync(path, "utf-8");

/** Property list of a flat query-parameter schema, however it is named. */
const QUERY_SCHEMA_PATTERN =
  /(?:query\s*:|[Qq]uerySchema\s*=)\s*t\.Object\(\{([^}]*)\}/gu;
const TOKEN_KEY_PATTERN = /token/iu;

describe("SSE auth invariants", () => {
  test("SSE handlers do not authenticate with query string tokens", () => {
    const sseHandlerFiles = listSourceFiles(HANDLERS).filter((path) =>
      readSource(path).includes("text/event-stream"),
    );

    expect(sseHandlerFiles.length).toBeGreaterThan(0);

    for (const path of sseHandlerFiles) {
      const source = readSource(path);

      // Any credential-shaped query key, whatever it is called: a query
      // string reaches access logs, proxy caches, and referrer headers,
      // so these handlers read credentials from headers only.
      for (const [, properties] of source.matchAll(QUERY_SCHEMA_PATTERN)) {
        expect(properties).not.toMatch(TOKEN_KEY_PATTERN);
      }
      expect(source).not.toMatch(/\bquery\s*[.:][^;\n]*token/iu);
      expect(source).not.toMatch(/\bvalidateBearerAuth\b/u);
      expect(source).not.toMatch(/\btoken\s*:\s*t\.String\b/u);
    }
  });
});
