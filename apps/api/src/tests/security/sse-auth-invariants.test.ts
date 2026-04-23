import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../../../../..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

const listSourceFiles = (relativeDir: string): string[] => {
  const root = join(REPO_ROOT, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      for (const nested of listSourceFiles(relative(REPO_ROOT, path))) {
        files.push(nested);
      }
      continue;
    }

    if (
      !SOURCE_EXTENSIONS.has(extname(entry.name)) ||
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
    const eventSourceFiles = listSourceFiles("apps/web/src").filter((path) =>
      readSource(path).includes("new EventSource"),
    );

    expect(eventSourceFiles.length).toBeGreaterThan(0);

    for (const path of eventSourceFiles) {
      const source = readSource(path);

      expect(source).not.toMatch(/[?&](?:token|auth|authorization)=/i);
      expect(source).not.toMatch(/\b(?:authToken|sessionToken)\b/);
      expect(source).toContain("withCredentials: true");
    }
  });

  test("SSE handlers do not authenticate with query string tokens", () => {
    const sseHandlerFiles = listSourceFiles("apps/api/src/handlers").filter(
      (path) => readSource(path).includes("text/event-stream"),
    );

    expect(sseHandlerFiles.length).toBeGreaterThan(0);

    for (const path of sseHandlerFiles) {
      const source = readSource(path);

      expect(source).not.toMatch(/\bquery\s*\.\s*token\b/);
      expect(source).not.toMatch(/\bvalidateBearerAuth\b/);
      expect(source).not.toMatch(/\btoken\s*:\s*t\.String\b/);
    }
  });
});
