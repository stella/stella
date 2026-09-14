import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  shardFilters,
  shardPackages,
  TEST_SHARD_IDS,
  TEST_SHARD_PACKAGES,
  workspacePackages,
} from "./test-shards.ts";

const workflow = readFileSync(
  path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf-8",
);

const ciTestsJob = (): string => {
  const marker = "\n  ci-tests:\n";
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const body = workflow.slice(start + marker.length);
  const next = body.search(/\n {2}[a-z][\w-]*:\n/u);
  return next === -1 ? body : body.slice(0, next);
};

const packages = workspacePackages();
const testedPackages = packages
  .filter(({ hasTestScript }) => hasTestScript)
  .map(({ name }) => name);
const packageNames = packages.map(({ name }) => name);

test("exactly one shard is the complement", () => {
  const complements = TEST_SHARD_IDS.filter(
    (shard) => TEST_SHARD_PACKAGES[shard] === null,
  );
  expect(complements).toHaveLength(1);
});

test("every named shard package is a workspace package that has tests", () => {
  for (const shard of TEST_SHARD_IDS) {
    for (const name of TEST_SHARD_PACKAGES[shard] ?? []) {
      expect(testedPackages).toContain(name);
    }
  }
});

test("the shards partition every package that has a test script", () => {
  const seen = new Map<string, string>();
  for (const shard of TEST_SHARD_IDS) {
    for (const name of shardPackages({ packageNames, shard })) {
      const owner = seen.get(name);
      if (owner !== undefined) {
        throw new Error(`${name} is owned by both ${owner} and ${shard}`);
      }
      seen.set(name, shard);
    }
  }
  expect([...seen.keys()].toSorted()).toEqual(packageNames.toSorted());
});

test("a shard's filters exclude every package it does not own", () => {
  for (const shard of TEST_SHARD_IDS) {
    const owned = new Set(shardPackages({ packageNames, shard }));
    const excluded = new Set(
      shardFilters({ packageNames, shard }).map((filter) =>
        filter.replace("--filter=!", ""),
      ),
    );
    for (const name of testedPackages) {
      expect(owned.has(name)).toBe(!excluded.has(name));
    }
  }
});

// The workflow matrix is the other half of the shard map: a shard the matrix
// omits runs nowhere, and its packages would leave CI silently.
test("the ci-tests matrix runs exactly the declared shards", () => {
  const declared = /\n {8}shard: \[(?<ids>[^\]]+)\]\n/u.exec(ciTestsJob())
    ?.groups?.["ids"];
  if (declared === undefined) {
    throw new Error("ci-tests declares no shard matrix");
  }
  expect(declared.split(",").map((id) => id.trim())).toEqual([
    ...TEST_SHARD_IDS,
  ]);
});

test("exactly one shard runs the .claude/mcp suite", () => {
  const job = ciTestsJob();
  expect(job.match(/bun --cwd \.claude\/mcp test/gu)).toHaveLength(1);
  const gate = /matrix\.shard == '(?<shard>[a-z]+)'/u.exec(job)?.groups?.[
    "shard"
  ];
  if (gate === undefined) {
    throw new Error("the .claude/mcp step is not gated on a shard");
  }
  const shardIds: readonly string[] = TEST_SHARD_IDS;
  expect(shardIds).toContain(gate);
});
