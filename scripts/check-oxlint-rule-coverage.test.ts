import { expect, test } from "bun:test";

import {
  coverageErrors,
  coverageProblems,
  exportedRuleIds,
  readCoverage,
} from "./check-oxlint-rule-coverage.ts";

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

test("every coverage gap fails with its remediation", () => {
  expect(coverageErrors([])).toEqual([]);
  expect(coverageErrors(inspect({ rules: {} }))).toEqual([
    `Custom rule coverage gap: ${ruleId}::unwired (register the plugin and configure the rule)`,
  ]);
  expect(
    coverageErrors([
      { ruleId, category: "empty-scope" },
      { ruleId, category: "untested" },
    ]),
  ).toEqual([
    `Custom rule coverage gap: ${ruleId}::empty-scope (give the rule at least one linted file)`,
    `Custom rule coverage gap: ${ruleId}::untested (add reporting and clean test cases)`,
  ]);
});

test("executed evidence rejects malformed records", () => {
  expect(() =>
    readCoverage(JSON.stringify({ ruleId, outcome: "named" })),
  ).toThrow("Invalid executed rule coverage record");
});
