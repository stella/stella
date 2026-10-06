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
const jobs = v.parse(
  v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      steps: v.optional(v.array(stepSchema), []),
    }),
  ),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ).jobs,
);
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
  `ci-completed-v1-123-456-${pr.head.sha}-${pr.base.sha}-${depth}-${scope}`;
const artifact = (depth: string) => ({
  name: marker(depth),
  expired: false,
  expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: 99, head_sha: pr.head.sha, head_repository_id: 456 },
});
type LookupOptions = {
  depth?: string;
  action?: string;
  event?: string;
  artifacts?: unknown;
  failure?: boolean;
  pull?: typeof pr;
};
const decide = async ({
  depth = "full",
  action = "labeled",
  event = "pull_request",
  artifacts = [artifact(depth)],
  failure = false,
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
    process: { env: { SUITE_DEPTH: depth } },
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
          listArtifactsForRepo: (request: unknown) => {
            requests.push(request);
            if (failure) {
              return Promise.reject(new Error("Evidence unavailable"));
            }
            return Promise.resolve({ data: { artifacts } });
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
      expect(requests).toHaveLength(1);
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
