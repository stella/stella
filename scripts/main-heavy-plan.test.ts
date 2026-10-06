import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import eventPolicies from "../.github/ci-event-policy.json" with { type: "json" };
import {
  contextFromNested,
  evaluate as evaluateExpression,
  UNKNOWN,
} from "./github-expression";
import { mainHeavyJobs, thinJobs } from "./main-heavy-plan";

const root = new URL("../", import.meta.url).pathname;
const source = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflowSchema = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(v.array(stepSchema)),
    }),
  ),
});
const workflow = v.parse(workflowSchema, Bun.YAML.parse(source));
const THIN_JOBS = thinJobs(workflow);
const heavy = mainHeavyJobs(workflow);
const outcome = workflow.jobs["ci-result"]?.steps?.find(
  ({ name }) => name === "Evaluate CI outcome",
);
const outcomeEnv = outcome?.env;
if (!outcome?.run || !outcomeEnv) {
  panic("Missing CI outcome step");
}
const scopes = v.parse(
  v.record(v.string(), v.nullable(v.string())),
  JSON.parse(outcomeEnv["JOB_SCOPES"] ?? ""),
);
const expectedHeavy = Object.keys(scopes).filter(
  (job) => !THIN_JOBS.some((thin) => thin === job),
);
const ciNeeds = v.parse(v.array(v.string()), workflow.jobs["ci-result"]?.needs);

const selected = (condition: string, context: object) => {
  const result = evaluateExpression(condition, contextFromNested(context));
  if (result === UNKNOWN) {
    panic(`Unresolved heavy-plan expression: ${condition}`);
  }
  return Boolean(result);
};
const context = (
  event: string,
  heavyOnly: boolean,
  plan: Record<string, string>,
) => ({
  github: {
    event_name: event,
    event: { pull_request: { draft: false, labels: [] } },
  },
  inputs: { heavy_only: heavyOnly },
  needs: Object.fromEntries(
    ciNeeds.map((job) => [
      job,
      {
        result:
          heavyOnly && THIN_JOBS.some((thin) => thin === job)
            ? "skipped"
            : "success",
        outputs: job === "ci-plan" ? { run_required: "true", ...plan } : {},
      },
    ]),
  ),
  always: () => true,
  cancelled: () => false,
});

const planned = (plan: Record<string, string>, job: string) => {
  const scope = scopes[job];
  return scope === null || (scope !== undefined && plan[scope] === "true");
};
const allPlanned = Object.fromEntries(
  Object.values(scopes).flatMap((scope) =>
    scope === null ? [] : [[scope, "true"]],
  ),
);
const heavyPlan = {
  ...allPlanned,
  trusted: "true",
  suite_depth: "full",
  queue_depth: "full",
  fix_tests_on_base_required: "false",
};

const heavyEvents = ["push", "schedule", "workflow_dispatch"] as const;

const assertCoverage = (jobs: string[], event: string) => {
  expect(new Set(jobs)).toEqual(new Set(expectedHeavy));
  const scheduled = Object.entries(workflow.jobs)
    .filter(
      ([job, body]) =>
        job !== "ci-plan" &&
        job !== "ci-result" &&
        ciNeeds.includes(job) &&
        selected(body.if ?? "true", context(event, true, heavyPlan)),
    )
    .map(([job]) => job);
  expect(new Set(scheduled)).toEqual(
    new Set(jobs.filter((job) => planned(heavyPlan, job))),
  );
};

test("main heavy scheduling equals the gated jobs minus thin checks", () => {
  for (const event of heavyEvents) {
    assertCoverage(heavy, event);
    for (const thin of THIN_JOBS) {
      expect(
        selected(
          workflow.jobs[thin]?.if ?? "true",
          context(event, true, heavyPlan),
        ),
        `${event}/${thin}`,
      ).toBe(false);
    }
  }
  const planner = workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Derive heavy jobs",
  );
  expect(planner?.run).toContain(
    'git show "$WORKFLOW_SHA:.github/workflows/ci.yml"',
  );
  expect(planner?.run).toContain(
    'git show "$WORKFLOW_SHA:scripts/main-heavy-plan.ts"',
  );
  expect(planner?.env?.["WORKFLOW_SHA"]).toBe(`\${{ github.workflow_sha }}`);
});

