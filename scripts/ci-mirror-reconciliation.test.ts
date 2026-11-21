import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    jobs: v.object({
      retry: v.object({
        steps: v.array(
          v.object({
            name: v.string(),
            with: v.object({ script: v.string() }),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci-runner-loss-retry.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const step = workflow.jobs.retry.steps.find(
  ({ name }) => name === "Reconcile metadata mirrors after CI completion",
);
if (step === undefined) {
  panic("Missing CI completion reconciliation step");
}
const executable = new Script(`(async () => { ${step.with.script} })()`);
const HEAD = "a".repeat(40);
const BEFORE = "2026-10-24T06:00:00Z";
const COMPLETED = "2026-10-24T06:01:00Z";
const AFTER = "2026-10-24T06:02:00Z";

type RunFixture = {
  id: number;
  kind: "code" | "metadata";
  status: "completed" | "in_progress";
  run_attempt: number;
  head_sha: string;
  repository: string;
  pr: number;
  started: string;
  completed: string;
  conclusion: "success" | "failure";
};

const source = (): RunFixture => ({
  id: 100,
  kind: "code",
  status: "completed",
  run_attempt: 2,
  head_sha: HEAD,
  repository: "stella/stella",
  pr: 1,
  started: BEFORE,
  completed: COMPLETED,
  conclusion: "success",
});
const mirror = (): RunFixture => ({
  ...source(),
  id: 101,
  kind: "metadata",
  run_attempt: 1,
  conclusion: "failure",
});

const reconcile = async (
  runs: RunFixture[],
  { event = source(), refused = false, concurrent = false } = {},
) => {
  const reran: number[] = [];
  const failures: string[] = [];
  const requested = (id: number) =>
    runs.find((run) => run.id === id) ?? panic(`Missing run fixture ${id}`);
  const record = (run: RunFixture) => ({
    ...run,
    head_repository: { full_name: run.repository },
    pull_requests: [{ number: run.pr }],
  });
  await executable.runInNewContext({
    github: {
      paginate: async (
        route: string,
        { run_id, filter }: { run_id?: number; filter?: string },
      ) => {
        if (route.includes("/workflows/")) {
          return runs.map(record);
        }
        if (run_id === undefined) {
          panic("Job lookup requires a run id");
        }
        const run = requested(run_id);
        const jobs = [
          {
            id: run.id * 10,
            name: "ci-plan",
            status: "completed",
            conclusion: run.kind === "code" ? "success" : "skipped",
          },
          {
            id: run.id * 10 - 1,
            name: "ci-metadata-plan",
            status: "completed",
            conclusion: run.kind === "metadata" ? "success" : "skipped",
          },
          {
            id: run.id * 10 + 1,
            name: "ci-result",
            status: run.status,
            conclusion: run.conclusion,
            started_at: run.started,
            completed_at: run.completed,
          },
        ];
        if (run.run_attempt === 1) {
          return jobs;
        }
        const earlierResult = {
          id: run.id * 10 - 2,
          name: "ci-result",
          status: "completed",
          conclusion: "failure",
          started_at: BEFORE,
          completed_at: BEFORE,
        };
        // Partial reruns need not execute their successful planning jobs.
        // Their classification survives in the earlier attempt's evidence.
        return filter === "all"
          ? [...jobs, earlierResult]
          : jobs.filter((job) => job.name === "ci-result");
      },
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => ({
            data: record(requested(run_id)),
          }),
          reRunJobForWorkflowRun: async ({ job_id }: { job_id: number }) => {
            const run = requested(Math.floor(job_id / 10));
            if (concurrent) {
              run.run_attempt += 1;
              run.status = "in_progress";
              panic("Another completion observer already requested this rerun");
            }
            if (refused) {
              panic("Rerun request refused");
            }
            reran.push(job_id);
          },
        },
      },
    },
    context: {
      repo: { owner: "stella", repo: "stella" },
      payload: { workflow_run: record(event) },
    },
    core: {
      notice: () => undefined,
      setFailed: (message: string) => failures.push(message),
    },
  });
  return { reran, failures };
};

test("a deciding mirror that already read an earlier attempt is reconciled after completion", async () => {
  const deciding = { ...mirror(), status: "in_progress" as const };
  expect(await reconcile([source(), deciding])).toEqual({
    reran: [],
    failures: [],
  });
  const finished = mirror();
  expect(await reconcile([source(), finished], { event: finished })).toEqual({
    reran: [1011],
    failures: [],
  });
  const refreshed = { ...mirror(), run_attempt: 2, started: AFTER };
  expect(await reconcile([source(), refreshed], { event: refreshed })).toEqual({
    reran: [],
    failures: [],
  });
});

test("source completion reconciles a mirror that finished while the source was running", async () => {
  expect(
    await reconcile([{ ...source(), status: "in_progress" }, mirror()], {
      event: mirror(),
    }),
  ).toEqual({
    reran: [],
    failures: [],
  });
  expect(await reconcile([source(), mirror()])).toEqual({
    reran: [1011],
    failures: [],
  });
});

test("reconciliation is bounded by the source attempt and mirror start, not matching verdicts", async () => {
  const failing = { ...source(), conclusion: "failure" as const };
  const copied = { ...mirror(), conclusion: "success" as const };
  expect(
    (await reconcile([failing, copied], { event: failing })).reran,
  ).toEqual([1011]);
  // A pass-through source can still yield a failure when the mirror evaluates
  // the actual required-jobs record. A fresh mirror is never re-run in a loop.
  expect(
    (await reconcile([source(), { ...mirror(), started: AFTER }])).reran,
  ).toEqual([]);
});

test("other heads, repositories, pull requests, first attempts and newer sources are excluded", async () => {
  const cases = [
    [{ ...source(), head_sha: "b".repeat(40) }, mirror()],
    [{ ...source(), repository: "other/stella" }, mirror()],
    [{ ...source(), pr: 2 }, mirror()],
    [{ ...source(), run_attempt: 1 }, mirror()],
    [{ ...source(), id: 102 }, mirror()],
    [source(), { ...mirror(), head_sha: "b".repeat(40) }],
    [source(), { ...mirror(), pr: 2 }],
  ];
  for (const runs of cases) {
    expect(await reconcile(runs)).toEqual({ reran: [], failures: [] });
  }
});

test("refused reruns identify the affected mirror, while concurrent reruns converge", async () => {
  const failed = await reconcile([source(), mirror()], { refused: true });
  expect(failed.reran).toEqual([]);
  expect(failed.failures.join(" ")).toContain("metadata run 101");
  expect(await reconcile([source(), mirror()], { concurrent: true })).toEqual({
    reran: [],
    failures: [],
  });
});

test("unreadable source and mirror timestamps are reported explicitly", async () => {
  for (const runs of [
    [{ ...source(), completed: "" }, mirror()],
    [source(), { ...mirror(), started: "" }],
  ]) {
    const result = await reconcile(runs);
    expect(result.reran).toEqual([]);
    expect(result.failures.join(" ")).toContain("no readable ci-result");
  }
});
