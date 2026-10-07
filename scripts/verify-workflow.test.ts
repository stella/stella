import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseVerifyWorkflow, readVerifyWorkflow } from "./verify-workflow";
import { flattenWorkflowSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dirname, "..");
const fixture = (step: Record<string, unknown>) =>
  Bun.YAML.stringify({
    jobs: { first: { steps: [step] } },
  });
const checkStep = {
  name: "Check contract",
  run: "bun scripts/check-contract.ts",
  env: { STELLA_VERIFY: "check" },
};
const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected workflow fixture object");
  }
  return value;
};

for (const { mode, file, marker } of [
  { mode: "verify", file: "ci.yml", marker: "STELLA_VERIFY" },
  { mode: "autofix", file: "autofix.yml", marker: "STELLA_LOCAL_AUTOFIX" },
] as const) {
  test(`${file} selects every marked step and no unmarked step`, () => {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows", file), "utf-8"),
    );
    const expected: { job: string; name: unknown; run: unknown }[] = [];
    for (const [job, value] of Object.entries(
      asRecord(asRecord(parsed)["jobs"]),
    )) {
      const steps = asRecord(value)["steps"];
      if (steps === undefined) {
        continue;
      }
      for (const step of flattenWorkflowSteps(steps)) {
        if (
          step["env"] !== undefined &&
          Object.hasOwn(asRecord(step["env"]), marker)
        ) {
          expected.push({ job, name: step["name"], run: step["run"] });
        }
      }
    }
    expect(expected.length).toBeGreaterThan(0);
    const selected = readVerifyWorkflow({ root, mode });
    const identity = ({
      job,
      name,
      run,
    }: {
      job: string;
      name: unknown;
      run: unknown;
    }) => JSON.stringify({ job, name, run });
    expect(selected.map(identity).toSorted()).toEqual(
      expected.map(identity).toSorted(),
    );
    const firstCheck = selected.findIndex(({ phase }) => phase === "check");
    if (firstCheck !== -1) {
      expect(
        selected.slice(firstCheck).every(({ phase }) => phase === "check"),
      ).toBe(true);
    }
  });
}

describe("workflow marker selection", () => {
  test("nested parallel leaves retain marker selection and phase order", () => {
    const source = Bun.YAML.stringify({
      jobs: {
        first: {
          steps: [
            checkStep,
            {
              parallel: [
                { name: "Unmarked parallel", run: "echo ignored" },
                {
                  name: "Parallel check",
                  run: "echo parallel",
                  env: { STELLA_VERIFY: "check" },
                },
                {
                  parallel: [
                    {
                      name: "Nested preparation",
                      run: "echo prepare",
                      env: { STELLA_VERIFY: "prepare" },
                    },
                    { name: "Unmarked nested action", uses: "example/action" },
                    {
                      name: "Nested check",
                      run: "echo nested",
                      env: { STELLA_VERIFY: "check" },
                    },
                    {
                      name: "Nested fix",
                      run: "echo fix",
                      env: { STELLA_LOCAL_AUTOFIX: "true" },
                    },
                  ],
                },
              ],
            },
            { wait: "all" },
          ],
        },
      },
    });
    expect(
      parseVerifyWorkflow(source, "verify").map(({ name, phase }) => ({
        name,
        phase,
      })),
    ).toEqual([
      { name: "Nested preparation", phase: "prepare" },
      { name: "Check contract", phase: "check" },
      { name: "Parallel check", phase: "check" },
      { name: "Nested check", phase: "check" },
    ]);
    expect(parseVerifyWorkflow(source, "autofix")).toEqual([
      {
        job: "first",
        name: "Nested fix",
        run: "echo fix",
        cwd: ".",
        env: {},
        phase: "prepare",
      },
    ]);
  });

  test("new marked commands enter the plan without a separate registry", () => {
    const source = Bun.YAML.stringify({
      jobs: {
        first: {
          steps: [
            { name: "Unmarked", run: "echo ignored" },
            checkStep,
            {
              name: "Prepare first",
              run: "echo prepare",
              env: { STELLA_VERIFY: "prepare" },
            },
          ],
        },
        second: {
          steps: [
            {
              name: "New check",
              run: "echo newly added",
              env: { STELLA_VERIFY: "check" },
            },
            {
              name: "Prepare second",
              run: "echo prepare second",
              env: { STELLA_VERIFY: "prepare" },
            },
          ],
        },
      },
    });
    expect(parseVerifyWorkflow(source, "verify")).toEqual([
      {
        job: "first",
        name: "Prepare first",
        run: "echo prepare",
        cwd: ".",
        env: {},
        phase: "prepare",
      },
      {
        job: "second",
        name: "Prepare second",
        run: "echo prepare second",
        cwd: ".",
        env: {},
        phase: "prepare",
      },
      {
        job: "first",
        name: "Check contract",
        run: checkStep.run,
        cwd: ".",
        env: {},
        phase: "check",
      },
      {
        job: "second",
        name: "New check",
        run: "echo newly added",
        cwd: ".",
        env: {},
        phase: "check",
      },
    ]);
  });

  test("autofix selects only its own marker and uses the prepare phase", () => {
    const source = Bun.YAML.stringify({
      jobs: {
        fix: {
          steps: [
            checkStep,
            {
              name: "Fix",
              run: "echo fix",
              env: { STELLA_LOCAL_AUTOFIX: "true" },
            },
          ],
        },
      },
    });
    expect(parseVerifyWorkflow(source, "autofix")).toEqual([
      {
        job: "fix",
        name: "Fix",
        run: "echo fix",
        cwd: ".",
        env: {},
        phase: "prepare",
      },
    ]);
  });

  test("inherits run defaults but only reads marked step environment", () => {
    const source = Bun.YAML.stringify({
      env: { CI_ONLY: `\${{ github.token }}` },
      defaults: { run: { shell: "bash", "working-directory": "workflow-dir" } },
      jobs: {
        first: {
          env: { JOB_ONLY: true },
          defaults: { run: { "working-directory": "apps/api" } },
          steps: [
            checkStep,
            {
              ...checkStep,
              name: "Override",
              "working-directory": "packages/cli",
            },
          ],
        },
      },
    });
    const steps = parseVerifyWorkflow(source, "verify");
    expect(steps.map(({ cwd }) => cwd)).toEqual(["apps/api", "packages/cli"]);
    expect(steps.map(({ env }) => env)).toEqual([{}, {}]);
  });

  test("keeps static env and omits context values the runner overrides", () => {
    const step = {
      ...checkStep,
      env: {
        STELLA_VERIFY: "check",
        STATIC: "value",
        EMPTY: "",
        BASE_REF: `\${{ steps.base.outputs.ref }}`,
        BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
        EVENT_NAME: `\${{ github.event_name }}`,
        CHECK_BASE_REF: `\${{ steps.base.outputs.ref }}`,
        RATCHET_BASE_REF: `\${{ steps.base.outputs.ref }}`,
        MERGE_GROUP_BASE_SHA: `\${{ github.event.merge_group.base_sha }}`,
        REPOSITORY: `\${{ github.repository }}`,
        GH_TOKEN: `\${{ github.token }}`,
      },
    };
    expect(
      parseVerifyWorkflow(fixture(step), "verify").map(({ env }) => env),
    ).toEqual([{ STATIC: "value", EMPTY: "" }]);
  });
});

