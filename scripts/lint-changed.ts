#!/usr/bin/env bun
// Type-aware oxlint over only the files changed vs origin/main (plus the working
// tree) instead of the whole app.
//
// Why: `bun run lint` type-checks every file under apps/web + packages and takes
// ~7 min / ~5 GB on the web app. A typical change touches a handful of files,
// which lints in seconds (measured: one web file ≈ 3 s vs ≈ 408 s full). Use this
// in the local edit loop; CI still runs the full `lint`.
//
// Measured 2026-08-04: full web type-aware lint ≈ 408 s / 4.5 GB; single file ≈ 3 s.

import { $ } from "bun";
import { existsSync } from "node:fs";

const mergeBase = (
  await $`git merge-base origin/main HEAD`.quiet().nothrow()
).stdout
  .toString()
  .trim();
const base = mergeBase || "origin/main";

const [committed, worktree, untracked] = await Promise.all([
  $`git diff --name-only --diff-filter=ACMR ${base}...HEAD`.quiet().nothrow(),
  $`git diff --name-only --diff-filter=ACMR HEAD`.quiet().nothrow(),
  $`git ls-files --others --exclude-standard`.quiet().nothrow(),
]);

const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/u;
// oxlint already ignores these via config, but skip early so an all-generated
// diff doesn't spin up the type-aware engine for nothing.
const SKIP = /(\.gen\.ts$|\/generated\/|\/node_modules\/|routeTree\.gen)/u;

const files = [
  ...new Set(
    [committed, worktree, untracked]
      .flatMap((r) => r.stdout.toString().split("\n"))
      .map((f) => f.trim())
      .filter((f) => f && LINTABLE.test(f) && !SKIP.test(f))
      .filter((f) => existsSync(f)),
  ),
];

if (files.length === 0) {
  console.log("lint:changed — no changed lintable files vs origin/main");
  process.exit(0);
}

console.log(`lint:changed — ${files.length} changed file(s), type-aware:`);
for (const f of files) {
  console.log(`  ${f}`);
}

const result =
  await $`bun --bun oxlint -c oxlint.config.ts --report-unused-disable-directives-severity=error --deny-warnings --type-aware ${files}`.nothrow();

process.exit(result.exitCode);
