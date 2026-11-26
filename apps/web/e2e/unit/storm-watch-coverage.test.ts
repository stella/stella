import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { guardEnforcesLine } from "../../../../scripts/guard-rollouts.ts";

// Every browser spec runs under the storm watch: it takes `test` from the
// shared fixture (../helpers/test.ts) or the storm-watch fixture
// (../helpers/storm-watch-fixture.ts), which both install it, and opens any
// context of its own through `newWatchedContext` / `newWatchedPage`, never
// straight through `@playwright/test` or `browser.newContext` /
// `browser.newPage`, where no page would be watched.
//
// Registered in scripts/guard-rollouts: enforced on changed lines first.
const GUARD = "storm-watch-coverage";
const E2E_ROOT = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(E2E_ROOT, "../../..");

/** Specs that may use Playwright's own `test` and contexts, and why. */
const UNWATCHED_SPECS: Readonly<Record<string, string>> = {
  "ui-playground/storm-watch.geometry.spec.ts":
    "Holds the watch itself to its job: it installs the watch on its own and drives deliberate storms that the fixture would fail.",
};

const UNWATCHED_USES = [
  {
    pattern:
      /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*["']@playwright\/test["']/u,
    fix: 'import `test` from "../helpers/test" or "../helpers/storm-watch-fixture"',
  },
  {
    pattern: /\bbrowser\s*\.\s*newContext\s*\(/u,
    fix: "open it with newWatchedContext(browser, options) from ../helpers/storm-watch-fixture",
  },
  {
    pattern: /\bbrowser\s*\.\s*newPage\s*\(/u,
    fix: "open it with newWatchedPage(browser, options) from ../helpers/storm-watch-fixture",
  },
] as const;

const specs = [...new Bun.Glob("**/*.spec.ts").scanSync(E2E_ROOT)].toSorted();

const read = (spec: string) => readFileSync(path.join(E2E_ROOT, spec), "utf-8");

// The line a match starts on, counted from 1.
const lineOf = (source: string, index: number) =>
  source.slice(0, index).split("\n").length;

describe("storm watch coverage", () => {
  test("finds the browser specs", () => {
    expect(specs.length).toBeGreaterThan(50);
  });

  test("every browser spec and every context it opens runs under the storm watch", () => {
    const violations = specs
      .filter((spec) => !Object.hasOwn(UNWATCHED_SPECS, spec))
      .flatMap((spec) => {
        const source = read(spec);
        const file = repoRelativePath(REPO_ROOT, path.join(E2E_ROOT, spec));
        return UNWATCHED_USES.flatMap(({ pattern, fix }) =>
          [...source.matchAll(new RegExp(pattern.source, "gu"))].map(
            (match) => ({ file, line: lineOf(source, match.index), fix }),
          ),
        );
      })
      .filter(({ file, line }) =>
        guardEnforcesLine({ guard: GUARD, file, line }),
      )
      .map(({ file, line, fix }) => `${file}:${String(line)}: ${fix}`);
    expect(violations).toEqual([]);
  });

  test("every unwatched spec is still a spec that imports Playwright's test", () => {
    const stale = Object.keys(UNWATCHED_SPECS).filter(
      (spec) =>
        !specs.includes(spec) || !UNWATCHED_USES[0].pattern.test(read(spec)),
    );
    expect(stale).toEqual([]);
  });
});
