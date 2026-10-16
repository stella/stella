import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { mergeQueueGate, mergeQueueWaiting } from "./merge-queue-waiting.mjs";

const readWorkflow = (name: string) =>
  Bun.YAML.parse(
    readFileSync(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf-8",
    ),
  );
const stepsSchema = v.array(
  v.looseObject({
    name: v.optional(v.string()),
    if: v.optional(v.string()),
    "continue-on-error": v.optional(v.boolean()),
    with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
  }),
);
const jobSteps = (workflow: string, job: string) =>
  v.parse(
    v.looseObject({ steps: stepsSchema }),
    v.parse(
      v.object({ jobs: v.record(v.string(), v.unknown()) }),
      readWorkflow(workflow),
    ).jobs[job],
  ).steps;
const stepScript = (workflow: string, job: string, name: string) => {
  const script = jobSteps(workflow, job).find((step) => step.name === name)
    ?.with?.script;
  if (!script) {
    throw new Error(`Missing ${workflow} ${job} step: ${name}`);
  }
  return script;
};

// Formatting may wrap lines, add trailing commas or brace a single return
// statement; the code must match.
const compact = (source: string) =>
  source
    .replaceAll(/\s+/gu, "")
    .replaceAll(/,([)\]}])/gu, "$1")
    .replaceAll(/\{(return[^;{}]*;)\}/gu, "$1");
const functionBody = (source: string, header: string) => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    throw new Error(`Missing ${header}`);
  }
  const indent = lines[start]?.search(/\S/u) ?? 0;
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.trim() === "};" && line.search(/\S/u) === indent,
  );
  if (end === -1) {
    throw new Error(`Unterminated ${header}`);
  }
  return compact(lines.slice(start + 1, end).join("\n"));
};

test("the PR CI yield and the steward inline the shared predicate", () => {
  const shared = functionBody(
    readFileSync(new URL("merge-queue-waiting.mjs", import.meta.url), "utf-8"),
    "export const mergeQueueWaiting = async ({ github, repo }) => {",
  );
  const header = "const waiting = async () => {";
  expect(
    functionBody(
      stepScript("ci.yml", "ci-plan", "Yield to the merge queue"),
      header,
    ),
  ).toBe(shared);
  expect(
    functionBody(
      stepScript(
        "cleanup-queued-pr-runs.yml",
        "cleanup",
        "Resume pull request runs that deferred to the merge queue",
      ),
      header,
    ),
  ).toBe(shared);
});

test("the side workflows call the shared gate and never fail on it", () => {
  for (const [workflow, job, name] of [
    ["db-migrations.yml", "scope", "Wait for the merge queue"],
    ["autofix.yml", "regenerate-scope", "Yield to the merge queue"],
  ] as const) {
    const step = jobSteps(workflow, job).find((entry) => entry.name === name);
    expect(step?.["continue-on-error"], workflow).toBe(true);
    expect(step?.with?.script, workflow).toContain("mergeQueueGate(");
  }
  expect(
    stepScript("db-migrations.yml", "scope", "Wait for the merge queue"),
  ).toContain("polls: 20,");
  expect(
    stepScript("autofix.yml", "regenerate-scope", "Yield to the merge queue"),
  ).toContain("polls: 0,");
});

type Queue = { queued?: number; inProgressJobs?: string[] };

const client = (states: Queue[]) => {
  let checks = 0;
  const calls = { checks: 0 };
  const current = () => states[Math.min(checks, states.length - 1)] ?? {};
  return {
    calls,
    github: {
      paginate: async () =>
        (current().inProgressJobs ?? []).map((status) => ({ status })),
      rest: {
        actions: {
          listJobsForWorkflowRun: {},
          listWorkflowRunsForRepo: async ({ status }: { status: string }) => {
            if (status === "in_progress") {
              const runs = current().inProgressJobs ? [{ id: 1 }] : [];
              checks += 1;
              calls.checks = checks;
              return {
                data: { total_count: runs.length, workflow_runs: runs },
              };
            }
            const queued = status === "queued" ? (current().queued ?? 0) : 0;
            if (queued > 0) {
              checks += 1;
              calls.checks = checks;
            }
            return { data: { total_count: queued, workflow_runs: [] } };
          },
        },
      },
    },
  };
};

const gate = async ({
  states,
  attempt = 1,
  polls,
  actor = "octocat",
}: {
  states: Queue[];
  attempt?: number;
  polls: number;
  actor?: string;
}) => {
  const { github, calls } = client(states);
  const notices: string[] = [];
  const sleeps: number[] = [];
  const result = await mergeQueueGate({
    github,
    context: { actor, repo: { owner: "test", repo: "test" } },
    attempt,
    polls,
    intervalMs: 60_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    notice: (message: string) => {
      notices.push(message);
    },
  });
  return { result, checks: calls.checks, notices: notices.length, sleeps };
};

test("the predicate sees queued runs and queued jobs inside running ones", async () => {
  const repo = { owner: "test", repo: "test" };
  expect(
    await mergeQueueWaiting({ github: client([{ queued: 1 }]).github, repo }),
  ).toBe(true);
  expect(
    await mergeQueueWaiting({
      github: client([{ inProgressJobs: ["in_progress", "queued"] }]).github,
      repo,
    }),
  ).toBe(true);
  expect(
    await mergeQueueWaiting({
      github: client([{ inProgressJobs: ["in_progress", "completed"] }]).github,
      repo,
    }),
  ).toBe(false);
});

test("an idle merge queue runs at once", async () => {
  expect(await gate({ states: [{}], polls: 0 })).toEqual({
    result: "run",
    checks: 1,
    notices: 0,
    sleeps: [],
  });
});

test("a skipping gate skips visibly while the merge queue waits", async () => {
  expect(await gate({ states: [{ queued: 1 }], polls: 0 })).toEqual({
    result: "skip",
    checks: 1,
    notices: 1,
    sleeps: [],
  });
});

test("a waiting gate runs as soon as the merge queue clears", async () => {
  expect(
    await gate({ states: [{ queued: 1 }, { queued: 1 }, {}], polls: 20 }),
  ).toEqual({ result: "run", checks: 3, notices: 0, sleeps: [60_000, 60_000] });
});

test("a waiting gate runs anyway once its bound passes", async () => {
  const result = await gate({ states: [{ queued: 1 }], polls: 3 });
  expect(result).toEqual({
    result: "run",
    checks: 4,
    notices: 1,
    sleeps: [60_000, 60_000, 60_000],
  });
});

test("re-runs and Dependabot runs never yield", async () => {
  for (const options of [
    { attempt: 2 },
    { actor: "dependabot[bot]" },
  ] as const) {
    expect(
      await gate({ states: [{ queued: 1 }], polls: 0, ...options }),
    ).toEqual({ result: "run", checks: 0, notices: 0, sleeps: [] });
  }
});
