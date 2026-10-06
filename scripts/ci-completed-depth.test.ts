import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { evaluate } from "./github-expression";

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
const scope = createHash("sha256")
  .update(JSON.stringify([pr.title, pr.body, false]))
  .digest("hex");
const marker = (depth: string) =>
  `ci-completed-v3-123-456-${pr.head.sha}-${pr.base.sha}-${depth}-${scope}`;
const artifact = (depth: string) => ({
  name: marker(depth),
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
  action?: string;
  event?: string;
  artifacts?: unknown;
  failure?: boolean;
  runFailure?: boolean;
  sourceRun?: unknown;
  pull?: typeof pr;
};
const decide = async ({
  depth = "full",
  action = "labeled",
  event = "pull_request",
  artifacts = [artifact(depth)],
  failure = false,
  runFailure = false,
  sourceRun = successfulRun,
  pull = pr,
}: LookupOptions = {}) => {
  const outputs = new Map<string, string>();
  const requests: unknown[] = [];
  await new Script(`(async () => {${lookup}\n})()`).runInNewContext({
    require: (name: string) => {
      if (name !== "node:crypto") {
        throw new Error("Unexpected module");
      }
      return { createHash };
    },
    process: { env: { SUITE_DEPTH: depth, GITHUB_RUN_ATTEMPT: "1" } },
    context: {
      eventName: event,
      payload: { action, pull_request: pull },
      repo: { owner: "stella", repo: "stella" },
      runId: 100,
    },
    core: {
      setOutput: (key: string, value: string) => outputs.set(key, value),
      info: () => {},
    },
    github: {
      rest: {
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
            if (failure) {
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
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "ci-plan" || name === "ci-result") {
      continue;
    }
    expect(
      evaluate(job.if ?? "true", {
        values: {
          "github.event_name": "pull_request",
          "needs.ci-plan.outputs.run_required": "false",
        },
      }),
      name,
    ).toBe(false);
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
