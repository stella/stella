import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { createSha256 } from "@stll/sha256/node";

import { pilotQueueJobs } from "./ci-pr-pilot-plan";
import { contextWithPlanOutputs, evaluate } from "./github-expression";
import { thinJobs } from "./main-heavy-plan";

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
});
const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        outputs: v.optional(v.record(v.string(), v.string()), {}),
        steps: v.optional(v.array(stepSchema), []),
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
const jobs = workflow.jobs;
const planner = jobs["ci-plan"];
const result = jobs["ci-result"];
if (!planner || !result) {
  throw new Error("Missing CI structural jobs");
}
const lookup = planner.steps.find((step) => step.id === "completed-depth")?.with
  ?.script;
const aggregate = result.steps.find(
  (step) => step.name === "Evaluate CI outcome",
)?.run;
if (!lookup || !aggregate) {
  throw new Error("Missing completion-depth contract");
}
const labels: { name: string }[] = [];
const pr = {
  number: 123,
  title: "fix: example",
  body: "Test evidence",
  head: { sha: "a".repeat(40), repo: { id: 456 } },
  base: { sha: "b".repeat(40) },
  labels,
};
const scope = createSha256()
  .update(JSON.stringify([pr.title, pr.body, false]))
  .digest("hex");
const marker = (depth: string, profile = "normal-v1") =>
  `ci-completed-v4-${profile}-123-456-${pr.head.sha}-${pr.base.sha}-${depth}-${scope}`;
const artifact = (depth: string, profile = "normal-v1") => ({
  name: marker(depth, profile),
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: 99, head_sha: pr.head.sha, head_repository_id: 456 },
});
const successfulRun = {
  id: 99,
  head_sha: pr.head.sha,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
};
type LookupOptions = {
  depth?: string;
  profile?: string;
  action?: string;
  event?: string;
  artifacts?: unknown;
  failure?: boolean;
  artifactFailure?: boolean;
  comparisonFailure?: boolean;
  runFailure?: boolean;
  sourceRun?: unknown;
  queueDepth?: string;
  comparison?: unknown;
  groupRef?: string;
  pull?: typeof pr;
};
const decide = async ({
  depth = "full",
  profile = "normal-v1",
  action = "labeled",
  event = "pull_request",
  artifacts = [artifact(depth, profile)],
  failure = false,
  artifactFailure = false,
  comparisonFailure = false,
  runFailure = false,
  sourceRun = successfulRun,
  pull = pr,
  queueDepth = "full",
  comparison = { status: "ahead", merge_base_commit: { sha: pull.head.sha } },
  groupRef = `refs/heads/gh-readonly-queue/main/pr-123-${"b".repeat(40)}`,
}: LookupOptions = {}) => {
  const outputs = new Map<string, string>();
  const requests: unknown[] = [];
  await new Script(`(async () => {${lookup}\n})()`).runInNewContext({
    require: (name: string) => {
      if (name !== "node:crypto") {
        throw new Error("Unexpected module");
      }
      return {
        createHash: (algorithm: string) => {
          expect(algorithm).toBe("sha256");
          return createSha256();
        },
      };
    },
    process: {
      env: {
        SUITE_DEPTH: depth,
        COVERAGE_PROFILE: profile,
        QUEUE_DEPTH: queueDepth,
        GITHUB_RUN_ATTEMPT: "1",
      },
    },
    context: {
      eventName: event,
      payload: {
        action,
        pull_request: pull,
        merge_group: { head_ref: groupRef, head_sha: "c".repeat(40) },
      },
      repo: { owner: "stella", repo: "stella" },
      runId: 100,
    },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      info: () => {},
    },
    github: {
      rest: {
        pulls: {
          get: async (request: unknown) => {
            requests.push(request);
            if (failure) {
              throw new Error("Queued PR unavailable");
            }
            return { data: pull };
          },
        },
        repos: {
          compareCommits: async (request: unknown) => {
            requests.push(request);
            if (failure || comparisonFailure) {
              throw new Error("Group comparison unavailable");
            }
            return { data: comparison };
          },
        },
        actions: {
          getWorkflowRun: async (request: unknown) => {
            requests.push(request);
            if (runFailure) {
              throw new Error("Source run unavailable");
            }
            return { data: sourceRun };
          },
          listArtifactsForRepo: async (request: {
            name: string;
            per_page: number;
          }) => {
            requests.push(request);
            if (failure || artifactFailure) {
              throw new Error("Evidence unavailable");
            }
            return {
              data: {
                artifacts: Array.isArray(artifacts)
                  ? artifacts
                      .filter((item) => item?.name === request.name)
                      .slice(0, request.per_page)
                  : artifacts,
              },
            };
          },
        },
      },
    },
  });
  return { outputs, requests };
};

