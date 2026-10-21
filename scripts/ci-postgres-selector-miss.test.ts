import { expect, test } from "bun:test";

import { POSTGRES_TEST_SHARD_IDS } from "../apps/api/scripts/postgres-test-shards";
import {
  formatPostgresSelectorMisses,
  fullPostgresRunSha,
  hasSuccessfulPostgresShards,
  postgresSelectorMisses,
  readPostgresFailures,
} from "./ci-postgres-selector-miss";
import { parseJunit } from "./fix-tests-on-base";

const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="2">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="4">
    <testcase name="assertion" classname="group" file="./apps/api/src/a.test.ts" line="2">
      <failure type="AssertionError" message="Expected true">AssertionError</failure>
    </testcase>
    <testcase name="runtime error" classname="group" file="apps/api/src/a.test.ts" line="4">
      <error type="TypeError" message="Cannot read property">TypeError</error>
    </testcase>
    <testcase name="pass" classname="group" file="src/b.test.ts" line="6" />
    <testcase name="skip" classname="group" file="src/c.test.ts" line="8">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

test("JUnit parsing preserves its report and reports failure testcase files", () => {
  const failures: (string | undefined)[] = [];
  const report = parseJunit(junit, (file) => {
    failures.push(file);
  });
  expect(report.cases.map(({ status }) => status)).toEqual([
    "fail",
    "fail",
    "pass",
    "skip",
  ]);
  expect(failures).toEqual([
    "./apps/api/src/a.test.ts",
    "apps/api/src/a.test.ts",
  ]);
  expect(readPostgresFailures(junit)).toEqual(["src/a.test.ts"]);
});

test("empty reports and failed cases without file attributes cannot certify selector coverage", () => {
  for (const xml of ["", "<testsuites />"]) {
    expect(() => readPostgresFailures(xml)).toThrow(
      "Postgres JUnit report contains zero testcases",
    );
  }
  expect(() =>
    readPostgresFailures(
      '<testsuites><testcase name="failure"><failure message="x" /></testcase></testsuites>',
    ),
  ).toThrow("Postgres JUnit failure is missing a testcase file attribute");
});

test("full-run baselines use the explicitly tested SHA rather than workflow HEAD", () => {
  const testedSha = "a".repeat(40);
  const workflowHead = "b".repeat(40);
  expect(testedSha).not.toBe(workflowHead);
  expect(fullPostgresRunSha(`Main heavy suites ${testedSha}`)).toBe(testedSha);
  expect(() => fullPostgresRunSha("uncertified display title")).toThrow(
    "no certified target SHA",
  );
  expect(() =>
    readPostgresFailures(junit.replace("</testsuites>", "")),
  ).toThrow("Postgres JUnit report is incomplete");
});

test("absolute, traversing, and non-test failure paths are rejected", () => {
  for (const file of [
    "/tmp/a.test.ts",
    "C:\\temp\\a.test.ts",
    "apps/api/../outside/a.test.ts",
    "src/not-a-test.ts",
  ]) {
    const xml = `<testsuites><testcase name="failure" file="${file.replaceAll("\\", "\\\\")}"><failure /></testcase></testsuites>`;
    expect(() => readPostgresFailures(xml)).toThrow("Postgres JUnit failure");
  }
});

test("selector misses name omitted failures and leave full selection unalerted", () => {
  const failingFiles = ["src/selected.test.ts", "src/omitted.test.ts"];
  const selected = {
    mode: "selected" as const,
    files: ["src/selected.test.ts"],
  };
  const misses = postgresSelectorMisses({ selection: selected, failingFiles });
  expect(misses).toEqual(["src/omitted.test.ts"]);
  expect(formatPostgresSelectorMisses(misses)).toEqual([
    "SELECTOR MISS: src/omitted.test.ts",
  ]);
  expect(
    postgresSelectorMisses({ selection: { mode: "all" }, failingFiles }),
  ).toEqual([]);
  expect(
    postgresSelectorMisses({ selection: { mode: "none" }, failingFiles }),
  ).toEqual(failingFiles);
});