for (const { step, message } of [
  {
    step: { ...checkStep, name: "" },
    message: "name must be a non-empty string",
  },
  {
    step: { ...checkStep, name: 1 },
    message: "name must be a non-empty string",
  },
  {
    step: { ...checkStep, run: undefined },
    message: "run must be a non-empty string",
  },
  {
    step: { ...checkStep, run: true },
    message: "run must be a non-empty string",
  },
  {
    step: { ...checkStep, uses: "some/action" },
    message: "marked steps must use run, not uses",
  },
  { step: { ...checkStep, shell: "sh" }, message: "shell must be bash" },
  { step: { ...checkStep, shell: "bash {0}" }, message: "shell must be bash" },
  {
    step: { ...checkStep, run: `echo \${{ github.sha }}` },
    message: "run must not contain GitHub expressions",
  },
  {
    step: { ...checkStep, "working-directory": `\${{ github.workspace }}` },
    message: "working-directory must not contain GitHub expressions",
  },
  {
    step: { ...checkStep, "working-directory": 2 },
    message: "working-directory must be a non-empty string",
  },
  {
    step: { ...checkStep, env: { STELLA_VERIFY: "later" } },
    message: "STELLA_VERIFY must be 'prepare' or 'check'",
  },
  {
    step: { ...checkStep, env: { STELLA_VERIFY: true } },
    message: "STELLA_VERIFY must be 'prepare' or 'check'",
  },
  {
    step: {
      ...checkStep,
      env: { STELLA_VERIFY: "check", OTHER: `\${{ secrets.TOKEN }}` },
    },
    message: "env OTHER must not contain GitHub expressions",
  },
  {
    step: { ...checkStep, env: { STELLA_VERIFY: "check", OTHER: false } },
    message: "env OTHER must be a string",
  },
  {
    step: { ...checkStep, env: { STELLA_VERIFY: "check", BASE_SHA: 123 } },
    message: "env BASE_SHA must be a string",
  },
]) {
  test(`rejects ${message}`, () => {
    expect(() => parseVerifyWorkflow(fixture(step), "verify")).toThrow(message);
  });
}

test.each([true, false, "false", "check"])(
  "rejects unsupported autofix marker %j",
  (marker) => {
    expect(() =>
      parseVerifyWorkflow(
        fixture({ ...checkStep, env: { STELLA_LOCAL_AUTOFIX: marker } }),
        "autofix",
      ),
    ).toThrow("STELLA_LOCAL_AUTOFIX must be the string 'true'");
  },
);

test("rejects an inherited non-bash shell and dynamic cwd", () => {
  for (const { defaults, message } of [
    { defaults: { run: { shell: "pwsh" } }, message: "shell must be bash" },
    {
      defaults: { run: { "working-directory": `\${{ github.workspace }}` } },
      message: "working-directory must not contain GitHub expressions",
    },
  ]) {
    const source = Bun.YAML.stringify({
      defaults,
      jobs: { first: { steps: [checkStep] } },
    });
    expect(() => parseVerifyWorkflow(source, "verify")).toThrow(message);
  }
});

test("rejects invalid runtime modes and malformed workflow structures", () => {
  expect(() =>
    Reflect.apply(parseVerifyWorkflow, undefined, [
      fixture(checkStep),
      "invalid",
    ]),
  ).toThrow("Unknown workflow mode: invalid");
  expect(() => parseVerifyWorkflow("jobs: []", "verify")).toThrow(
    "Workflow jobs must be an object",
  );
  expect(() =>
    parseVerifyWorkflow("jobs:\n  first:\n    steps: {}", "verify"),
  ).toThrow("Job first steps must be an array");
});
