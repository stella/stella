import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";

import { assertProperty } from "@stll/property-testing";

import {
  planVariablesExpression,
  predicateVariables,
  withPlanVariablesOutput,
} from "./ci-plan-variables";

const readWorkflow = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));

test("CI records every variable read by reachable workflow expressions", () => {
  const expression = planVariablesExpression(readWorkflow);
  expect(expression).toContain('"CI_POSTGRES_PR_SELECTION"');
  expect(expression).toContain('"CI_PR_DEPTH_PILOT"');
  expect(expression).toContain('"CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL"');
  expect(expression).toContain('"MERGE_QUEUE_DEPTH"');
  expect(readWorkflow(".github/workflows/ci.yml")).toMatchObject({
    jobs: {
      "ci-plan": {
        outputs: { variables: expression },
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: "completed-depth",
            env: expect.objectContaining({ PLAN_CONFIG: expression }),
          }),
        ]),
      },
    },
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

test("the variables output and generated comparison input change together", () => {
  const source = `jobs:
  ci-plan:
    outputs:
      variables: \${{ '{}' }}
    steps:
      - id: completed-depth
        env:
          PLAN_CONFIG: \${{ '{}' }}
  ci-result:
    steps:
      - id: outcome
        env:
          PLAN_CONFIG: \${{ needs.ci-plan.outputs.plan_config }}
`;
  const expression = `\${{ format('{{"FLAG":{0}}}', toJSON(vars.FLAG)) }}`;
  expect(withPlanVariablesOutput(source, expression)).toBe(`jobs:
  ci-plan:
    outputs:
      variables: ${expression}
    steps:
      - id: completed-depth
        env:
          PLAN_CONFIG: ${expression}
  ci-result:
    steps:
      - id: outcome
        env:
          PLAN_CONFIG: \${{ needs.ci-plan.outputs.plan_config }}
`);
});

test("a workflow requires exactly one variables output and one generated comparison input", () => {
  const output = "      variables: a\n";
  const comparison = "          PLAN_CONFIG: a\n";
  for (const source of [comparison, output]) {
    expect(() => withPlanVariablesOutput(source, "x")).toThrow("found 0");
  }
  for (const source of [
    output + output + comparison,
    output + comparison + comparison,
  ]) {
    expect(() => withPlanVariablesOutput(source, "x")).toThrow("found 2");
  }
});

test("variable census includes reachable workflow, job, matrix and step expressions", () => {
  const workflows: Record<string, unknown> = {
    ".github/workflows/ci.yml": {
      env: { REGION: `\${{ vars.WORKFLOW_ENV }}` },
      jobs: {
        gate: {
          if: "vars.JOB_IF == 'on'",
          "runs-on": `\${{ vars.RUNNER }}`,
          env: { REGION: `\${{ vars.JOB_ENV }}` },
          strategy: {
            matrix: {
              include: [{ image: `\${{ vars.MATRIX_IMAGE }}` }],
            },
          },
          steps: [
            {
              if: "vars.STEP_IF == 'on'",
              env: { REGION: `\${{ vars.STEP_ENV }}` },
              with: {
                script: `console.log(\${{ toJSON(vars.SCRIPT_INPUT) }});`,
              },
              run: `echo \${{ vars.RUN_INPUT }}`,
            },
          ],
        },
        linked: { uses: "./.github/workflows/child.yml" },
      },
    },
    ".github/workflows/child.yml": {
      env: { REGION: `\${{ vars.CHILD_ENV }}` },
      jobs: {
        child: {
          steps: [{ with: { input: `\${{ vars.CHILD_STEP }}` } }],
        },
      },
    },
  };
  const expression = planVariablesExpression((file) => workflows[file]);
  expect(predicateVariables(expression)).toEqual([
    "CHILD_ENV",
    "CHILD_STEP",
    "JOB_ENV",
    "JOB_IF",
    "MATRIX_IMAGE",
    "RUNNER",
    "RUN_INPUT",
    "SCRIPT_INPUT",
    "STEP_ENV",
    "STEP_IF",
    "WORKFLOW_ENV",
  ]);
});