test("full-run certification requires every Postgres matrix shard", () => {
  for (const prefix of ["", "Heavy suites / "]) {
    const jobs = POSTGRES_TEST_SHARD_IDS.map((shard) => ({
      name: `${prefix}postgres-service-suites (${shard})`,
      conclusion: "success",
      steps: [{ name: "Run Postgres-gated API suites", conclusion: "success" }],
    })) satisfies Parameters<typeof hasSuccessfulPostgresShards>[0];
    expect(hasSuccessfulPostgresShards(jobs)).toBeTrue();
    for (const missing of jobs) {
      expect(
        hasSuccessfulPostgresShards(jobs.filter((job) => job !== missing)),
      ).toBeFalse();
    }
  }
  expect(hasSuccessfulPostgresShards([])).toBeFalse();
});

test("unsuccessful or absent Postgres steps cannot certify any shard", () => {
  const jobs = POSTGRES_TEST_SHARD_IDS.map((shard) => ({
    name: `postgres-service-suites (${shard})`,
    conclusion: "success",
    steps: [{ name: "Run Postgres-gated API suites", conclusion: "success" }],
  })) satisfies Parameters<typeof hasSuccessfulPostgresShards>[0];
  for (const target of jobs) {
    for (const conclusion of [null, "failure", "cancelled", "skipped"]) {
      expect(
        hasSuccessfulPostgresShards(
          jobs.map((job) => (job === target ? { ...job, conclusion } : job)),
        ),
      ).toBeFalse();
      expect(
        hasSuccessfulPostgresShards(
          jobs.map((job) =>
            job === target
              ? {
                  ...job,
                  steps: [
                    { name: "Run Postgres-gated API suites", conclusion },
                  ],
                }
              : job,
          ),
        ),
      ).toBeFalse();
    }
    expect(
      hasSuccessfulPostgresShards(
        jobs.map((job) => (job === target ? { ...job, steps: [] } : job)),
      ),
    ).toBeFalse();
  }
});

test("legacy service jobs and repeated shards cannot certify full Postgres coverage", () => {
  const steps = [
    { name: "Run Postgres-gated API suites", conclusion: "success" },
  ];
  for (const name of [
    "service-suites",
    "Heavy suites / service-suites",
    "postgres-service-suites",
  ]) {
    expect(
      hasSuccessfulPostgresShards([{ name, conclusion: "success", steps }]),
    ).toBeFalse();
  }
  const repeatedShard = {
    name: "postgres-service-suites (1)",
    conclusion: "success",
    steps,
  };
  expect(
    hasSuccessfulPostgresShards(
      POSTGRES_TEST_SHARD_IDS.map(() => repeatedShard),
    ),
  ).toBeFalse();
});

test("runs certify only with exactly today's shard topology", () => {
  const steps = [
    { name: "Run Postgres-gated API suites", conclusion: "success" },
  ];
  const run = (shards: readonly number[], failed?: number) =>
    shards.map((shard) => ({
      name: `postgres-service-suites (${shard})`,
      conclusion: shard === failed ? "failure" : "success",
      steps,
    }));
  const shards: readonly number[] = POSTGRES_TEST_SHARD_IDS;
  expect(shards).toEqual(
    Array.from({ length: shards.length }, (_, index) => index + 1),
  );
  expect(hasSuccessfulPostgresShards(run(shards))).toBeTrue();
  for (const shard of shards) {
    expect(hasSuccessfulPostgresShards(run(shards, shard))).toBeFalse();
    // A run lacking any one shard never passes as a smaller topology.
    expect(
      hasSuccessfulPostgresShards(run(shards.filter((id) => id !== shard))),
    ).toBeFalse();
  }
  // Runs from other shard counts never certify today's coverage.
  for (let count = 1; count <= shards.length + 1; count += 1) {
    if (count !== shards.length) {
      const other = Array.from({ length: count }, (_, index) => index + 1);
      expect(hasSuccessfulPostgresShards(run(other))).toBeFalse();
    }
  }
});