test("unchanged-head events reuse only the exact completed depth", async () => {
  for (const action of [
    "labeled",
    "unlabeled",
    "ready_for_review",
    "reopened",
    "auto_merge_enabled",
  ]) {
    for (const depth of ["fast", "full"]) {
      const { outputs, requests } = await decide({ action, depth });
      expect(outputs.get("run_required")).toBe("false");
      expect(outputs.get("completed_run_id")).toBe("99");
      expect(requests).toHaveLength(2);
      const opposite = depth === "fast" ? "full" : "fast";
      expect(
        (
          await decide({ action, depth, artifacts: [artifact(opposite)] })
        ).outputs.get("run_required"),
      ).toBe("true");
    }
  }
});

test("default completion evidence follows the selected coverage profile", async () => {
  for (const profile of ["normal-v1", "pilot-fast-v1"]) {
    const { outputs } = await decide({ profile });
    expect(outputs.get("run_required"), profile).toBe("false");
  }
});

test("missing, expired, mismatched or failed evidence runs CI", async () => {
  for (const artifacts of [
    [],
    null,
    [null],
    [{ ...artifact("full"), expired: true }],
    [{ ...artifact("full"), expires_at: "2000-01-01" }],
    [
      {
        ...artifact("full"),
        workflow_run: { ...artifact("full").workflow_run, id: 100 },
      },
    ],
    [
      {
        ...artifact("full"),
        workflow_run: {
          ...artifact("full").workflow_run,
          head_repository_id: 789,
        },
      },
    ],
    [
      {
        ...artifact("full"),
        workflow_run: {
          ...artifact("full").workflow_run,
          head_sha: "c".repeat(40),
        },
      },
    ],
  ]) {
    expect((await decide({ artifacts })).outputs.get("run_required")).toBe(
      "true",
    );
  }
  expect((await decide({ failure: true })).outputs.get("run_required")).toBe(
    "true",
  );
  expect(
    (
      await decide({ pull: { ...pr, base: { sha: "c".repeat(40) } } })
    ).outputs.get("run_required"),
  ).toBe("true");
  expect(
    (
      await decide({ pull: { ...pr, labels: [{ name: "prove-fix" }] } })
    ).outputs.get("run_required"),
  ).toBe("true");
  for (const pull of [
    { ...pr, title: "fix: another scope" },
    { ...pr, body: "Changed evidence" },
  ]) {
    expect((await decide({ pull })).outputs.get("run_required")).toBe("true");
  }
});

test("push, dispatch and queue events always run without querying evidence", async () => {
  for (const options of [
    { action: "opened" },
    { action: "synchronize" },
    { event: "merge_group" },
    { event: "workflow_dispatch" },
  ]) {
    const { outputs, requests } = await decide(options);
    expect(outputs.get("run_required")).toBe("true");
    expect(requests).toHaveLength(0);
  }
});

test("reused depth prevents every nonstructural CI job and expensive planner step", () => {
  const reused = contextWithPlanOutputs({
    context: {
      values: {
        "github.event_name": "pull_request",
        "needs.ci-plan.outputs.run_required": "false",
      },
    },
    outputs: planner.outputs,
  });
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "ci-plan" || name === "ci-result") {
      continue;
    }
    expect(evaluate(job.if ?? "true", reused), name).toBe(false);
  }
  const checkout = planner.steps.findIndex((step) => step.name === "Checkout");
  expect(checkout).toBeGreaterThan(-1);
  for (const step of planner.steps.slice(checkout)) {
    expect(
      evaluate(step.if ?? "true", {
        status: { failure: false },
        values: {
          "steps.completed-depth.outputs.run_required": "false",
          "github.event_name": "pull_request",
        },
      }),
      step.name,
    ).toBe(false);
  }
});

