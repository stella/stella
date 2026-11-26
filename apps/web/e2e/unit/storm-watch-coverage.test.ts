import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every browser spec runs under the storm watch: it takes `test` from the
// shared fixture (../helpers/test.ts) or the storm-watch fixture
// (../helpers/storm-watch-fixture.ts), which both install it, never straight
// from `@playwright/test`, where no page would be watched.

const E2E_ROOT = path.resolve(import.meta.dir, "..");

/** Specs that may take Playwright's `test` directly, and why. */
const UNWATCHED_SPECS: Readonly<Record<string, string>> = {
  "ui-playground/storm-watch.geometry.spec.ts":
    "Holds the watch itself to its job: it installs the watch on its own and drives deliberate storms that the fixture would fail.",
};

const PLAYWRIGHT_TEST_IMPORT =
  /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/u;

const specs = [...new Bun.Glob("**/*.spec.ts").scanSync(E2E_ROOT)].toSorted();

describe("storm watch coverage", () => {
  test("finds the browser specs", () => {
    expect(specs.length).toBeGreaterThan(50);
  });

  test("every browser spec takes `test` from a fixture with the storm watch", () => {
    const unwatched = specs.filter(
      (spec) =>
        !(spec in UNWATCHED_SPECS) &&
        PLAYWRIGHT_TEST_IMPORT.test(
          readFileSync(path.join(E2E_ROOT, spec), "utf-8"),
        ),
    );
    expect(
      unwatched,
      'import `test` from "../helpers/test" or "../helpers/storm-watch-fixture"',
    ).toEqual([]);
  });

  test("every unwatched spec is still a spec that imports Playwright's test", () => {
    const stale = Object.keys(UNWATCHED_SPECS).filter(
      (spec) =>
        !specs.includes(spec) ||
        !PLAYWRIGHT_TEST_IMPORT.test(
          readFileSync(path.join(E2E_ROOT, spec), "utf-8"),
        ),
    );
    expect(stale).toEqual([]);
  });
});
