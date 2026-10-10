import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { pilotFastJobs } from "./ci-pr-pilot-plan";
import { evaluate } from "./github-expression";

const schema = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      steps: v.optional(
        v.array(
          v.looseObject({
            id: v.optional(v.string()),
            name: v.string(),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
            env: v.optional(v.record(v.string(), v.string())),
            with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
          }),
        ),
        [],
      ),
    }),
  ),
});
const source = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf-8",
);
const workflow = v.parse(schema, Bun.YAML.parse(source));
// Frozen pre-pilot predicates keep the off contract test independent of Git history.
const original = v.parse(
  schema,
  JSON.parse(
    readFileSync(
      new URL("fixtures/ci-pr-pilot-normal-plan.json", import.meta.url),
      "utf-8",
    ),
  ),
);
const planner = workflow.jobs["ci-plan"];
if (!planner) {
  throw new Error("Missing pilot planner");
}
const policy = planner.steps.find((step) => step.id === "pilot")?.with?.script;
if (!policy) {
  throw new Error("Missing pilot policy");
}
const fastJobs = (input: unknown) => {
  const result = pilotFastJobs(input);
  if (result.status === "invalid") {
    throw new Error(result.message);
  }
  return result.jobs;
};
const now = Date.parse("2026-10-09T12:00:00Z");
class FixedDate extends Date {
  static override now = () => now;
}
type Options = {
  variable?: string;
  certifiedUntil?: string;
  event?: string;
  action?: string;
};
const decide = async ({
  variable = "on",
  certifiedUntil = "2026-10-10T12:00:00Z",
  event = "pull_request",
  action = "synchronize",
}: Options = {}) => {
  const outputs = new Map<string, string>();
  const notices: string[] = [];
  await new Script(`(async () => {${policy}\n})()`).runInNewContext({
    Date: FixedDate,
    process: {
      env: {
        CI_PR_DEPTH_PILOT: variable,
        CI_PR_DEPTH_PILOT_CERTIFIED_UNTIL: certifiedUntil,
      },
    },
    context: { eventName: event, payload: { action } },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      notice: (message: string) => notices.push(message),
    },
  });
  return { outputs, notices };
};

test("coverage profile requires a current repository certification", async () => {
  const cases = [
    {
      name: "variable off",
      options: { variable: "off" },
      expected: "normal-v1",
    },
    {
      name: "certification missing",
      options: { certifiedUntil: "" },
      expected: "normal-v1",
    },
    {
      name: "certification malformed",
      options: { certifiedUntil: "tomorrow" },
      expected: "normal-v1",
    },
    {
      name: "certification past",
      options: { certifiedUntil: "2026-10-09T11:59:59Z" },
      expected: "normal-v1",
    },
    {
      name: "certification too distant",
      options: { certifiedUntil: "2026-10-11T12:00:01Z" },
      expected: "normal-v1",
    },
    {
      name: "certification valid",
      options: { certifiedUntil: "2026-10-11T12:00:00Z" },
      expected: "pilot-fast-v1",
    },
    {
      name: "event not pull request",
      options: { event: "push" },
      expected: "normal-v1",
    },
    {
      name: "action not eligible",
      options: { action: "reopened" },
      expected: "normal-v1",
    },
  ] as const;
  for (const { name, options, expected } of cases) {
    const { outputs, notices } = await decide(options);
    expect(outputs.get("coverage_profile"), name).toBe(expected);
    expect(notices, name).toEqual([`coverage_profile=${expected}`]);
  }
});

const conditionContext = (profile: string, event: string, depth: string) => {
  const values: Record<string, string | boolean> = {
    "github.event_name": event,
    "github.event.pull_request.draft": false,
    "inputs.heavy_only": false,
    "inputs.pr_depth_only": false,
    "vars.CI_POSTGRES_PR_SELECTION": "",
    "needs.ci-plan.outputs.coverage_profile": profile,
    "needs.ci-plan.outputs.run_required": "true",
    "needs.ci-plan.outputs.pr_depth_reused": "false",
    "needs.ci-plan.outputs.pilot_fast_jobs": JSON.stringify(fastJobs(workflow)),
    "needs.ci-plan.outputs.suite_depth": depth,
    "needs.ci-plan.outputs.queue_depth": "full",
    "needs.ci-plan.outputs.trusted": "true",
  };
  for (const name of Object.keys(workflow.jobs)) {
    values[`needs.${name}.result`] = "success";
  }
  const scopes = source.matchAll(
    /needs\.ci-plan\.outputs\.([a-z_]+_required)/gu,
  );
  for (const match of scopes) {
    const scope = match.at(1);
    if (scope === undefined) {
      throw new Error("Missing CI scope capture");
    }
    values[`needs.ci-plan.outputs.${scope}`] = "true";
  }
  values["needs.ci-plan.outputs.corpus_suites_required"] = "false";
  return {
    values,
    status: { success: true, failure: false, cancelled: false },
  };
};

