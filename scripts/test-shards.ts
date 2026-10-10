#!/usr/bin/env bun

// Prints the Turbo filter arguments that restrict a `test` run to one CI shard.
//
// The `test` task is the longest step in CI, so it runs as a matrix of shards
// (ci-tests in .github/workflows/ci.yml) instead of one serial job; within the
// api shard, apps/api/scripts/run-tests.ts runs batches in parallel lanes sized
// to the runner's cores and memory. A shard is expressed as an exclusion of every package it
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
// shard families partition every package that has a `test` script.

import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { API_TEST_SHARD_IDS, isApiTestShardId } from "./api-test-shard-plan";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ROOTS = ["apps", "packages"] as const;

export const TEST_SHARD_IDS = [
  "api-1",
  "api-2",
  "api-3",
  "api-4",
  "rest",
  "web",
] as const;
export type TestShardId = (typeof TEST_SHARD_IDS)[number];

// Rest and web keep separate verdicts while sharing one runner.
export const TEST_JOB_SHARDS = {
  "api-1": ["api-1"],
  "api-2": ["api-2"],
  "api-3": ["api-3"],
  "api-4": ["api-4"],
  "rest-web": ["rest", "web"],
} as const satisfies Record<string, readonly TestShardId[]>;

/**
 * The packages each shard owns. `null` marks the complement shard: it runs
 * every package no other shard names, so adding a package needs no edit here.
 * apps/api and apps/web own a shard each because they carry by far the longest
 * suites; splitting them off is what shortens the critical path.
 */
export const TEST_SHARD_PACKAGES = {
  "api-1": ["@stll/api"],
  "api-2": ["@stll/api"],
  "api-3": ["@stll/api"],
  "api-4": ["@stll/api"],
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

export const apiShardValue = (shard: TestShardId, count = 4): string => {
  const apiShards = API_TEST_SHARD_IDS;
  if (!isApiTestShardId(shard)) {
    return "";
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > apiShards.length) {
    panic("Invalid API test shard count");
  }
  const index = apiShards.indexOf(shard);
  if (index >= count) {
    panic("API shard is outside the planned shard count");
  }
  return `${index + 1}/${count}`;
};

const parseShard = (args: readonly string[]): TestShardId => {
  const [flag, value] = args;
  if (
    (flag !== "--filters" &&
      flag !== "--api-shard" &&
      flag !== "--verify-output") ||
    value === undefined ||
    args.length !== (flag === "--verify-output" ? 4 : 2)
  ) {
    panic(
      "Usage: bun scripts/test-shards.ts <--filters|--api-shard> <shard>, or --verify-output <shard> <turbo-plan.json> <test-output.log>",
    );
  }
  const shard = TEST_SHARD_IDS.find((id) => id === value);
  if (shard === undefined) {
    panic(
      `Unknown test shard "${value}". Known shards: ${TEST_SHARD_IDS.join(", ")}`,
    );
  }
  return shard;
};

type AssertApiShardExecutedOptions = {
  shard: TestShardId;
  taskIds: readonly string[];
  output: string;
  count?: number;
};

export const assertApiShardExecuted = ({
  shard,
  taskIds,
  output,
  count = 4,
}: AssertApiShardExecutedOptions): void => {
  const value = apiShardValue(shard, count);
  if (value === "" || !taskIds.includes("@stll/api#test")) {
    return;
  }
  const marker = new RegExp(
    `API test shard ${value}: [1-9]\\d*/[1-9]\\d* files`,
    "u",
  );
  if (!marker.test(output)) {
    panic(`${shard} ran no API test files despite API being in scope`);
  }
};

if (import.meta.main) {
  const shard = parseShard(process.argv.slice(2));
  const count = Number(process.env["API_TEST_SHARD_COUNT"] || 4);
  if (process.argv[2] === "--verify-output") {
    const plan: { tasks: { taskId: string }[] } = JSON.parse(
      readFileSync(process.argv[4] ?? panic("Missing Turbo plan"), "utf-8"),
    );
    assertApiShardExecuted({
      shard,
      count,
      taskIds: plan.tasks.map(({ taskId }) => taskId),
      output: readFileSync(
        process.argv[5] ?? panic("Missing test output"),
        "utf-8",
      ),
    });
  } else {
    process.stdout.write(
      process.argv[2] === "--api-shard"
        ? `${apiShardValue(shard, count)}\n`
        : `${shardFilters({
            packageNames: workspacePackages().map(({ name }) => name),
            shard,
          }).join(" ")}\n`,
    );
  }
}