test("production web artifacts have at most one selected producer", () => {
  const producers = Object.entries(workflow.jobs).filter(([, body]) =>
    body.steps?.some(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.["name"] === "e2e-web-build",
    ),
  );
  expect(producers.map(([job]) => job).toSorted()).toEqual([
    "heavy-web-build",
    "web-build",
  ]);
  for (const event of ["pull_request", "merge_group", ...heavyEvents]) {
    for (const heavyOnly of [false, true]) {
      for (const required of ["true", "false"]) {
        for (const queueDepth of ["full", "thin"]) {
          const value = context(event, heavyOnly, {
            ...heavyPlan,
            queue_depth: queueDepth,
            web_build_required: required,
            heavy_web_build_required: heavyOnly ? required : "false",
          });
          const active = producers
            .filter(([, body]) => selected(body.if ?? "true", value))
            .map(([job]) => job);
          expect(
            active.length,
            `${event}/${heavyOnly}/${required}/${queueDepth}`,
          ).toBeLessThanOrEqual(1);
          if (
            event === "workflow_dispatch" &&
            heavyOnly &&
            required === "true" &&
            queueDepth === "full"
          ) {
            expect(active).toEqual(["heavy-web-build"]);
          }
        }
      }
    }
  }
});

test("main heavy runs execute the release compiler exactly when VERSION is planned", () => {
  for (const event of heavyEvents) {
    for (const required of ["true", "false"]) {
      expect(
        selected(
          workflow.jobs["release-typecheck"]?.if ?? "true",
          context(event, true, {
            ...heavyPlan,
            release_typecheck_required: required,
          }),
        ),
        `${event}/${required}`,
      ).toBe(required === "true");
    }
  }
});

test("completed-depth reuse skips every nonstructural main heavy job", () => {
  for (const event of heavyEvents) {
    const reused = context(event, true, {
      ...heavyPlan,
      run_required: "false",
    });
    for (const [job, body] of Object.entries(workflow.jobs)) {
      if (job === "ci-plan" || job === "ci-result") {
        continue;
      }
      expect(selected(body.if ?? "true", reused), `${event}/${job}`).toBe(
        false,
      );
    }
  }
});

test("dropping a heavy job cannot pass the scheduling invariant", () => {
  const removed = heavy.at(0);
  expect(removed).toBeDefined();
  for (const event of heavyEvents) {
    expect(() =>
      assertCoverage(
        heavy.filter((job) => job !== removed),
        event,
      ),
    ).toThrow("expect(received)");
  }
});

test("heavy planning rejects gate drift instead of omitting a job", () => {
  const mutated = structuredClone(workflow);
  const needs = v.parse(v.array(v.string()), mutated.jobs["ci-result"]?.needs);
  const result = mutated.jobs["ci-result"];
  if (!result) {
    panic("Missing result job");
  }
  result.needs = needs.filter((job) => job !== heavy.at(0));
  expect(() => mainHeavyJobs(mutated)).toThrow(
    "ci-result dependencies and JOB_SCOPES disagree",
  );
});

test("heavy event policies exclude pull requests and preserve existing full certification", () => {
  const base = Bun.spawnSync(["git", "merge-base", "origin/main", "HEAD"], {
    cwd: root,
  });
  expect(base.exitCode).toBe(0);
  const previous = Bun.spawnSync(
    [
      "git",
      "show",
      `${base.stdout.toString().trim()}:.github/workflows/ci.yml`,
    ],
    { cwd: root },
  );
  expect(previous.exitCode).toBe(0);
  const original = v.parse(
    workflowSchema,
    Bun.YAML.parse(previous.stdout.toString()),
  );
  let compared = 0;
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    for (const depth of ["fast", "full"]) {
      for (const required of ["true", "false"]) {
        const plan = Object.fromEntries(
          Object.keys(allPlanned).map((scope) => [scope, required]),
        );
        plan["trusted"] = "true";
        plan["suite_depth"] = depth;
        plan["queue_depth"] = "full";
        plan["heavy_web_build_required"] = "false";
        // Queue policies intentionally remove PR execution. Existing non-PR
        // certification stays unchanged except for the added queue route smoke.
        for (const [job, body] of Object.entries(original.jobs)) {
          const current = workflow.jobs[job]?.if;
          if (current?.includes("inputs.heavy_only") !== true) {
            continue;
          }
          compared += 1;
          let expected = selected(
            body.if ?? "true",
            context(event, false, plan),
          );
          const queueJob = Object.entries(eventPolicies.jobs).some(
            ([key, policy]) =>
              key === `ci.yml/${job}` &&
              (policy === "queue" || policy === "main"),
          );
          if (event === "pull_request" && queueJob) {
            expected = false;
          }
          if (job === "route-smoke" && event === "merge_group") {
            expected = required === "true";
          }
          expect(
            selected(current, context(event, false, plan)),
            `${event}/${depth}/${required}/${job}`,
          ).toBe(expected);
        }
        expect(
          selected(
            workflow.jobs["heavy-web-build"]?.if ?? "true",
            context(event, false, plan),
          ),
        ).toBe(false);
      }
    }
  }
  expect(compared).toBeGreaterThan(0);
}, 30_000);

