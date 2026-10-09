import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { evaluate } from "./github-expression";

const workflow = v.parse(
  v.looseObject({
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        steps: v.optional(
          v.array(
            v.looseObject({
              name: v.optional(v.string()),
              run: v.optional(v.string()),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        ),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const plannerStep =
  workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Check changed file scope",
  ) ?? panic("Missing changed-file planner");
const script = plannerStep.run ?? panic("Missing planner script");
const plannerEnv = plannerStep.env ?? panic("Missing planner env");
const caller = v.parse(
  v.looseObject({
    on: v.looseObject({ schedule: v.array(v.object({ cron: v.string() })) }),
    jobs: v.looseObject({
      suites: v.looseObject({
        uses: v.literal("./.github/workflows/ci.yml"),
        with: v.looseObject({
          heavy_only: v.literal(true),
          depth: v.literal("full"),
          sha: v.string(),
        }),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/main-heavy.yml", import.meta.url),
      "utf-8",
    ),
  ),
);

type PlanOptions = {
  event: string;
  heavyOnly: boolean;
  versionChanged?: boolean;
  candidate?: string;
  bindings?: Record<string, string>;
  depth?: string;
};
const plan = ({
  event,
  heavyOnly,
  versionChanged = false,
  candidate = script,
  bindings = plannerEnv,
  depth = "full",
}: PlanOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "periodic-typecheck-"));
  const output = path.join(directory, "output");
  try {
    const env = Object.fromEntries(
      Object.entries(bindings).map(([name, expression]) => {
        const value = evaluate(expression, {
          values: {
            "github.event_name": event,
            "github.base_ref": "main",
            "github.event.pull_request.title": "ordinary change",
            "steps.depth.outputs.suite_depth": depth,
            "inputs.heavy_only": heavyOnly,
          },
        });
        if (
          typeof value !== "string" &&
          typeof value !== "boolean" &&
          typeof value !== "number"
        ) {
          panic(`Planner env ${name} did not resolve to a scalar`);
        }
        return [name, String(value)];
      }),
    );
    const result = Bun.spawnSync(
      [
        "bash",
        "-euc",
        `git() { if [[ "$*" == *--quiet* ]]; then return "$VERSION_DIFF"; fi; }\n${candidate}`,
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          ...env,
          VERSION_DIFF: versionChanged ? "1" : "0",
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(output, "utf-8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return (
      outputs["release_typecheck_required"] ??
      panic("Planner omitted release_typecheck_required")
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const assertPeriodic = (candidate = script, bindings = plannerEnv) => {
  const required = plan({
    event: "schedule",
    heavyOnly: caller.jobs.suites.with.heavy_only,
    depth: caller.jobs.suites.with.depth,
    candidate,
    bindings,
  });
  expect(
    required,
    "non-release scheduled heavy runs must plan the full compiler",
  ).toBe("true");
  expect(
    evaluate(workflow.jobs["release-typecheck"]?.if ?? "false", {
      values: {
        "github.event_name": "schedule",
        "inputs.heavy_only": caller.jobs.suites.with.heavy_only,
        "needs.ci-plan.outputs.release_typecheck_required": required,
        "needs.ci-plan.outputs.trusted": "true",
        "needs.ci-plan.outputs.run_required": "true",
        "needs.ci-plan.outputs.queue_depth": "full",
      },
    }),
  ).toBe(true);
};

test("scheduled main-heavy plans and runs release typechecks without a VERSION change", () => {
  expect(
    caller.on.schedule.some(({ cron }) => /^\d+ \S+ \* \* \*$/u.test(cron)),
  ).toBe(true);
  assertPeriodic();
  for (const event of ["push", "workflow_dispatch"]) {
    expect(plan({ event, heavyOnly: true })).toBe("false");
    expect(plan({ event, heavyOnly: true, versionChanged: true })).toBe("true");
  }
  expect(plan({ event: "pull_request", heavyOnly: false })).toBe("false");
});

test("restoring VERSION-only planning loses the non-release compiler trigger", () => {
  const mutant = script.replace('[[ "$EVENT_NAME" == schedule ]] || ', "");
  expect(mutant).not.toBe(script);
  expect(() => assertPeriodic(mutant)).toThrow(
    "non-release scheduled heavy runs must plan the full compiler",
  );
});

test("replacing the caller event binding with workflow_call loses the periodic trigger", () => {
  expect(plannerEnv["EVENT_NAME"]).toMatch(/^\$\{\{ github\.event_name \}\}$/u);
  expect(() =>
    assertPeriodic(script, {
      ...plannerEnv,
      EVENT_NAME: "'workflow_call'",
    }),
  ).toThrow("non-release scheduled heavy runs must plan the full compiler");
});
