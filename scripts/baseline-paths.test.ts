import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS, isSeededBaselineFile } from "./baseline-paths";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// A `-baseline.json` name is the convention, not the rule: `react-compiler-
// bailouts.json` is a baseline that does not carry it. The pattern below is
// deliberately wider than the suffix so a differently named budget still has
// to be classified by hand rather than slipping past the merge bar.
const TRACKED_BASELINE = /(?:baseline|bailouts)[^/]*\.json$/u;

const trackedFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\n").filter(Boolean);
};

// The list cannot be derived, so this is what stops it from going stale: a new
// producer's baseline is committed like any other file, and it lands here.
test("every committed baseline file is enumerated", () => {
  const committed = trackedFiles().filter((file) =>
    TRACKED_BASELINE.test(file),
  );

  expect(committed.length).toBeGreaterThan(0);
  expect(committed.filter((file) => !isSeededBaselineFile(file))).toEqual([]);
});

test("every enumerated baseline still exists", () => {
  const missing = Object.values(BASELINE_PATHS).filter(
    (baseline) => !existsSync(path.join(REPO_ROOT, baseline)),
  );

  expect(missing).toEqual([]);
});

test("a path that merely looks like a baseline is not one", () => {
  expect(isSeededBaselineFile("apps/api/src/lib/baseline.json")).toBe(false);
  expect(isSeededBaselineFile("scripts/migration-baseline.txt")).toBe(false);
});
