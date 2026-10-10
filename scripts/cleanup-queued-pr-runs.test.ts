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

type ApiFailure = { status: number; message: string };
const notQueued = {
  status: 409,
  message: "Cannot cancel a workflow run that has not been queued yet.",
};

type CleanupOptions = {
  run: Run;
  current?: Run;
  retry?: Run;
  head?: string;
  metadataStatus?: number;
  cancelFailure?: ApiFailure;
  forceFailure?: ApiFailure;
  followingRun?: Run;
};
const cleanup = async ({
  run,
  current = run,
  retry = current,
  head = "current",
  metadataStatus = 0,
  cancelFailure,
  forceFailure,
  followingRun,
}: CleanupOptions) => {
  const cancelled: number[] = [];
  const forced: number[] = [];
  const readPulls: number[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const failures: string[] = [];
  let reads = 0;
  const listWorkflowRunsForRepo = () => {};
  await script.runInNewContext({
    context: { repo: { owner: "test", repo: "test" }, payload: {} },
    core: {
      info: (message: string) => infos.push(message),
      warning: () => {},
      error: (message: string) => errors.push(message),
      setFailed: (message: string) => {
        failures.push(message);
      },
    },
    github: {
      paginate: async () => (followingRun ? [run, followingRun] : [run]),
      rest: {
        actions: {
          listWorkflowRunsForRepo,
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            if (run_id !== run.id) {
              return { data: followingRun };
            }
            return { data: reads++ === 0 ? current : retry };
          },
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
            if (run_id === run.id && cancelFailure) {
              throw Object.assign(new Error(cancelFailure.message), {
                status: cancelFailure.status,
              });
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
        if (forceFailure) {
          throw Object.assign(new Error(forceFailure.message), {
            status: forceFailure.status,
          });
        }
      },
    },
  });
  return { cancelled, forced, readPulls, reads, infos, errors, failures };
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
  const rejection = await cleanup({ run: queued(), metadataStatus: 500 }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({ message: "Unavailable" });
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
        cancelFailure: notQueued,
        retry: { ...run, status: "in_progress" },
      })
    ).forced,
  ).toEqual([]);
  expect(
    (await cleanup({ run, cancelFailure: notQueued, retry: queued() })).forced,
  ).toEqual([]);
  const result = await cleanup({ run, cancelFailure: notQueued });
  expect(result.forced).toEqual([1]);
  expect(result.readPulls).toEqual([12, 12]);
});

const stale = () => ({ ...queued(), created_at: "2020-01-01T00:00:00Z" });

test.each([
  notQueued.message,
  `${notQueued.message} - https://docs.github.com/rest/actions/workflow-runs#cancel-a-workflow-run`,
])(
  "matching GitHub state refusals skip the run and continue: %s",
  async (message) => {
    const result = await cleanup({
      run: stale(),
      cancelFailure: { ...notQueued, message },
      forceFailure: {
        ...notQueued,
        message: `${notQueued.message} - https://docs.github.com/rest/actions/workflow-runs#force-cancel-a-workflow-run`,
      },
      followingRun: { ...stale(), id: 2 },
    });
    expect(result.forced).toEqual([1]);
    expect(result.cancelled).toEqual([1, 2]);
    expect(result.infos).toContain(
      "Run 1 (status: queued) skipped: not cancellable (GitHub state)",
    );
    expect(result.infos).toContain(
      "Cancellation requested for 2: queued over six hours",
    );
    expect(result.failures).toEqual([]);
    expect(result.errors).toEqual([]);
  },
);

test.each([400, 401, 403, 404, 409, 422, 429, 500, 503])(
  "other API errors (%s) fail in either cancellation endpoint",
  async (status) => {
    const other = { status, message: "Cancellation unavailable" };
    for (const options of [
      { cancelFailure: other, forceFailure: notQueued },
      { cancelFailure: notQueued, forceFailure: other },
      { cancelFailure: other },
    ]) {
      const result = await cleanup({ run: stale(), ...options });
      expect(result.failures).toEqual([
        "1 queued PR run(s) could not be cancelled",
      ]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(
        result.infos.some((info) => info.includes("skipped: not cancellable")),
      ).toBe(false);
    }
  },
);

test("the GitHub state message with another status still fails", async () => {
  for (const status of [403, 500]) {
    for (const options of [
      { cancelFailure: { ...notQueued, status }, forceFailure: notQueued },
      { cancelFailure: notQueued, forceFailure: { ...notQueued, status } },
    ]) {
      const result = await cleanup({ run: stale(), ...options });
      expect(result.failures).toEqual([
        "1 queued PR run(s) could not be cancelled",
      ]);
    }
  }
});

test("accepted cancellations report success for either endpoint", async () => {
  const normal = await cleanup({ run: stale() });
  expect(normal.infos).toContain(
    "Cancellation requested for 1: queued over six hours",
  );
  expect(normal.forced).toEqual([]);
  expect(normal.failures).toEqual([]);
  const force = await cleanup({ run: stale(), cancelFailure: notQueued });
  expect(force.infos).toContain(
    "Force-cancellation requested for 1: queued over six hours",
  );
  expect(force.failures).toEqual([]);
});

test("another refusal containing the state message still fails", async () => {
  const result = await cleanup({
    run: stale(),
    cancelFailure: notQueued,
    forceFailure: {
      ...notQueued,
      message: `Other refusal: ${notQueued.message}`,
    },
    followingRun: { ...stale(), id: 2 },
  });
  expect(result.failures).toEqual([
    "1 queued PR run(s) could not be cancelled",
  ]);
  expect(result.infos).toContain(
    "Cancellation requested for 2: queued over six hours",
  );
});
