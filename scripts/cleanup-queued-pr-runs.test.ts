import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    jobs: v.object({
      cleanup: v.object({
        steps: v.array(v.object({ with: v.object({ script: v.string() }) })),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL(
        "../.github/workflows/cleanup-queued-pr-runs.yml",
        import.meta.url,
      ),
      "utf-8",
    ),
  ),
);
const source = workflow.jobs.cleanup.steps.at(0)?.with.script;
if (!source) {
  throw new Error("Missing cleanup script");
}
const script = new Script(`(async () => {\n${source}\n})()`);

type Run = {
  id: number;
  status: string;
  event: string;
  head_sha: string;
  created_at: string;
  pull_requests: { number: number; head?: { sha: string } }[];
};
const queued = (event = "pull_request_target"): Run => ({
  id: 1,
  status: "queued",
  event,
  head_sha: "base",
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  pull_requests: [{ number: 12, head: { sha: "current" } }],
});

type CleanupOptions = {
  run: Run;
  current?: Run;
  retry?: Run;
  head?: string;
  metadataStatus?: number;
  cancelRefused?: boolean;
};
const cleanup = async ({
  run,
  current = run,
  retry = current,
  head = "current",
  metadataStatus = 0,
  cancelRefused = false,
}: CleanupOptions) => {
  const cancelled: number[] = [];
  const forced: number[] = [];
  const readPulls: number[] = [];
  let reads = 0;
  const listWorkflowRunsForRepo = () => {};
  await script.runInNewContext({
    context: { repo: { owner: "test", repo: "test" }, payload: {} },
    core: {
      info: () => {},
      warning: () => {},
      error: () => {},
      setFailed: (message: string) => {
        throw new Error(message);
      },
    },
    github: {
      paginate: async () => [run],
      rest: {
        actions: {
          listWorkflowRunsForRepo,
          getWorkflowRun: async () => ({
            data: reads++ === 0 ? current : retry,
          }),
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
            if (cancelRefused) {
              throw new Error("Already started");
            }
          },
        },
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            readPulls.push(pull_number);
            if (metadataStatus) {
              throw Object.assign(new Error("Unavailable"), {
                status: metadataStatus,
              });
            }
            return { data: { head: { sha: head } } };
          },
        },
      },
      request: async (_route: string, { run_id }: { run_id: number }) => {
        forced.push(run_id);
      },
    },
  });
  return { cancelled, forced, readPulls, reads };
};

test.each(["pull_request", "pull_request_target"])(
  "a live %s run uses its associated PR head, not the base workflow SHA",
  async (event) => {
    const result = await cleanup({ run: queued(event) });
    expect(result.cancelled).toEqual([]);
    expect(result.readPulls).toEqual([12]);
  },
);

test.each(["pull_request", "pull_request_target"])(
  "a superseded %s run compares its recorded PR head with the current PR",
  async (event) => {
    const run = {
      ...queued(event),
      pull_requests: [{ number: 12, head: { sha: "old" } }],
    };
    expect((await cleanup({ run })).cancelled).toEqual([1]);
  },
);

test("target runs with no associated head cannot be cancelled as superseded", async () => {
  for (const pull_requests of [[], [{ number: 12 }]]) {
    expect(
      (await cleanup({ run: { ...queued(), pull_requests } })).cancelled,
    ).toEqual([]);
  }
});

test.each([403, 404])(
  "unavailable PR metadata (%s) fails closed",
  async (metadataStatus) => {
    const run = {
      ...queued(),
      pull_requests: [{ number: 12, head: { sha: "old" } }],
    };
    expect((await cleanup({ run, metadataStatus })).cancelled).toEqual([]);
  },
);

test("other metadata failures stop cleanup", async () => {
  await expect(cleanup({ run: queued(), metadataStatus: 500 })).rejects.toThrow(
    "Unavailable",
  );
});

test("the six-hour rule still applies without a resolvable PR", async () => {
  const run = {
    ...queued(),
    pull_requests: [],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  const result = await cleanup({ run });
  expect(result.cancelled).toEqual([1]);
  expect(result.readPulls).toEqual([]);
});

test("non-PR events and runs that already started are never cancelled", async () => {
  for (const event of [
    "push",
    "merge_group",
    "release",
    "schedule",
    "workflow_dispatch",
  ]) {
    const result = await cleanup({
      run: { ...queued(event), created_at: "2020-01-01T00:00:00Z" },
    });
    expect(result.cancelled).toEqual([]);
    expect(result.reads).toBe(0);
  }
  const run = queued();
  expect(
    (await cleanup({ run, current: { ...run, status: "in_progress" } }))
      .cancelled,
  ).toEqual([]);
});

test("a current association protects a run shared by multiple PRs", async () => {
  const run = {
    ...queued(),
    pull_requests: [
      { number: 11, head: { sha: "old" } },
      { number: 12, head: { sha: "current" } },
    ],
  };
  expect((await cleanup({ run })).cancelled).toEqual([]);
});

test("force-cancellation rechecks eligibility after a refused cancellation", async () => {
  const run = {
    ...queued(),
    pull_requests: [{ number: 12, head: { sha: "old" } }],
  };
  expect(
    (
      await cleanup({
        run,
        cancelRefused: true,
        retry: { ...run, status: "in_progress" },
      })
    ).forced,
  ).toEqual([]);
  expect(
    (await cleanup({ run, cancelRefused: true, retry: queued() })).forced,
  ).toEqual([]);
  const result = await cleanup({ run, cancelRefused: true });
  expect(result.forced).toEqual([1]);
  expect(result.readPulls).toEqual([12, 12]);
});
