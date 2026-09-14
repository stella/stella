#!/usr/bin/env bun

// Prints the Turbo filter arguments that restrict a `test` run to one CI shard.
//
// The `test` task is the longest step in CI and the runners are two-core, so
// it runs as a matrix of shards (ci-tests in .github/workflows/ci.yml) instead
// of one serial job. A shard is expressed as an exclusion of every package it
// does not own, because Turbo unions positive filters and subtracts negative
// ones: adding `--filter=@stll/web` to the scope filters that
// scripts/test-scope.ts prints would widen the run, while `--filter=!@stll/web`
// narrows it. That keeps the affected scoping intact per shard.
//
//   bun run test -- --concurrency=2 \
//     $(bun scripts/test-scope.ts --base origin/main) \
//     $(bun scripts/test-shards.ts --filters web)
//
// The exclusions are derived from the live workspace, not a committed list, so
// a package added to apps/ or packages/ joins the complement shard on its own
// and cannot fall out of CI unnoticed. scripts/test-shards.test.ts proves the
// shards still partition every package that has a `test` script.

import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

export const TEST_SHARD_IDS = ["api", "rest", "web"] as const;
export type TestShardId = (typeof TEST_SHARD_IDS)[number];

/**
 * The packages each shard owns. `null` marks the complement shard: it runs
 * every package no other shard names, so adding a package needs no edit here.
 * apps/api and apps/web own a shard each because they carry by far the longest
 * suites; splitting them off is what shortens the critical path.
 */
export const TEST_SHARD_PACKAGES = {
  api: ["@stll/api"],
  rest: null,
  web: ["@stll/web"],
} as const satisfies Record<TestShardId, readonly string[] | null>;

type WorkspacePackage = {
  readonly name: string;
  readonly hasTestScript: boolean;
};

type PackageManifest = {
  name?: unknown;
  scripts?: { test?: unknown };
};

export const workspacePackages = (): readonly WorkspacePackage[] =>
  WORKSPACE_ROOTS.flatMap((workspaceRoot) =>
    readdirSync(path.join(REPO_ROOT, workspaceRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap(({ name: directory }) => {
        const manifestPath = path.join(
          REPO_ROOT,
          workspaceRoot,
          directory,
          "package.json",
        );
        const manifest: PackageManifest = JSON.parse(
          readFileSync(manifestPath, "utf-8"),
        );
        const { name } = manifest;
        if (typeof name !== "string") {
          panic(`${manifestPath} has no package name`);
        }
        return [{ hasTestScript: manifest.scripts?.test !== undefined, name }];
      }),
  );

const namedShardPackages = (): ReadonlySet<string> =>
  new Set(Object.values(TEST_SHARD_PACKAGES).flatMap((names) => names ?? []));

export const shardPackages = ({
  packageNames,
  shard,
}: {
  readonly packageNames: readonly string[];
  readonly shard: TestShardId;
}): readonly string[] => {
  const owned = TEST_SHARD_PACKAGES[shard];
  if (owned !== null) {
    return owned;
  }
  const named = namedShardPackages();
  return packageNames.filter((name) => !named.has(name));
};

export const shardFilters = ({
  packageNames,
  shard,
}: {
  readonly packageNames: readonly string[];
  readonly shard: TestShardId;
}): readonly string[] => {
  const owned = new Set(shardPackages({ packageNames, shard }));
  return packageNames
    .filter((name) => !owned.has(name))
    .toSorted()
    .map((name) => `--filter=!${name}`);
};

const parseShard = (args: readonly string[]): TestShardId => {
  const [flag, value] = args;
  if (flag !== "--filters" || value === undefined || args.length > 2) {
    panic("Usage: bun scripts/test-shards.ts --filters <shard>");
  }
  const shard = TEST_SHARD_IDS.find((id) => id === value);
  if (shard === undefined) {
    panic(
      `Unknown test shard "${value}". Known shards: ${TEST_SHARD_IDS.join(", ")}`,
    );
  }
  return shard;
};

if (import.meta.main) {
  const shard = parseShard(process.argv.slice(2));
  process.stdout.write(
    `${shardFilters({
      packageNames: workspacePackages().map(({ name }) => name),
      shard,
    }).join(" ")}\n`,
  );
}