test("off and unset preserve today's job plan across every event and depth", async () => {
  expect(Object.keys(original.jobs).toSorted()).toEqual(
    Object.keys(workflow.jobs).toSorted(),
  );
  for (const variable of ["", "off"]) {
    for (const event of [
      "pull_request",
      "merge_group",
      "workflow_dispatch",
      "push",
    ]) {
      for (const action of [
        "opened",
        "synchronize",
        "reopened",
        "labeled",
        "unlabeled",
        "ready_for_review",
        "auto_merge_enabled",
        "enqueued",
      ]) {
        const { outputs } = await decide({ variable, event, action });
        expect(outputs.get("coverage_profile")).toBe("normal-v1");
        for (const depth of ["fast", "full"]) {
          const context = conditionContext("normal-v1", event, depth);
          for (const [name, job] of Object.entries(original.jobs)) {
            expect(
              evaluate(workflow.jobs[name]?.if ?? "true", context),
              name,
            ).toEqual(evaluate(job.if ?? "true", context));
          }
        }
      }
    }
  }
});

test("Postgres PR execution follows explicit opt-in in either pilot profile", () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    for (const selection of ["", "off", "on"]) {
      const context = conditionContext(profile, "pull_request", "fast");
      context.values["vars.CI_POSTGRES_PR_SELECTION"] = selection;
      expect(
        evaluate(workflow.jobs["service-suites"]?.if ?? "false", context),
      ).toBe(selection === "on");
    }
  }
});

test("corpus-only PRs start only corpus service steps", () => {
  const context = conditionContext("normal-v1", "pull_request", "fast");
  for (const key of Object.keys(context.values)) {
    if (key.endsWith("_required")) {
      context.values[key] = "false";
    }
  }
  context.values["needs.ci-plan.outputs.run_required"] = "true";
  context.values["needs.ci-plan.outputs.service_suites_required"] = "true";
  context.values["needs.ci-plan.outputs.corpus_suites_required"] = "true";
  const service = workflow.jobs["service-suites"];
  expect(evaluate(service?.if ?? "false", context)).toBe(true);
  const selectedSteps = (service?.steps ?? [])
    .filter((step) => evaluate(step.if ?? "true", context))
    .map((step) => step.name);
  expect(selectedSteps).toContain("Run corpus engine suites");
  expect(selectedSteps).not.toContain("Run Postgres-gated API suites");
  expect(selectedSteps).not.toContain("Run Valkey-gated API suites");
});

test("docs-only PRs retain Markdown checks in every pilot coverage profile", () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    const context = conditionContext(profile, "pull_request", "fast");
    for (const key of Object.keys(context.values)) {
      if (key.endsWith("_required")) {
        context.values[key] = "false";
      }
    }
    context.values["needs.ci-plan.outputs.run_required"] = "true";
    context.values["needs.ci-plan.outputs.docs_checks_required"] = "true";
    expect(fastJobs(workflow)).toContain("ci-checks-docs");
    const scheduled = Object.entries(workflow.jobs)
      .filter(([name]) => !["ci-plan", "ci-result"].includes(name))
      .filter(([, job]) => evaluate(job.if ?? "true", context) === true)
      .map(([name]) => name);
    expect(scheduled).toEqual(["ci-checks-docs"]);
  }
});

test("pilot pushes execute only the fast allowlist and its generated-input prerequisite", async () => {
  const { outputs } = await decide();
  expect(outputs.get("coverage_profile")).toBe("pilot-fast-v1");
  const allowed = fastJobs(workflow);
  const context = conditionContext("pilot-fast-v1", "pull_request", "fast");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!allowed.includes(name)) {
      expect(evaluate(job.if ?? "true", context), name).toBe(false);
    }
    if (
      allowed.includes(name) &&
      evaluate(
        original.jobs[name]?.if ?? "true",
        conditionContext("normal-v1", "pull_request", "fast"),
      ) === true
    ) {
      expect(evaluate(job.if ?? "true", context), name).toBe(true);
    }
    if (!allowed.includes(name) || name === "ci-result") {
      continue;
    }
    const needs =
      typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    for (const prerequisite of needs) {
      expect(allowed, name).toContain(prerequisite);
    }
  }
});