type EvaluateOptions = {
  event: string;
  jobName?: string;
  result: string;
  isPlanned?: boolean;
  planResult?: string;
  thinResult?: string;
};
const evaluate = ({
  event,
  jobName = "mobile-build",
  result,
  isPlanned = true,
  planResult = "success",
  thinResult = "skipped",
}: EvaluateOptions) => {
  const needs = Object.fromEntries(
    ciNeeds.map((job) => {
      let jobResult = "success";
      if (job === "ci-plan") {
        jobResult = planResult;
      } else if (THIN_JOBS.some((thin) => thin === job)) {
        jobResult = thinResult;
      }
      return [
        job,
        {
          result: jobResult,
          outputs:
            job === "docker-checks"
              ? {
                  "agent-sandbox-docker": "success",
                  "api-image-deps": "success",
                }
              : {},
        },
      ];
    }),
  );
  const job = needs[jobName];
  const scope = scopes[jobName];
  if (!job || typeof scope !== "string") {
    panic(`Missing scoped job: ${jobName}`);
  }
  job.result = result;
  const run = Bun.spawnSync(["bash", "-e", "-c", outcome.run ?? "exit 2"], {
    cwd: root,
    env: {
      ...process.env,
      ...outcomeEnv,
      EVENT: event,
      HEAVY_ONLY: "true",
      HEAVY_JOBS: JSON.stringify(heavy),
      QUEUE_DEPTH: "full",
      THIN_JOBS: JSON.stringify(THIN_JOBS),
      NEEDS: JSON.stringify(needs),
      PLAN: JSON.stringify({
        ...heavyPlan,
        [scope]: String(isPlanned),
      }),
      PLAN_RESULT: planResult,
      TRUSTED: "true",
      SUITE_DEPTH: "full",
    },
  });
  return run.exitCode;
};

test("main heavy aggregation rejects failures, cancellations, timeouts and planned skips", () => {
  for (const event of heavyEvents) {
    for (const result of [
      "success",
      "failure",
      "skipped",
      "cancelled",
      "timed_out",
    ]) {
      for (const isPlanned of [true, false]) {
        const accepted =
          result === "success" || (result === "skipped" && !isPlanned);
        expect(
          evaluate({ event, result, isPlanned }),
          `${event}/${result}/${isPlanned}`,
        ).toBe(accepted ? 0 : 1);
      }
    }
    for (const planResult of ["failure", "cancelled"]) {
      expect(
        evaluate({ event, result: "success", planResult }),
        `${event}/plan/${planResult}`,
      ).toBe(1);
    }
  }
}, 30_000);

test("the reusable result gate allows skipped thin checks in heavy mode", () => {
  for (const event of heavyEvents) {
    expect(evaluate({ event, result: "success" }), event).toBe(0);
  }
}, 30_000);

test("heavy scope selection plans full suites even on an empty main diff", () => {
  const scope = workflow.jobs["ci-plan"]?.steps?.find(
    ({ name }) => name === "Check changed file scope",
  );
  if (!scope?.run) {
    panic("Missing changed file scope");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "main-heavy-plan-"));
  const output = path.join(directory, "output");
  try {
    for (const event of heavyEvents) {
      writeFileSync(output, "");
      const run = Bun.spawnSync(["bash", "-e", "-c", scope.run], {
        cwd: root,
        env: {
          ...process.env,
          EVENT_NAME: event,
          HEAVY_ONLY: "true",
          SUITE_DEPTH: "full",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
        },
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const outputs = Object.fromEntries(
        readFileSync(output, "utf-8")
          .trim()
          .split("\n")
          .map((line) => line.split("=", 2)),
      );
      for (const key of [
        "desktop_rust_checks_required",
        "docker_checks_required",
        "api_image_smoke_required",
        "e2e_production_required",
        "e2e_core_required",
        "mobile_build_required",
        "route_smoke_required",
        "windows_scripts_required",
      ]) {
        expect(outputs[key], `${event}/${key}`).toBe("true");
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 30_000);

test("every main heavy event requires the planned compiler to succeed", () => {
  for (const event of heavyEvents) {
    for (const result of [
      "success",
      "failure",
      "skipped",
      "cancelled",
      "timed_out",
    ]) {
      expect(
        evaluate({ event, jobName: "release-typecheck", result }),
        `${event}/${result}`,
      ).toBe(result === "success" ? 0 : 1);
    }
    expect(
      evaluate({
        event,
        jobName: "release-typecheck",
        result: "skipped",
        isPlanned: false,
      }),
      `${event}/unplanned`,
    ).toBe(0);
  }
}, 30_000);
