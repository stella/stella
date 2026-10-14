import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    jobs: v.object({
      "ci-plan": v.object({
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const source = workflow.jobs["ci-plan"].steps.find(
  (step) => step.name === "Yield to the merge queue",
)?.with?.script;
if (!source) {
  throw new Error("Missing merge-queue yield script");
}
const script = new Script(`(async () => {\n${source}\n})()`);

const runYield = async ({
  attempt,
  queueWaiting,
  yieldStatus,
}: {
  attempt: number;
  queueWaiting: boolean;
  yieldStatus?: string;
}) => {
  const statuses: { state: string; context: string }[] = [];
  const cancelled: number[] = [];
  await script.runInNewContext({
    context: {
      repo: { owner: "test", repo: "test" },
      runId: 7,
      serverUrl: "https://github.com",
      payload: { pull_request: { head: { sha: "head-1" } } },
    },
    core: { notice: () => {} },
    process: { env: { GITHUB_RUN_ATTEMPT: String(attempt) } },
    setTimeout: (resolve: () => void) => {
      resolve();
    },
    Number,
    Promise,
    github: {
      paginate: async () => [],
      rest: {
        actions: {
          listWorkflowRunsForRepo: async ({ status }: { status: string }) => ({
            data: {
              total_count: queueWaiting && status === "queued" ? 1 : 0,
              workflow_runs: [],
            },
          }),
          listJobsForWorkflowRun: async () => ({ data: { jobs: [] } }),
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
          },
        },
        repos: {
          listCommitStatusesForRef: async () => ({
            data:
              yieldStatus === undefined
                ? []
                : [{ context: "ci/merge-queue-yield", state: yieldStatus }],
          }),
          createCommitStatus: async ({
            state,
            context,
          }: {
            state: string;
            context: string;
          }) => {
            statuses.push({ state, context });
          },
        },
      },
    },
  });
  return { statuses, cancelled };
};

test("a first run defers while the merge queue has waiting work", async () => {
  expect(await runYield({ attempt: 1, queueWaiting: true })).toEqual({
    statuses: [{ state: "pending", context: "ci/merge-queue-yield" }],
    cancelled: [7],
  });
});

test("a first run with an idle merge queue continues untouched", async () => {
  expect(await runYield({ attempt: 1, queueWaiting: false })).toEqual({
    statuses: [],
    cancelled: [],
  });
});

test("a re-run never defers again and clears a pending deferral", async () => {
  expect(
    await runYield({ attempt: 2, queueWaiting: true, yieldStatus: "pending" }),
  ).toEqual({
    statuses: [{ state: "success", context: "ci/merge-queue-yield" }],
    cancelled: [],
  });
});

test("a re-run of a head that never deferred writes no status", async () => {
  expect(await runYield({ attempt: 3, queueWaiting: true })).toEqual({
    statuses: [],
    cancelled: [],
  });
  expect(
    await runYield({ attempt: 2, queueWaiting: true, yieldStatus: "success" }),
  ).toEqual({ statuses: [], cancelled: [] });
});
