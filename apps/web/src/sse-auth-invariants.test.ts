import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

// Source-text guards over web modules live in this package so the affected
// filter runs them on every web change; a guard housed elsewhere only runs when
// that other package is touched. The matching handler-side guard is in
// apps/api/src/tests/security/sse-auth-invariants.test.ts.
const WEB_SOURCE = import.meta.dirname;
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

describe("SSE auth invariants", () => {
  test("browser EventSource connections do not carry bearer credentials in URLs", () => {
    const eventSourceFiles = listSourceFiles(WEB_SOURCE).filter((path) =>
      readSource(path).includes("new EventSource"),
    );

    expect(eventSourceFiles.length).toBeGreaterThan(0);

    for (const path of eventSourceFiles) {
      const source = readSource(path);

      expect(source).not.toMatch(/[?&](?:token|auth|authorization)=/iu);
      expect(source).not.toMatch(/\b(?:authToken|sessionToken)\b/u);
      expect(source).toContain("withCredentials: true");
    }
  });
});
