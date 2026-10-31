import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import {
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  PERIODIC_RELEASE_TYPECHECK_EVENTS,
} from "./ci-plan-scope";
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

const plan = ({
  event,
  heavyOnly,
  versionChanged = false,
}: {
  event: string;
  heavyOnly: boolean;
  versionChanged?: boolean;
}) =>
  computeChangedFileScope(
    {
      changedFiles: versionChanged ? ["VERSION"] : [],
      comparisonBase: "base",
      scopeUnknown: false,
      eventName: event,
      suiteDepth: "full",
      heavyOnly,
      prTitle: "",
      versionChangedInHead: versionChanged,
    },
    {
      ...DEFAULT_DETECTORS,
      packageChecks: () => true,
      landingBuild: () => false,
      landingDeploy: () => false,
      desktopBrowser: () => false,
    },
  ).release_typecheck_required;

const assertPeriodic = () => {
  const required = plan({
    event: "schedule",
    heavyOnly: caller.jobs.suites.with.heavy_only,
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
        "inputs.pr_depth_only": false,
        "needs.ci-plan.outputs.release_typecheck_required": required,
        "needs.ci-plan.outputs.trusted": "true",
        "needs.ci-plan.outputs.run_required": "true",
        // Scheduled main runs keep the queue-only suites.
        "needs.ci-plan.outputs.heavy_proof": "true",
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
  expect(PERIODIC_RELEASE_TYPECHECK_EVENTS).toEqual(["schedule"]);
  expect(plan({ event: "schedule", heavyOnly: true })).toBe("true");
  expect(plan({ event: "push", heavyOnly: true })).toBe("false");
});

test("replacing the caller event binding with workflow_call loses the periodic trigger", () => {
  expect(plannerEnv["EVENT_NAME"]).toMatch(/^\$\{\{ github\.event_name \}\}$/u);
  expect(plan({ event: "workflow_call", heavyOnly: true })).toBe("false");
});
