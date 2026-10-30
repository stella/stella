import { expect, test } from "bun:test";

import {
  POSTGRES_MAX_SHARDS,
  POSTGRES_MIN_SHARDS,
  postgresShardMatrix,
} from "../apps/api/scripts/postgres-test-shards";
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

const steps = [
  { name: "Run Postgres-gated API suites", conclusion: "success" },
];
const shardRun = (values: readonly string[], prefix = "") =>
  values.map((value) => ({
    name: `${prefix}postgres-service-suites (${value})`,
    conclusion: "success",
    steps,
  })) satisfies Parameters<typeof hasSuccessfulPostgresShards>[0];
const plannedCounts = Array.from(
  { length: POSTGRES_MAX_SHARDS - POSTGRES_MIN_SHARDS + 1 },
  (_, index) => POSTGRES_MIN_SHARDS + index,
);

test("full-run certification requires every shard of the run's own n", () => {
  for (const count of plannedCounts) {
    for (const prefix of ["", "Heavy suites / "]) {
      const jobs = shardRun(postgresShardMatrix(count), prefix);
      expect(hasSuccessfulPostgresShards(jobs), `${count}`).toBeTrue();
      for (const missing of jobs) {
        expect(
          hasSuccessfulPostgresShards(jobs.filter((job) => job !== missing)),
          `${count} without ${missing.name}`,
        ).toBeFalse();
      }
    }
  }
  expect(hasSuccessfulPostgresShards([])).toBeFalse();
});

test("unsuccessful or absent Postgres steps cannot certify any shard", () => {
  const jobs = shardRun(postgresShardMatrix(3));
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

test("legacy and countless shard jobs cannot certify full Postgres coverage", () => {
  for (const name of [
    "service-suites",
    "Heavy suites / service-suites",
    "postgres-service-suites",
    "postgres-service-suites (1)",
    "postgres-service-suites (1/0)",
    "postgres-service-suites (1/03)",
    "postgres-service-suites (1/3/4)",
  ]) {
    expect(
      hasSuccessfulPostgresShards([{ name, conclusion: "success", steps }]),
    ).toBeFalse();
  }
  // Pre-planner runs named shards without their count.
  expect(hasSuccessfulPostgresShards(shardRun(["1", "2", "3"]))).toBeFalse();
  expect(
    hasSuccessfulPostgresShards(shardRun(["1/3", "1/3", "1/3"])),
  ).toBeFalse();
  expect(
    hasSuccessfulPostgresShards(shardRun(["1/999999999999999999999999999999"])),
  ).toBeFalse();
  expect(hasSuccessfulPostgresShards(shardRun(["1/999"]))).toBeFalse();
  expect(hasSuccessfulPostgresShards(shardRun(["1/9"]))).toBeFalse();
  expect(
    hasSuccessfulPostgresShards([
      ...shardRun(postgresShardMatrix(3)),
      {
        name: "postgres-service-suites (1)",
        conclusion: "success",
        steps,
      },
    ]),
  ).toBeFalse();
  expect(
    hasSuccessfulPostgresShards([
      ...shardRun(postgresShardMatrix(3)),
      { name: "unrelated-job", conclusion: "failure", steps: [] },
    ]),
  ).toBeTrue();
});

test("a run never passes as a smaller or mixed topology", () => {
  for (const count of plannedCounts) {
    const values = postgresShardMatrix(count);
    // Dropping the last shard leaves 1..n-1, still named for n.
    expect(
      hasSuccessfulPostgresShards(shardRun(values.slice(0, -1))),
    ).toBeFalse();
    // A shard beyond the planned n is not part of any exact topology.
    expect(
      hasSuccessfulPostgresShards(
        shardRun([...values, `${count + 1}/${count}`]),
      ),
    ).toBeFalse();
    // Shards of two different plans never combine into one certificate.
    expect(
      hasSuccessfulPostgresShards(
        shardRun([...values.slice(0, -1), `${count}/${count + 1}`]),
      ),
    ).toBeFalse();
  }
});

test("a duplicate failed shard cannot be hidden by a successful duplicate", () => {
  const jobs = shardRun(postgresShardMatrix(3));
  expect(
    hasSuccessfulPostgresShards([
      ...jobs,
      {
        name: "postgres-service-suites (1/3)",
        conclusion: "failure",
        steps,
      },
    ]),
  ).toBeFalse();
});