test("the duplicate-result gate accepts skips but rejects failed or cancelled dependencies", () => {
  const start = aggregate.indexOf(`if [[ "\${RUN_REQUIRED:-true}" == false ]]`);
  const end = aggregate.indexOf('case "$SUITE_DEPTH" in', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  for (const outcome of ["skipped", "success", "failure", "cancelled"]) {
    const child = Bun.spawnSync(["bash", "-c", aggregate.slice(start, end)], {
      env: {
        ...process.env,
        RUN_REQUIRED: "false",
        EVENT: "pull_request",
        COMPLETED_RUN_ID: "99",
        NEEDS: JSON.stringify({
          "ci-plan": { result: "success" },
          check: { result: outcome },
        }),
      },
    });
    expect(child.exitCode).toBe(
      ["skipped", "success"].includes(outcome) ? 0 : 1,
    );
  }
});

test("only successful real validation publishes a completion marker", () => {
  for (const name of [
    "Record completed suite depth",
    "Publish completed suite depth",
  ]) {
    const condition = result.steps.find((step) => step.name === name)?.if;
    if (!condition) {
      throw new Error("Missing completion publisher condition");
    }
    for (const success of [true, false]) {
      for (const event of [
        "pull_request",
        "merge_group",
        "workflow_dispatch",
      ]) {
        for (const runRequired of ["true", "false"]) {
          for (const markerName of ["", marker("full")]) {
            expect(
              evaluate(condition, {
                status: { success },
                values: {
                  "github.event_name": event,
                  "needs.ci-plan.outputs.run_required": runRequired,
                  "needs.ci-plan.outputs.completion_marker": markerName,
                },
              }),
            ).toBe(
              success &&
                event === "pull_request" &&
                runRequired === "true" &&
                markerName !== "",
            );
          }
        }
      }
    }
  }
});

test("completion publication replaces an existing marker on a second attempt", () => {
  const publisher = result.steps.find(
    (step) => step.name === "Publish completed suite depth",
  );
  const inputs = v.parse(
    v.object({ name: v.string(), overwrite: v.literal(true) }),
    publisher?.with,
  );
  expect(inputs.overwrite).toBe(true);
  for (const attempt of [1, 2]) {
    expect(
      evaluate(inputs.name, {
        values: {
          "needs.ci-plan.outputs.completion_marker": marker("full"),
          "github.run_attempt": attempt,
        },
      }),
    ).toBe(marker("full"));
  }
});

test("completion lookup conditions belong only to the planner job", () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (step.if?.includes("steps.completed-depth")) {
        expect(name, step.name).toBe("ci-plan");
      }
    }
  }
  const condition = jobs["docker-checks"]?.steps.find(
    (step) => step.id === "api-deps",
  )?.if;
  if (!condition) {
    throw new Error("Missing image dependency scope condition");
  }
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  for (const cancelled of [true, false]) {
    for (const required of ["true", "false"]) {
      expect(
        evaluate(expression, {
          status: { cancelled },
          values: { "needs.ci-plan.outputs.api_image_deps_required": required },
        }),
      ).toBe(!cancelled && required === "true");
    }
  }
});

test("every CI condition is one expression without partial interpolation", () => {
  const conditions = new Set<string>();
  const visit = (value: unknown, location: string) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const current = `${location}.${key}`;
      if (key === "if") {
        conditions.add(current);
        expect(typeof entry, current).toBe("string");
        if (typeof entry === "string" && entry.includes("${{")) {
          const expression = entry.trim();
          expect(expression, current).toMatch(/^\$\{\{[\s\S]*\}\}$/u);
          expect(expression.slice(3, -2), current).not.toContain("${{");
        }
      }
      visit(entry, current);
    }
  };
  visit(
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
    "ci.yml",
  );
  expect(conditions.size).toBeGreaterThan(0);
});

test("surviving artifacts require the latest source attempt to succeed", async () => {
  for (const sourceRun of [
    { ...successfulRun, conclusion: "failure" },
    { ...successfulRun, conclusion: "cancelled" },
    { ...successfulRun, status: "in_progress", conclusion: null },
    { ...successfulRun, run_attempt: 2, conclusion: "failure" },
    { ...successfulRun, path: ".github/workflows/other.yml" },
    null,
  ]) {
    expect((await decide({ sourceRun })).outputs.get("run_required")).toBe(
      "true",
    );
  }
  expect((await decide({ runFailure: true })).outputs.get("run_required")).toBe(
    "true",
  );
  for (const conclusion of ["success", "failure"]) {
    expect(
      (
        await decide({
          artifacts: [artifact("full")],
          sourceRun: { ...successfulRun, run_attempt: 2, conclusion },
        })
      ).outputs.get("run_required"),
    ).toBe(conclusion === "success" ? "false" : "true");
  }
});

