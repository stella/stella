import { expect, test } from "bun:test";

import {
  baselineErrors,
  coverageProblems,
  exportedRuleIds,
  initialBaselineErrors,
  parseCoverageBaseline,
  readCoverage,
} from "./check-oxlint-rule-coverage.ts";
import { addedEntries } from "./ledger-membership.ts";

const plugin = {
  meta: { name: "fixture-plugin" },
  rules: { "fixture-rule": {} },
};
const ruleIds = exportedRuleIds(plugin);
const ruleId = "fixture-plugin/fixture-rule";
const complete = readCoverage(
  [
    JSON.stringify({ ruleId, outcome: "report" }),
    JSON.stringify({ ruleId, outcome: "clean" }),
  ].join("\n"),
);
const lintConfig = { rules: { [ruleId]: "warn" } };
const inspect = (config: unknown, coverage = complete) =>
  coverageProblems({
    ruleIds,
    registeredRuleIds: new Set(ruleIds),
    lintConfig: config,
    trackedFiles: ["src/example.ts"],
    coverage,
  });

test("enumerates exported keys independently of module filenames", () => {
  expect(
    exportedRuleIds({
      meta: { name: "different-name" },
      rules: { first: {}, second: {} },
    }),
  ).toEqual(["different-name/first", "different-name/second"]);
});

test("rejects a fixture rule absent from the configuration", () => {
  expect(inspect({ rules: {} })).toEqual([{ ruleId, category: "unwired" }]);
  expect(
    coverageProblems({
      ruleIds,
      registeredRuleIds: new Set(),
      lintConfig,
      trackedFiles: ["src/example.ts"],
      coverage: complete,
    }),
  ).toEqual([{ ruleId, category: "unwired" }]);
});

test("rejects a fixture rule whose enabled glob reaches no tracked source", () => {
  expect(
    inspect({
      overrides: [{ files: ["missing/**/*.ts"], rules: { [ruleId]: "error" } }],
    }),
  ).toEqual([{ ruleId, category: "empty-scope" }]);
});

test("rejects a fixture rule tested only on clean sources", () => {
  const clean = readCoverage(JSON.stringify({ ruleId, outcome: "clean" }));
  expect(inspect(lintConfig, clean)).toEqual([
    { ruleId, category: "untested" },
  ]);
});

test("requires both executed outcomes and accepts warning severity", () => {
  expect(inspect(lintConfig)).toEqual([]);
  expect(
    inspect(
      lintConfig,
      readCoverage(JSON.stringify({ ruleId, outcome: "report" })),
    ),
  ).toEqual([{ ruleId, category: "untested" }]);
});

test("resolves off overrides, exclusions and ignored files", () => {
  expect(
    inspect({
      ...lintConfig,
      overrides: [{ files: ["src/**"], rules: { [ruleId]: [0] } }],
    }),
  ).toEqual([{ ruleId, category: "empty-scope" }]);
  expect(
    inspect({
      overrides: [
        {
          files: ["src/**"],
          excludeFiles: ["src/example.ts"],
          rules: lintConfig.rules,
        },
      ],
    }),
  ).toEqual([{ ruleId, category: "empty-scope" }]);
  expect(inspect({ ...lintConfig, ignorePatterns: ["src/"] })).toEqual([
    { ruleId, category: "empty-scope" },
  ]);
  expect(inspect({ rules: { [ruleId]: "off" } })).toEqual([
    { ruleId, category: "unwired" },
  ]);
});

test("baseline fails on new gaps and on resolved entries left behind", () => {
  const problems = inspect({ rules: {} });
  const key = `${ruleId}::unwired`;
  expect(baselineErrors(problems, {})).toEqual([`Missing control: ${key}`]);
  expect(
    baselineErrors(problems, { [key]: "Existing rule awaiting registration." }),
  ).toEqual([]);
  expect(
    baselineErrors([], { [key]: "Existing rule awaiting registration." }),
  ).toEqual([`Remove resolved baseline entry: ${key}`]);
});

test("initial baseline cannot grandfather a new exported rule", () => {
  const baseline = { [`${ruleId}::untested`]: "Existing coverage gap." };
  expect(initialBaselineErrors(baseline, ruleIds)).toEqual([]);
  expect(initialBaselineErrors(baseline, [])).toEqual([
    `New rules cannot enter the baseline: ${ruleId}::untested`,
  ]);
});

test("baseline membership cannot replace a removed entry with a new gap", () => {
  const existing = `${ruleId}::untested`;
  const added = `${ruleId}::unwired`;
  expect(addedEntries([], [existing])).toEqual([]);
  expect(addedEntries([added], [existing])).toEqual([added]);
});

test("baseline and executed evidence reject malformed records", () => {
  expect(() => parseCoverageBaseline('{"invalid":"reason"}')).toThrow(
    "Rule coverage baseline must map",
  );
  expect(() => parseCoverageBaseline(`{"${ruleId}::untested":""}`)).toThrow(
    "Rule coverage baseline must map",
  );
  expect(() =>
    readCoverage(JSON.stringify({ ruleId, outcome: "named" })),
  ).toThrow("Invalid executed rule coverage record");
});
