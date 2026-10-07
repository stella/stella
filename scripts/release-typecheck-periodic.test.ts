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
const script =
  workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Check changed file scope",
  )?.run ?? panic("Missing changed-file planner");
type PlanOptions = {
  event: string;
  heavyOnly: boolean;
  versionChanged?: boolean;
  candidate?: string;
};
const plan = ({
  event,
  heavyOnly,
  versionChanged = false,
  candidate = script,
}: PlanOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "periodic-typecheck-"));
  const output = path.join(directory, "output");
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-euc",
        `git() { if [[ "$*" == *--quiet* ]]; then return "$VERSION_DIFF"; fi; }\n${candidate}`,
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          EVENT_NAME: event,
          BASE_REF: "main",
          PR_TITLE: "ordinary change",
          SUITE_DEPTH: "full",
          HEAVY_ONLY: String(heavyOnly),
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
const assertPeriodic = (candidate = script) => {
  const required = plan({ event: "schedule", heavyOnly: true, candidate });
  expect(
    required,
    "non-release scheduled heavy runs must plan the full compiler",
  ).toBe("true");
  expect(
    evaluate(workflow.jobs["release-typecheck"]?.if ?? "false", {
      values: {
        "github.event_name": "schedule",
        "inputs.heavy_only": true,
        "needs.ci-plan.outputs.release_typecheck_required": required,
        "needs.ci-plan.outputs.trusted": "true",
        "needs.ci-plan.outputs.run_required": "true",
        "needs.ci-plan.outputs.queue_depth": "full",
      },
    }),
  ).toBe(true);
};

test("hourly main-heavy plans and runs release typechecks without a VERSION change", () => {
  const caller = v.parse(
    v.looseObject({
      on: v.looseObject({ schedule: v.array(v.object({ cron: v.string() })) }),
      jobs: v.looseObject({
        suites: v.looseObject({
          with: v.looseObject({ heavy_only: v.literal(true) }),
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
  expect(
    caller.on.schedule.some(({ cron }) => /^\d+ \* \* \* \*$/u.test(cron)),
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
