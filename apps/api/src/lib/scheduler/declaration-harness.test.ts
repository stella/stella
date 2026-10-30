import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { SCHEDULER_DECLARATION_HARNESS } from "./declaration-harness";
import { DECLARED_SCHEDULER_JOBS } from "./jobs";

const ledgerPath = "apps/api/src/lib/scheduler/declaration-harness.ts";
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

const exclusionsInSource = (source: string) =>
  [...source.matchAll(/"([^"]+)":\s*\{\s*status: "excluded"/gu)]
    .map((match) => match[1])
    .toSorted();

const currentExclusions = () =>
  Object.entries(SCHEDULER_DECLARATION_HARNESS)
    .filter(([, value]) => value.status === "excluded")
    .map(([task]) => task)
    .toSorted();

test("every declared scheduler task has one visible harness disposition", () => {
  expect(Object.keys(SCHEDULER_DECLARATION_HARNESS).toSorted()).toEqual(
    [...new Set(DECLARED_SCHEDULER_JOBS.map(({ task }) => task))].toSorted(),
  );
  const dispositions = Object.values(SCHEDULER_DECLARATION_HARNESS);
  expect(
    dispositions.filter(({ status }) => status === "run").length,
  ).toBeGreaterThan(0);
  for (const disposition of dispositions) {
    if (disposition.status === "excluded") {
      expect(disposition.reason.trim().length).toBeGreaterThan(0);
    }
  }
});

test("scheduler declaration observation exclusions only shrink from the merge base", () => {
  const current = readFileSync(
    new URL("declaration-harness.ts", import.meta.url),
    "utf-8",
  );
  expect(exclusionsInSource(current)).toEqual(currentExclusions());
  const revision = treeBaseRevision({ repoRoot });
  const present = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", revision, "--", ledgerPath],
    { cwd: repoRoot },
  );
  expect(present.exitCode).toBe(0);
  if (new TextDecoder().decode(present.stdout).trim() === "") {
    return;
  }
  const prior = Bun.spawnSync(["git", "show", `${revision}:${ledgerPath}`], {
    cwd: repoRoot,
  });
  expect(prior.exitCode).toBe(0);
  const baseline = exclusionsInSource(new TextDecoder().decode(prior.stdout));
  expect(
    currentExclusions().filter((task) => !baseline.includes(task)),
  ).toEqual([]);
});
