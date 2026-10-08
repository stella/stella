import { expect, test } from "bun:test";

import {
  formatPostgresSelectorMisses,
  fullPostgresRunSha,
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
