#!/usr/bin/env bun
// CI gate: catches stale workspace `"version"` fields cached in bun.lock.
//
// Why this exists: `bun install` (even non-frozen) does NOT rewrite the
// `"version"` field bun.lock records for an already-present workspace entry
// when only that package's own package.json version changed — it only
// re-resolves dependency ranges. `bun install --frozen-lockfile` (what CI
// runs everywhere) validates that the dependency graph still satisfies the
// lockfile; it does not compare workspace self-versions either. So neither
// the normal install path nor the frozen-lockfile CI gate ever notices a
// workspace's recorded version drifting behind its package.json — and
// `bun pm pack` / `bun publish` reads the *lockfile's* cached version when
// resolving `workspace:^` / `workspace:~` ranges for a dependent's published
// manifest, so a stale entry silently ships a wrong dependency range. Stella
// publishes ~10 versioned `@stll/*` workspace packages, so it carries this
// exposure even though it has no changesets-driven version bump script.
//
// The only fix once it drifts is `rm bun.lock && bun install` (a full
// regenerate). This script cross-checks every workspace package.json
// `version` against the version bun.lock has cached for that workspace, so
// the drift itself gets caught in CI instead of silently persisting.
//
// Workspace directories are derived from the root package.json `workspaces`
// globs (`apps/*`, `packages/*`), not hardcoded, so a new workspace root
// (or a renamed one) is picked up automatically.

import { panic } from "better-result";
import { readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

const readJson = async (filePath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Bun.file(filePath).text());

// The root `workspaces` field only ever uses single-level globs of the shape
// `<dir>/*` in this repo (`apps/*`, `packages/*`). Resolve each to its
// immediate subdirectories rather than hand-rolling a general glob matcher.
const globParent = (glob: string): string => {
  if (!glob.endsWith("/*")) {
    panic(`unsupported workspaces glob "${glob}": expected "<dir>/*"`);
  }
  return glob.slice(0, -"/*".length);
};

const rootPkg = await readJson(path.join(ROOT, "package.json"));
const workspaceGlobs = Array.isArray(rootPkg.workspaces)
  ? rootPkg.workspaces.filter(
      (glob): glob is string => typeof glob === "string",
    )
  : panic("root package.json is missing a `workspaces` array");

const dirsForGlob = async (glob: string): Promise<string[]> => {
  const parent = globParent(glob);
  const entries = await readdir(path.join(ROOT, parent), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
};

const workspaceDirs = (await Promise.all(workspaceGlobs.map(dirsForGlob)))
  .flat()
  .sort();

const lockText = await Bun.file(path.join(ROOT, "bun.lock")).text();

// bun.lock is JSON-with-trailing-commas ("JSONC"-flavored), not strict JSON,
// so a plain JSON.parse fails on it. Rather than hand-roll a tolerant parser
// for the whole file (risking mis-parsing the many base64 `sha512-...`
// strings that legitimately contain `//`), extract just the one shape we
// need directly: the `"<workspace path>": { "name": ..., "version": ... }`
// block bun emits per workspace entry. bun always writes `name` and
// `version` first in that block, before any nested `dependencies` /
// `devDependencies` / `bin` maps, so matching up to the *first* `}` (rather
// than balancing braces) is safe: it always captures past the version field
// even when it stops short of the block's real close.
const versionForWorkspace = (workspaceDir: string): string | null => {
  const escaped = workspaceDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const blockRe = new RegExp(`"${escaped}":\\s*\\{([^}]*)\\}`, "u");
  const block = blockRe.exec(lockText)?.[1];
  if (!block) {
    return null;
  }
  return /"version":\s*"([^"]+)"/u.exec(block)?.[1] ?? null;
};

const mismatchForWorkspace = async (
  workspaceDir: string,
): Promise<string | null> => {
  const pkgPath = path.join(ROOT, workspaceDir, "package.json");
  if (!(await Bun.file(pkgPath).exists())) {
    return null;
  }

  const pkg = await readJson(pkgPath);
  const { name, version } = pkg;
  if (typeof name !== "string" || typeof version !== "string") {
    return null;
  }

  const lockedVersion = versionForWorkspace(workspaceDir);
  if (lockedVersion === null) {
    return `${name} (${workspaceDir}): no bun.lock entry found`;
  }
  if (lockedVersion !== version) {
    return `${name} (${workspaceDir}): package.json is ${version}, bun.lock has ${lockedVersion}`;
  }
  return null;
};

const mismatches = (
  await Promise.all(workspaceDirs.map(mismatchForWorkspace))
).filter((mismatch): mismatch is string => mismatch !== null);

if (mismatches.length > 0) {
  console.error(
    [
      "bun.lock workspace-version drift detected:",
      "",
      ...mismatches.map((line) => `  - ${line}`),
      "",
      "A plain `bun install` will not fix this (it doesn't rewrite cached",
      "workspace versions for entries that already exist). Regenerate the",
      "lockfile instead:",
      "",
      "    rm bun.lock && bun install",
      "",
      "Then commit the refreshed bun.lock.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  "bun.lock workspace-version check: all workspace versions match. OK.",
);