test("ready and auto-merge arm select exactly the normal PR plan", async () => {
  for (const action of ["ready_for_review", "auto_merge_enabled"]) {
    const { outputs } = await decide({ action });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
  }
  const full = conditionContext("normal-v1", "pull_request", "fast");
  const reference = conditionContext("normal-v1", "pull_request", "fast");
  for (const [name, job] of Object.entries(original.jobs)) {
    if (evaluate(job.if ?? "true", reference) === true) {
      expect(evaluate(workflow.jobs[name]?.if ?? "true", full), name).toBe(
        true,
      );
    }
  }
});

test("main and queue ignore the pilot switch", async () => {
  for (const event of ["merge_group", "push", "workflow_dispatch"]) {
    const { outputs } = await decide({ event });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
  }
});

test("the prerequisite census rejects every undecided new job and every deferred dependency", () => {
  expect(fastJobs(workflow)).toContain("ci-generated-sources");
  expect(
    pilotFastJobs({ jobs: { ...workflow.jobs, future: {} } }),
  ).toMatchObject({
    status: "invalid",
    message: "Unclassified pilot job: future",
  });
  for (const dependency of [
    "api-image-smoke",
    "web-build",
    "ci-browser",
    "service-suites",
  ]) {
    expect(
      pilotFastJobs({
        jobs: {
          ...workflow.jobs,
          "ci-tests": { needs: ["ci-plan", dependency] },
        },
      }),
    ).toMatchObject({
      status: "invalid",
      message: `Pilot prerequisite is deferred: ${dependency}`,
    });
  }
});

test("pilot-fast aggregation requires its planned jobs and accepts deferred skips", () => {
  const result = workflow.jobs["ci-result"];
  const aggregation = result?.steps.find(
    (step) => step.name === "Evaluate CI outcome",
  );
  if (!aggregation?.run || !aggregation.env || !Array.isArray(result?.needs)) {
    throw new Error("Missing result aggregation contract");
  }
  const run = aggregation.run;
  const selected = fastJobs(workflow);
  expect(selected).toContain("ci-plan");
  expect(selected).toContain("ci-result");
  expect(result.needs).not.toContain("ci-result");
  const selectedDependencies = result.needs.filter((job) =>
    selected.includes(job),
  );
  const deferredDependencies = result.needs.filter(
    (job) => !selected.includes(job),
  );
  expect(selectedDependencies.length).toBeGreaterThan(1);
  expect(deferredDependencies.length).toBeGreaterThan(0);
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(aggregation.env["JOB_SCOPES"] ?? "null"),
  );
  const plan = Object.fromEntries(
    Object.values(scopes)
      .filter((scope) => scope !== null)
      .map((scope) => [scope, "true"]),
  );
  const successful = Object.fromEntries(
    result.needs.map((job) => [
      job,
      { result: selected.includes(job) ? "success" : "skipped" },
    ]),
  );
  const aggregate = (needs: typeof successful) =>
    Bun.spawnSync(["bash", "-c", run], {
      env: {
        ...process.env,
        ...aggregation.env,
        COVERAGE_PROFILE: "pilot-fast-v1",
        PILOT_FAST_JOBS: JSON.stringify(selected),
        NEEDS: JSON.stringify(needs),
        PLAN: JSON.stringify(plan),
        PLAN_RESULT: "success",
        TRUSTED: "true",
        EVENT: "pull_request",
        SUITE_DEPTH: "fast",
        QUEUE_DEPTH: "full",
        QUEUE_VALIDATION: "false",
        HEAVY_ONLY: "false",
        RUN_REQUIRED: "true",
      },
    });
  // ci-result remains in the profile but is absent from its own dependency map.
  expect(successful).not.toHaveProperty("ci-result");
  const passed = aggregate(successful);
  expect(passed.exitCode, passed.stderr.toString()).toBe(0);
  for (const job of selectedDependencies) {
    for (const outcome of ["skipped", "failure"]) {
      const failed = aggregate({ ...successful, [job]: { result: outcome } });
      expect(
        failed.exitCode,
        `${job}/${outcome}: ${failed.stdout.toString()}`,
      ).toBe(1);
    }
  }
});
