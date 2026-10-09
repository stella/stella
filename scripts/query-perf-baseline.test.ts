import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkQueryPerfBaseline,
  parseQueryPerfAllowance,
  parseQueryPerfBaseline,
  queryPerfBaselineViolations,
} from "./query-perf-baseline";

const base = {
  "document-search": { sharedBlocks: 100, executionTimeUs: 1000 },
};
const head = {
  "document-search": { sharedBlocks: 110, executionTimeUs: 1000 },
};
const allowance = {
  metric: "query-perf-shared-blocks",
  file: "document-search",
  delta: 10,
  reason: "Additional projection work",
} as const;

test("baseline raises require an exact PR allowance and tightening needs none", () => {
  expect(
    queryPerfBaselineViolations({ base, head, allowances: [] }),
  ).toHaveLength(1);
  expect(
    queryPerfBaselineViolations({ base, head, allowances: [allowance] }),
  ).toEqual([]);
  expect(
    queryPerfBaselineViolations({
      base,
      head,
      allowances: [{ ...allowance, delta: 11 }],
    }),
  ).toHaveLength(1);
  expect(
    queryPerfBaselineViolations({
      base,
      head,
      allowances: [allowance, allowance],
    }),
  ).toHaveLength(1);
  expect(
    queryPerfBaselineViolations({ base: head, head: base, allowances: [] }),
  ).toEqual([]);
  expect(
    queryPerfBaselineViolations({ base, head: {}, allowances: [] }),
  ).toHaveLength(1);
  expect(
    queryPerfBaselineViolations({ base, head: base, allowances: [allowance] }),
  ).toHaveLength(1);
});

test("allowance and baseline input validation rejects missing, nonfinite and unknown fields", () => {
  expect(parseQueryPerfAllowance(allowance)).toEqual(allowance);
  expect(() => parseQueryPerfAllowance({ ...allowance, reason: " " })).toThrow(
    "nonempty reason",
  );
  expect(() => parseQueryPerfAllowance({ ...allowance, extra: true })).toThrow(
    "unknown keys",
  );
  expect(() =>
    parseQueryPerfBaseline({
      seedId: "seed",
      settingsDigest: "a".repeat(64),
      entries: { broken: { sharedBlocks: 1, executionTimeMs: Infinity } },
    }),
  ).toThrow("Malformed query perf baseline entry");
});

test("the repository checker accepts documentation and makes inherited allowances inert", () => {
  const repositoryRoot = mkdtempSync(
    path.join(os.tmpdir(), "query-perf-baseline-"),
  );
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const write = (file: string, value: unknown) => {
    const target = path.join(repositoryRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  };
  const baselinePath = "apps/api/src/tests/query-perf/baseline.json";
  const baseline = {
    seedId: "seed",
    settingsDigest: "a".repeat(64),
    entries: { "document-search": { sharedBlocks: 100, executionTimeMs: 1 } },
  };
  try {
    runGit(["init", "--quiet"]);
    write(baselinePath, baseline);
    write("scripts/query-perf-allowances/README.md", "Allowance documentation");
    write("scripts/query-perf-allowances/inherited.json", allowance);
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const baseRef = runGit(["rev-parse", "HEAD"]);
    checkQueryPerfBaseline({ baseRef, repositoryRoot });
    write(baselinePath, {
      ...baseline,
      entries: { "document-search": { sharedBlocks: 110, executionTimeMs: 1 } },
    });
    expect(() => checkQueryPerfBaseline({ baseRef, repositoryRoot })).toThrow(
      "needs a PR-scoped allowance",
    );
    write("scripts/query-perf-allowances/current.json", allowance);
    checkQueryPerfBaseline({ baseRef, repositoryRoot });
    write("scripts/query-perf-allowances/current.json", {
      ...allowance,
      delta: 11,
    });
    expect(() => checkQueryPerfBaseline({ baseRef, repositoryRoot })).toThrow(
      "exact baseline increase",
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
