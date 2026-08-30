#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import path from "node:path";

const tsc = path.join(
  import.meta.dir,
  "../../../node_modules/@typescript/native/bin/tsc",
);

// Flags by which a caller takes over the checker split itself.
const THREADING_FLAGS = new Set(["--singleThreaded", "--checkers"]);

/**
 * Prepend `--singleThreaded` unless the caller already chose a checker split.
 *
 * Native tsc splits a project across parallel checkers whose type caches are
 * independent, and assigns files to checkers by position. Every checker
 * therefore re-instantiates the Eden treaty surface the first time one of its
 * own files touches it, and TypeScript abandons any single statement that
 * instantiates more than five million types: it yields `any`, which cascades
 * as `any`/`unknown` errors through files that contain no defect. Which
 * statement pays that cold cost is decided by the file-to-checker split, so
 * the same commit passes on one machine and fails on another, and adding any
 * file at all to `apps/web` re-splits it — four one-line placeholder files
 * reproduce the same flood as the feature that first surfaced this.
 *
 * One checker removes the split, so the result depends on the sources alone.
 * It is also cheaper: `apps/web` checks in 82s using 3.0 GB single-threaded
 * against 87s using 5.3 GB across four checkers, because parallel checkers
 * duplicate the same instantiations (12.0M against 31.3M).
 */
export const withCheckerSplit = (args: readonly string[]): string[] =>
  args.some((arg) => THREADING_FLAGS.has(arg))
    ? [...args]
    : ["--singleThreaded", ...args];

if (import.meta.main) {
  const result = spawnSync(
    process.execPath,
    [tsc, ...withCheckerSplit(process.argv.slice(2))],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error);
  }

  process.exit(result.status ?? 1);
}
