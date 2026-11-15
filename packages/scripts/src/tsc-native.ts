#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

import resolveTsrsBinary from "../../../node_modules/tsrs/lib/getExePath.js";
import { childExitStatus } from "./child-exit-status";

// tsrs, the Rust port of the TypeScript 7 compiler, compiles like `tsc`. Its
// npm launcher would run under Bun here, and Bun makes a piped stdout
// non-blocking once a script reads `process.stdout`, as the launcher does. The
// binary inherits that descriptor and drops what a full pipe refuses, so a
// piped `--listFilesOnly` stopped after its first 64 KiB. Spawning the binary
// directly, found by tsrs's own platform lookup, keeps stdio blocking. Every
// caller that runs the compiler takes the binary from here.
export { resolveTsrsBinary };

// Flags by which a caller takes over the checker split itself.
const THREADING_FLAGS = new Set(["--singleThreaded", "--checkers"]);

/**
 * Prepend `--singleThreaded` unless the caller already chose a checker split.
 *
 * Native tsc splits a project across parallel checkers whose type caches are
 * independent, and assigns files to checkers by position. Every checker
 * therefore re-instantiates a widely shared generic surface the first time one
 * of its own files touches it, and TypeScript abandons any single statement that
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
    resolveTsrsBinary(),
    withCheckerSplit(process.argv.slice(2)),
    { maxBuffer: 2 ** 30, stdio: "inherit" },
  );

  if (result.error) {
    console.error(result.error);
  }

  process.exit(childExitStatus(result));
}
