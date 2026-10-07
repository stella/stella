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
// Frozen normal-profile predicates keep the off contract test independent of Git history.
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
const now = Date.now();
const report = {
  profile: "pilot-v1",
  startedAt: new Date(now - 86_400_000).toISOString(),
  generatedAt: new Date(now - 3_600_000).toISOString(),
  complete: true,
  stopped: false,
  baselineArmToMergeP50Minutes: 10,
  armToMergeP50Minutes: null,
};
type Options = {
  variable?: string;
  event?: string;
  action?: string;
  data?: unknown;
  failure?: boolean;
  provenance?: string;
};
const decide = async ({
  variable = "on",
  event = "pull_request",
  action = "synchronize",
  data = report,
  failure = false,
  provenance = ".github/workflows/ci-pr-pilot-metrics.yml",
}: Options = {}) => {
  const outputs = new Map<string, string>();
  const calls: unknown[] = [];
  await new Script(`(async () => {${policy}\n})()`).runInNewContext({
    Buffer,
    Date,
    setTimeout: (callback: () => void) => callback(),
    process: { env: { CI_PR_DEPTH_PILOT: variable, RUNNER_TEMP: "/unused" } },
    context: {
      eventName: event,
      repo: { owner: "stella", repo: "stella" },
      payload: { action, repository: { default_branch: "main" } },
    },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      info: () => {},
    },
    require: (name: string) => {
      if (name === "node:path") {
        return { join: (...parts: string[]) => parts.join("/") };
      }
      if (name === "node:fs") {
        return {
          mkdtempSync: () => "/unused",
          writeFileSync: () => {},
          rmSync: () => {},
        };
      }
      if (name === "node:child_process") {
        return { execFileSync: () => Buffer.from(JSON.stringify(data)) };
      }
      throw new Error("Unexpected module");
    },
    github: {
      rest: {
        actions: {
          listArtifactsForRepo: async (request: unknown) => {
            calls.push(request);
            if (failure) {
              throw new Error("Lookup failed");
            }
            return {
              data: {
                artifacts: [
                  {
                    id: 10,
                    name: "ci-pr-depth-pilot-v1",
                    expired: false,
                    expires_at: "2099-01-01T00:00:00Z",
                    workflow_run: { id: 99, head_sha: "a" },
                  },
                ],
              },
            };
          },
          getWorkflowRun: async () => ({
            data: {
              path: provenance,
              event: "schedule",
              head_branch: "main",
              head_sha: "a",
              status: "completed",
              conclusion: "success",
            },
          }),
          downloadArtifact: async () => ({ data: new Uint8Array() }),
        },
      },
    },
  });
  return { outputs, calls };
};

const conditionContext = (profile: string, event: string, depth: string) => {
  const values: Record<string, string | boolean> = {
    "github.event_name": event,
    "github.event.pull_request.draft": false,
    "inputs.heavy_only": false,
    "needs.ci-plan.outputs.coverage_profile": profile,
    "needs.ci-plan.outputs.run_required": "true",
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
        const { outputs, calls } = await decide({ variable, event, action });
        expect(outputs.get("coverage_profile")).toBe("normal-v1");
        expect(calls).toHaveLength(0);
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
    const { outputs, calls } = await decide({ action });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
    expect(calls).toHaveLength(0);
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
    const { outputs, calls } = await decide({ event });
    expect(outputs.get("coverage_profile")).toBe("normal-v1");
    expect(calls).toHaveLength(0);
  }
});

test("untrusted, incomplete, stale, expired or slowed pilot evidence retains normal checks", async () => {
  for (const data of [
    null,
    {},
    { ...report, complete: false },
    { ...report, stopped: true },
    { ...report, generatedAt: new Date(now - 37 * 3_600_000).toISOString() },
    { ...report, startedAt: new Date(now - 7 * 86_400_000).toISOString() },
    { ...report, armToMergeP50Minutes: 30.01 },
    { ...report, baselineArmToMergeP50Minutes: null },
  ]) {
    expect((await decide({ data })).outputs.get("coverage_profile")).toBe(
      "normal-v1",
    );
  }
  for (const options of [
    { failure: true },
    { provenance: ".github/workflows/ci.yml" },
  ]) {
    expect((await decide(options)).outputs.get("coverage_profile")).toBe(
      "normal-v1",
    );
  }
  expect(
    (
      await decide({ data: { ...report, armToMergeP50Minutes: 30 } })
    ).outputs.get("coverage_profile"),
  ).toBe("pilot-fast-v1");
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