test("exact-name lookup finds evidence behind more than a page of unrelated artifacts", async () => {
  const artifacts = [
    ...Array.from({ length: 150 }, (_, index) => ({
      ...artifact("full"),
      name: `unrelated-${index}`,
    })),
    artifact("full"),
  ];
  const { outputs, requests } = await decide({ artifacts });
  expect(outputs.get("run_required")).toBe("false");
  expect(requests).toHaveLength(2);
  expect(requests.at(0)).toMatchObject({ name: marker("full"), per_page: 100 });
});

test("switching the pilot on or off cannot reuse the other fast coverage profile", async () => {
  for (const { profile, previous } of [
    { profile: "normal-v1", previous: "pilot-fast-v1" },
    { profile: "pilot-fast-v1", previous: "normal-v1" },
  ]) {
    expect(
      (
        await decide({
          depth: "fast",
          profile,
          artifacts: [artifact("fast", previous)],
        })
      ).outputs.get("run_required"),
    ).toBe("true");
    expect(
      (
        await decide({
          depth: "fast",
          profile,
          artifacts: [artifact("fast", profile)],
        })
      ).outputs.get("run_required"),
    ).toBe("false");
  }
});

test("enqueue events leave every PR suite to unchanged merge-group validation", async () => {
  const { outputs, requests } = await decide({ action: "enqueued" });
  expect(outputs.get("run_required")).toBe("false");
  expect(outputs.get("queue_validation")).toBe("true");
  expect(requests).toHaveLength(0);
  const enqueued = contextWithPlanOutputs({
    context: {
      values: {
        "github.event_name": "pull_request",
        "needs.ci-plan.outputs.run_required": "false",
        "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      },
    },
    outputs: planner.outputs,
  });
  for (const [name, job] of Object.entries(jobs)) {
    if (["ci-plan", "ci-result"].includes(name)) {
      continue;
    }
    expect(evaluate(job.if ?? "true", enqueued), name).toBe(false);
  }
});

test("enqueue aggregation accepts only the queued PR event and successful structural checks", () => {
  const start = aggregate.indexOf('if [[ "$QUEUE_VALIDATION" == true');
  const end = aggregate.indexOf("# Read cancellation evidence", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const branch = `${aggregate.slice(start, end)}\nexit 9`;
  for (const [event, action, outcome, expected] of [
    ["pull_request", "enqueued", "success", 0],
    ["pull_request", "enqueued", "failure", 9],
    ["pull_request", "enqueued", "cancelled", 9],
    ["pull_request", "synchronize", "success", 9],
    ["merge_group", "enqueued", "success", 9],
  ] as const) {
    const child = Bun.spawnSync(["bash", "-c", branch], {
      env: {
        ...process.env,
        QUEUE_VALIDATION: "true",
        EVENT: event,
        PR_ACTION: action,
        NEEDS: JSON.stringify({
          "ci-plan": { result: outcome },
          checks: { result: "skipped" },
        }),
      },
    });
    expect(child.exitCode, child.stderr.toString()).toBe(expected);
  }
});

test("thin groups certify only normal-profile completion on a head included in the group", async () => {
  const options = {
    event: "merge_group",
    queueDepth: "thin",
    depth: "full",
    artifacts: [artifact("fast")],
  };
  const passed = await decide(options);
  expect(passed.outputs.get("normal_completion")).toBe("complete");
  expect(passed.outputs.get("run_required")).toBe("true");
  expect(passed.outputs.has("marker")).toBe(false);
  expect(
    (await decide({ ...options, profile: "pilot-fast-v1" })).outputs.get(
      "normal_completion",
    ),
  ).toBe("complete");
  for (const changed of [
    { artifacts: [artifact("fast", "pilot-fast-v1")] },
    { artifacts: [] },
    { artifacts: [artifact("full")] },
    { artifacts: [{ ...artifact("fast"), expired: true }] },
    { failure: true },
    { artifactFailure: true },
    { comparisonFailure: true },
    { runFailure: true },
    {
      sourceRun: { ...successfulRun, status: "in_progress", conclusion: null },
    },
    { sourceRun: { ...successfulRun, conclusion: "failure" } },
    { sourceRun: { ...successfulRun, head_sha: "d".repeat(40) } },
    {
      comparison: {
        status: "diverged",
        merge_base_commit: { sha: "d".repeat(40) },
      },
    },
    {
      comparison: {
        status: "ahead",
        merge_base_commit: { sha: "d".repeat(40) },
      },
    },
    { groupRef: "refs/heads/unknown" },
    { pull: { ...pr, number: 999 } },
  ]) {
    const fallback = await decide({ ...options, ...changed });
    expect(
      fallback.outputs.get("normal_completion"),
      JSON.stringify(changed),
    ).toBe("required");
    expect(fallback.outputs.get("run_required")).toBe("true");
  }
});

test("thin groups run and require every deferred normal PR check unless normal completion is certified", async () => {
  const deferred = pilotQueueJobs(workflow);
  if (deferred.status !== "valid") {
    throw new Error(deferred.message);
  }
  expect(deferred.jobs).toContain("ci-browser");
  expect(deferred.jobs).toContain("dependency-malware");
  const aggregation = result.steps.find(
    (step) => step.name === "Evaluate CI outcome",
  );
  if (!aggregation?.run) {
    throw new Error("Missing CI aggregation");
  }
  const env = v.parse(
    v.object({ env: v.record(v.string(), v.string()) }),
    aggregation,
  ).env;
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(env["JOB_SCOPES"] ?? ""),
  );
  const allScopes = Object.fromEntries(
    Object.values(scopes)
      .filter((scopeName) => scopeName !== null)
      .map((scopeName) => [scopeName, "true"]),
  );
  const thin = thinJobs(workflow);
  for (const options of [
    { artifacts: [artifact("fast", "pilot-fast-v1")] },
    { artifacts: [] },
    { artifacts: [artifact("fast")] },
    { artifacts: [artifact("fast")], runFailure: true },
    { artifacts: [artifact("fast")], artifactFailure: true },
  ]) {
    const evidence = await decide({
      ...options,
      event: "merge_group",
      queueDepth: "thin",
      depth: "full",
    });
    const completion = v.parse(
      v.picklist(["required", "complete"]),
      evidence.outputs.get("normal_completion"),
    );
    const context = contextWithPlanOutputs({
      outputs: planner.outputs,
      context: {
        values: {
          "github.event_name": "merge_group",
          "inputs.heavy_only": false,
          "steps.completed-depth.outputs.normal_completion": completion,
          "steps.pilot-queue-plan.outputs.queue_jobs": JSON.stringify(
            deferred.jobs,
          ),
          "needs.ci-plan.outputs.run_required": "true",
          "needs.ci-plan.outputs.coverage_profile": "normal-v1",
          "needs.ci-plan.outputs.trusted": "true",
          "needs.ci-plan.outputs.suite_depth": "full",
          "needs.ci-plan.outputs.queue_depth": "thin",
          ...Object.fromEntries(
            Object.entries(allScopes).map(([name, value]) => [
              `needs.ci-plan.outputs.${name}`,
              value,
            ]),
          ),
        },
        status: { success: true, failure: false, cancelled: false },
      },
    });
    const queueJobs = v.parse(
      v.array(v.string()),
      JSON.parse(
        v.parse(
          v.string(),
          context.fallback?.("needs.ci-plan.outputs.queue_required_jobs"),
        ),
      ),
    );
    expect(queueJobs).toEqual(completion === "complete" ? [] : deferred.jobs);
    const dependencies = Object.fromEntries(
      Object.entries(scopes).map(([name]) => [
        name,
        {
          result:
            thin.includes(name) || queueJobs.includes(name)
              ? "success"
              : "skipped",
        },
      ]),
    );
    dependencies["ci-plan"] = { result: "success" };
    const runAggregation = (needs: typeof dependencies) =>
      Bun.spawnSync(["bash", "-e", "-c", aggregation.run ?? ""], {
        env: {
          ...process.env,
          ...env,
          EVENT: "merge_group",
          QUEUE_DEPTH: "thin",
          SUITE_DEPTH: "full",
          HEAVY_ONLY: "false",
          COVERAGE_PROFILE: "normal-v1",
          QUEUE_VALIDATION: "false",
          PLAN_RESULT: "success",
          TRUSTED: "true",
          THIN_JOBS: JSON.stringify(thin),
          QUEUE_REQUIRED_JOBS: JSON.stringify(queueJobs),
          PLAN: JSON.stringify(allScopes),
          NEEDS: JSON.stringify(needs),
        },
      });
    expect(runAggregation(dependencies).exitCode).toBe(0);
    for (const job of deferred.jobs) {
      const scheduled = evaluate(jobs[job]?.if ?? "true", context);
      if (completion !== "complete") {
        expect(scheduled, job).toBe(true);
        for (const outcome of ["skipped", "failure"]) {
          expect(
            runAggregation({ ...dependencies, [job]: { result: outcome } })
              .exitCode,
            `${job}/${outcome}`,
          ).toBe(1);
        }
      } else if (!thin.includes(job)) {
        expect(scheduled, job).toBe(false);
      }
    }
  }
});
