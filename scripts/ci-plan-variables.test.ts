import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  planVariablesExpression,
  predicateVariables,
} from "./ci-plan-variables";

const readWorkflow = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));

test("CI records every variable read by reachable job predicates", () => {
  const expression = planVariablesExpression(readWorkflow);
  expect(readWorkflow(".github/workflows/ci.yml")).toMatchObject({
    jobs: { "ci-plan": { outputs: { variables: expression } } },
  });
});

test("variable census follows nested local calls and handles repeated calls", () => {
  const workflows: Record<string, unknown> = {
    ".github/workflows/ci.yml": {
      jobs: {
        gate: {
          if: "needs.ci-plan.outputs.run_required && vars.FIRST",
          uses: "./.github/workflows/child.yml",
        },
        again: { uses: "./.github/workflows/child.yml" },
      },
    },
    ".github/workflows/child.yml": {
      jobs: {
        gate: {
          if: "vars['SECOND'] != ''",
          uses: "./.github/workflows/nested.yml",
        },
      },
    },
    ".github/workflows/nested.yml": {
      jobs: {
        gate: { if: "VARS.third == vars.FIRST && 'vars.IGNORED' != ''" },
      },
    },
  };
  expect(planVariablesExpression((file) => workflows[file])).toBe(
    `\${{ format('{{"FIRST":{0},"SECOND":{1},"THIRD":{2}}}', toJSON(vars.FIRST), toJSON(vars.SECOND), toJSON(vars.THIRD)) }}`,
  );
});

test("variable census rejects dynamic or whole-context access", () => {
  for (const predicate of ["vars[inputs.name]", "toJSON(vars)", "vars.*"]) {
    expect(() => predicateVariables(predicate)).toThrow(
      "Use a static vars name",
    );
  }
});

test("empty census records a JSON object", () => {
  expect(planVariablesExpression(() => ({ jobs: { plain: {} } }))).toBe(
    `\${{ '{}' }}`,
  );
});
