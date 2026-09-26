import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * `resolveDecisionReference` restates the SQL resolver's doctrine so the two
 * can be compared; it decides no stored outcome. A production module calling
 * it would make it a second resolver, deciding links the SQL never saw, so
 * only tests and test support may import it.
 */

const API_SRC = nodePath.resolve(import.meta.dir, "../../..");
const TEST_SUPPORT = nodePath.join(API_SRC, "tests");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      return full === TEST_SUPPORT ? [] : sourceFiles(full);
    }
    return entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

/** A static or dynamic import of the module, by alias or relative path. */
const IMPORTS_TWIN =
  /(?:from|import\()\s*["'][^"']*\/reference-resolution["']/u;

test("no production module imports the resolution twin", () => {
  const importers = sourceFiles(API_SRC)
    .filter((file) => IMPORTS_TWIN.test(readFileSync(file, "utf-8")))
    .map((file) => nodePath.relative(API_SRC, file));
  expect(importers).toEqual([]);
});

test("the guard recognizes the import forms it scans for", () => {
  // Not vacuous: the pattern matches the spellings an importer would use.
  for (const line of [
    'import { resolveDecisionReference } from "@/api/handlers/case-law/citations/reference-resolution";',
    'import type { ReferenceHolder } from "./reference-resolution";',
    'await import("@/api/handlers/case-law/citations/reference-resolution")',
  ]) {
    expect(IMPORTS_TWIN.test(line)).toBe(true);
  }
  expect(
    IMPORTS_TWIN.test(
      'import { resolveCitationsForDecision } from "@/api/handlers/case-law/citation-resolution";',
    ),
  ).toBe(false);
});