test("plain shell and JavaScript variables are outside the GitHub expression census", () => {
  expect(
    planVariablesExpression(() => ({
      jobs: {
        "ci-plan": {
          steps: [
            {
              run: "const vars = {}; vars[dynamic] = vars.LOCAL; console.log(vars);",
              with: {
                script:
                  "for (const name of Object.keys(vars)) console.log(vars[name]);",
              },
              env: { NOTE: "vars.LOCAL_NAME" },
            },
          ],
        },
      },
    })),
  ).toBe(`\${{ '{}' }}`);
});

test("format literals containing closing braces and escaped quotes retain later references", () => {
  const expression = planVariablesExpression(() => ({
    jobs: {
      gate: {
        steps: [
          {
            run: `echo \${{ format('{{"ignored":"vars.IGNORED","value":{0}}}', vars.FORMAT_VALUE) }}; echo \${{ format('It''s }} {0}', vars.AFTER_QUOTE) }}`,
          },
        ],
      },
    },
  }));
  expect(predicateVariables(expression)).toEqual([
    "AFTER_QUOTE",
    "FORMAT_VALUE",
  ]);
});

test("only the generated main output and completed-depth input are excluded from the census", () => {
  const workflows: Record<string, unknown> = {
    ".github/workflows/ci.yml": {
      jobs: {
        "ci-plan": {
          outputs: { variables: `\${{ vars.REMOVED_OUTPUT }}` },
          steps: [
            {
              id: "completed-depth",
              env: { PLAN_CONFIG: `\${{ vars.REMOVED_INPUT }}` },
            },
            { id: "other", env: { PLAN_CONFIG: `\${{ vars.RETAINED }}` } },
          ],
        },
        real: { outputs: { variables: `\${{ vars.JOB_OUTPUT }}` } },
        child: { uses: "./.github/workflows/child.yml" },
      },
    },
    ".github/workflows/child.yml": {
      jobs: {
        "ci-plan": { outputs: { variables: `\${{ vars.CHILD_OUTPUT }}` } },
      },
    },
  };
  expect(
    predicateVariables(planVariablesExpression((file) => workflows[file])),
  ).toEqual(["CHILD_OUTPUT", "JOB_OUTPUT", "RETAINED"]);
});

test("generated mirrors reach a fixed point and cannot retain a removed variable", () => {
  const source = `jobs:
  ci-plan:
    outputs:
      variables: \${{ toJSON(vars.REMOVED) }}
    steps:
      - id: completed-depth
        env:
          PLAN_CONFIG: \${{ toJSON(vars.REMOVED) }}
  gate:
    if: vars.KEEP == 'on'
`;
  const census = (text: string) =>
    planVariablesExpression(() => Bun.YAML.parse(text));
  const expression = census(source);
  expect(predicateVariables(expression)).toEqual(["KEEP"]);
  const generated = withPlanVariablesOutput(source, expression);
  expect(census(generated)).toBe(expression);
  expect(withPlanVariablesOutput(generated, census(generated))).toBe(generated);
  const removed = generated.replace("  gate:\n    if: vars.KEEP == 'on'\n", "");
  expect(census(removed)).toBe(`\${{ '{}' }}`);
  const regenerated = withPlanVariablesOutput(removed, census(removed));
  expect(regenerated).not.toContain("vars.KEEP");
  expect(regenerated).not.toContain("vars.REMOVED");
  expect(withPlanVariablesOutput(regenerated, census(regenerated))).toBe(
    regenerated,
  );
});

const EXPRESSION_CENSUS_PROPERTY =
  "workflow expression census ignores arbitrary quoted literals and rejects truncation";

test(EXPRESSION_CENSUS_PROPERTY, () => {
  assertProperty(
    EXPRESSION_CENSUS_PROPERTY,
    fc.property(
      fc.array(
        fc.array(fc.constantFrom("'", "}}", "${{", "vars.IGNORED", "x", " "), {
          maxLength: 20,
        }),
        { minLength: 1, maxLength: 12 },
      ),
      (literals) => {
        const source = literals
          .map(
            (parts, index) =>
              `echo \${{ format('${parts.join("").replaceAll("'", "''")}', vars.FLAG_${index}) }}`,
          )
          .join("; ");
        const census = (run: string) =>
          planVariablesExpression(() => ({
            jobs: { gate: { steps: [{ run }] } },
          }));
        expect(predicateVariables(census(source))).toEqual(
          literals.map((_, index) => `FLAG_${index}`).toSorted(),
        );
        expect(() => census(source.slice(0, -2))).toThrow(
          "Unterminated GitHub expression",
        );
      },
    ),
  );
});
