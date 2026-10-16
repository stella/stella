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
  pullState?: string;
  draft?: boolean;
  labels?: string[];
  // Pull requests found by the run's commit when it has no association.
  commitPulls?: { labels: string[] }[] | "error";
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
  pullState = "open",
  draft = false,
  labels = [],
  commitPulls = [],
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
        repos: {
          listPullRequestsAssociatedWithCommit: async () => {
            if (commitPulls === "error") {
              throw Object.assign(new Error("Unavailable"), { status: 500 });
            }
            return {
              data: commitPulls.map((pull) => ({
                labels: pull.labels.map((name) => ({ name })),
              })),
            };
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
            return {
              data: {
                state: pullState,
                draft,
                head: { sha: head },
                labels: labels.map((name) => ({ name })),
              },
            };
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

test.each([
  ["superseded", { head: "current" }],
  ["closed", { pullState: "closed" }],
  ["draft", { draft: true }],
] as const)(
  "a %s run of a protected pull request is never cancelled",
  async (_label, options) => {
    const run = {
      ...queued("pull_request"),
      pull_requests: [{ number: 12, head: { sha: "old" } }],
    };
    const result = await cleanup({ run, labels: ["ci-protect"], ...options });
    expect(result.cancelled).toEqual([]);
    expect(result.forced).toEqual([]);
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
    ...queued("pull_request"),
    pull_requests: [],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  const result = await cleanup({ run });
  expect(result.cancelled).toEqual([1]);
  expect(result.readPulls).toEqual([]);
});

test("a protected pull request's run is not cancelled even after six hours", async () => {
  const run = {
    ...queued("pull_request"),
    pull_requests: [{ number: 12, head: { sha: "current" } }],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  const result = await cleanup({ run, labels: ["ci-protect"] });
  expect(result.cancelled).toEqual([]);
  expect(result.forced).toEqual([]);
});

test("an old run whose pull request labels cannot be read is not cancelled", async () => {
  const run = {
    ...queued("pull_request"),
    pull_requests: [{ number: 12, head: { sha: "current" } }],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  for (const metadataStatus of [403, 404]) {
    const result = await cleanup({ run, metadataStatus });
    expect(result.cancelled, String(metadataStatus)).toEqual([]);
    expect(result.forced, String(metadataStatus)).toEqual([]);
  }
});

test("an old run without an association is matched to its pull requests by commit", async () => {
  const run = {
    ...queued("pull_request"),
    pull_requests: [],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  for (const commitPulls of [[{ labels: ["ci-protect"] }], "error"] as const) {
    const result = await cleanup({
      run,
      commitPulls: commitPulls === "error" ? "error" : [...commitPulls],
    });
    expect(result.cancelled, JSON.stringify(commitPulls)).toEqual([]);
    expect(result.forced, JSON.stringify(commitPulls)).toEqual([]);
  }
});

test("an old target run without an association is left alone", async () => {
  const run = {
    ...queued("pull_request_target"),
    pull_requests: [],
    created_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  };
  const result = await cleanup({ run, commitPulls: [] });
  expect(result.cancelled).toEqual([]);
  expect(result.forced).toEqual([]);
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

test.each([
  ["closed", false, "pull request closed"],
  ["open", true, "draft pull request"],
] as const)(
  "a queued run for a %s pull request (draft: %s) is cancelled",
  async (pullState, draft, reason) => {
    const result = await cleanup({
      run: queued("pull_request"),
      head: "current",
      pullState,
      draft,
    });
    expect(result.cancelled).toEqual([1]);
    expect(result.infos).toContain(`Cancellation requested for 1: ${reason}`);
  },
);

const resumeSource = workflow.jobs.cleanup.steps.at(1)?.with.script;
if (!resumeSource) {
  throw new Error("Missing resume script");
}
const resumeScript = new Script(`(async () => {\n${resumeSource}\n})()`);

type DeferredPull = {
  number: number;
  head: string;
  yieldState?: string;
  deferredMinutesAgo?: number;
  draft?: boolean;
  fork?: boolean;
  run?: { id: number; status: string; conclusion: string | null };
};
const LIFECYCLE = ["requested", "waiting", "pending", "queued", "in_progress"];
const resume = async ({
  waiting = false,
  pages,
  rerunFailure = false,
  inFlight = [],
}: {
  waiting?: boolean;
  pages: DeferredPull[][];
  rerunFailure?: boolean;
  inFlight?: { status: string; run_attempt: number; advances?: boolean }[];
}) => {
  const reruns: number[] = [];
  const routes: string[] = [];
  const statuses: { sha: string; state: string }[] = [];
  const events: string[] = [];
  const pulls = pages.flat();
  const listWorkflowRuns = async ({ head_sha }: { head_sha: string }) => {
    const pull = pulls.find((candidate) => candidate.head === head_sha);
    const run = pull?.run ?? {
      id: (pull?.number ?? 0) * 10,
      status: "completed",
      conclusion: "cancelled",
    };
    return { data: { workflow_runs: [run] } };
  };
  let failure: unknown;
  await resumeScript
    .runInNewContext({
      context: {
        repo: { owner: "test", repo: "test" },
        serverUrl: "https://github.com",
      },
      core: { info: () => {} },
      github: {
        paginate: async (
          method: unknown,
          { status }: { status?: string } = {},
        ) => {
          if (method !== listWorkflowRuns) {
            return [];
          }
          const page = inFlight.filter((run) => run.status === status);
          // A run that advances moves one lifecycle state after every read.
          for (const run of inFlight) {
            const next = LIFECYCLE[LIFECYCLE.indexOf(run.status) + 1];
            if (run.advances && next !== undefined) {
              run.status = next;
            }
          }
          return page.map((run) => ({ ...run }));
        },
        graphql: async (
          _query: string,
          { after }: { after: string | null },
        ) => {
          const index = after === null ? 0 : Number(after);
          return {
            repository: {
              pullRequests: {
                pageInfo: {
                  hasNextPage: index + 1 < pages.length,
                  endCursor: String(index + 1),
                },
                nodes: (pages[index] ?? []).map((pull) => ({
                  number: pull.number,
                  isDraft: pull.draft ?? false,
                  headRefOid: pull.head,
                  headRepository: {
                    nameWithOwner: pull.fork ? "fork/test" : "test/test",
                  },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          status: {
                            context: {
                              state: pull.yieldState ?? "PENDING",
                              createdAt: new Date(
                                Date.now() -
                                  (pull.deferredMinutesAgo ?? 1) * 60 * 1000,
                              ).toISOString(),
                            },
                          },
                        },
                      },
                    ],
                  },
                })),
              },
            },
          };
        },
        request: async (route: string, { run_id }: { run_id: number }) => {
          routes.push(route);
          events.push(`rerun:${run_id}`);
          if (rerunFailure) {
            throw new Error("rerun refused");
          }
          reruns.push(run_id);
        },
        rest: {
          actions: {
            listWorkflowRunsForRepo: async ({
              status,
            }: {
              status: string;
            }) => ({
              data: {
                total_count: waiting && status === "queued" ? 1 : 0,
                workflow_runs: [],
              },
            }),
            listWorkflowRuns,
          },
          repos: {
            createCommitStatus: async ({
              sha,
              state,
            }: {
              sha: string;
              state: string;
            }) => {
              events.push(`status:${sha}:${state}`);
              statuses.push({ sha, state });
            },
          },
        },
      },
    })
    .catch((error: unknown) => {
      failure = error;
    });
  return { reruns, routes, statuses, events, failure };
};

const deferred = (count: number, from = 1): DeferredPull[] =>
  Array.from({ length: count }, (_, index) => ({
    number: from + index,
    head: `head-${from + index}`,
  }));

test("while the merge queue waits, only the oldest deferred head resumes each tick", async () => {
  const result = await resume({
    waiting: true,
    pages: [
      [
        { number: 1, head: "head-1", deferredMinutesAgo: 5 },
        { number: 2, head: "head-2", deferredMinutesAgo: 45 },
        { number: 3, head: "head-3", deferredMinutesAgo: 31 },
      ],
    ],
  });
  expect(result.reruns).toEqual([20]);
});

test.each(["in_progress", "queued", "pending", "waiting", "requested"])(
  "while the merge queue waits, nothing resumes until the resumed run (%s) finishes",
  async (status) => {
    const result = await resume({
      waiting: true,
      inFlight: [
        { status, run_attempt: 2 },
        { status: "in_progress", run_attempt: 1 },
      ],
      pages: [
        [
          { number: 1, head: "head-1", deferredMinutesAgo: 90 },
          { number: 2, head: "head-2", deferredMinutesAgo: 60 },
        ],
      ],
    });
    expect(result.reruns).toEqual([]);
    expect(result.statuses).toEqual([]);
  },
);

test.each(LIFECYCLE)(
  "a resumed run that starts %s and changes state between reads still holds back a resume",
  async (status) => {
    const result = await resume({
      waiting: true,
      inFlight: [{ status, run_attempt: 2, advances: true }],
      pages: [deferred(2)],
    });
    expect(result.reruns).toEqual([]);
  },
);

test("a resumed run beyond the first page of runs still holds back a resume", async () => {
  const result = await resume({
    waiting: true,
    inFlight: [
      ...Array.from({ length: 100 }, () => ({
        status: "in_progress",
        run_attempt: 1,
      })),
      { status: "in_progress", run_attempt: 2 },
    ],
    pages: [deferred(2)],
  });
  expect(result.reruns).toEqual([]);
});

test("first-attempt pull request runs never hold back a resume", async () => {
  const result = await resume({
    waiting: true,
    inFlight: [
      { status: "in_progress", run_attempt: 1 },
      { status: "queued", run_attempt: 1 },
    ],
    pages: [deferred(3)],
  });
  expect(result.reruns).toEqual([10]);
});

test("a cleared queue resumes a few at a time even with a resumed run in flight", async () => {
  const result = await resume({
    inFlight: [{ status: "in_progress", run_attempt: 2 }],
    pages: [deferred(6)],
  });
  expect(result.reruns).toEqual([10, 20, 30, 40]);
});

test("a cleared queue resumes deferred runs a few at a time and marks them", async () => {
  const result = await resume({ pages: [deferred(6)] });
  expect(result.reruns).toEqual([10, 20, 30, 40]);
  expect(result.statuses).toEqual(
    [1, 2, 3, 4].map((number) => ({ sha: `head-${number}`, state: "success" })),
  );
});

test("only open, same-repository, pending, cancelled heads are resumed", async () => {
  const result = await resume({
    pages: [
      [
        { number: 1, head: "head-1", yieldState: "SUCCESS" },
        { number: 2, head: "head-2", draft: true },
        { number: 3, head: "head-3", fork: true },
        {
          number: 4,
          head: "head-4",
          run: { id: 40, status: "in_progress", conclusion: null },
        },
        {
          number: 5,
          head: "head-5",
          run: { id: 50, status: "completed", conclusion: "failure" },
        },
        { number: 6, head: "head-6" },
      ],
    ],
  });
  expect(result.reruns).toEqual([60]);
});

test("a deferred head far down the pull request list is still found", async () => {
  const filler = (page: number): DeferredPull[] =>
    deferred(100, page * 100 + 1).map((pull) => ({
      ...pull,
      yieldState: "SUCCESS",
    }));
  const result = await resume({
    pages: [...[0, 1, 2, 3, 4, 5].map(filler), deferred(1, 9001)],
  });
  expect(result.reruns).toEqual([90_010]);
});

test("a resume re-runs only the cancelled jobs, keeping finished ones", async () => {
  const result = await resume({ pages: [deferred(1)] });
  expect(result.routes).toEqual([
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs",
  ]);
});

test("a resumed head is marked before its re-run can defer again", async () => {
  const result = await resume({ pages: [deferred(1)] });
  expect(result.events).toEqual(["status:head-1:success", "rerun:10"]);
});

test("a refused re-run returns its head to the deferred state", async () => {
  const result = await resume({ pages: [deferred(1)], rerunFailure: true });
  expect(result.failure).toBeInstanceOf(Error);
  expect(result.statuses).toEqual([
    { sha: "head-1", state: "success" },
    { sha: "head-1", state: "pending" },
  ]);
});

const deferSource = workflow.jobs.cleanup.steps.at(2)?.with.script;
if (!deferSource) {
  throw new Error("Missing defer script");
}
const deferScript = new Script(`(async () => {\n${deferSource}\n})()`);

type PullRun = {
  id: number;
  head: string;
  attempt?: number;
  fork?: boolean;
  actor?: string;
  jobs: string[];
  protected?: boolean;
  noPull?: boolean;
  // Extra associated pull requests, after the run's own (number = run id).
  extraPulls?: { number: number; protected?: boolean }[];
};
const defer = async ({
  waiting = true,
  runs,
  cancelFailure = false,
}: {
  waiting?: boolean;
  runs: PullRun[];
  cancelFailure?: boolean;
}) => {
  const cancelled: number[] = [];
  const events: string[] = [];
  await deferScript.runInNewContext({
    context: {
      repo: { owner: "test", repo: "test" },
      serverUrl: "https://github.com",
    },
    core: { info: () => {}, warning: () => {} },
    github: {
      paginate: async (
        method: { name: string },
        { run_id }: { run_id?: number },
      ) => {
        if (method.name === "listJobsForWorkflowRun") {
          const run = runs.find((candidate) => candidate.id === run_id);
          return (run?.jobs ?? []).map((status) => ({ status }));
        }
        return runs.map((run) => ({
          id: run.id,
          head_sha: run.head,
          run_attempt: run.attempt ?? 1,
          head_repository: {
            full_name: run.fork ? "fork/test" : "test/test",
          },
          triggering_actor: { login: run.actor ?? "octocat" },
          pull_requests: run.noPull
            ? []
            : [
                { number: run.id },
                ...(run.extraPulls ?? []).map(({ number }) => ({ number })),
              ],
        }));
      },
      rest: {
        actions: {
          listJobsForWorkflowRun: function listJobsForWorkflowRun() {},
          listWorkflowRuns: function listWorkflowRuns() {},
          listWorkflowRunsForRepo: async ({ status }: { status: string }) => ({
            data: {
              total_count: waiting && status === "queued" ? 1 : 0,
              workflow_runs: [],
            },
          }),
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            events.push(`cancel:${run_id}`);
            if (cancelFailure) {
              throw new Error("cancel refused");
            }
            cancelled.push(run_id);
          },
        },
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            const own = runs.find((run) => run.id === pull_number);
            const extra = runs
              .flatMap((run) => run.extraPulls ?? [])
              .find((pull) => pull.number === pull_number);
            return {
              data: {
                labels:
                  (own?.protected ?? extra?.protected)
                    ? [{ name: "ci-protect" }]
                    : [],
              },
            };
          },
        },
        repos: {
          createCommitStatus: async ({
            sha,
            state,
          }: {
            sha: string;
            state: string;
          }) => {
            events.push(`status:${sha}:${state}`);
          },
        },
      },
    },
  });
  return { cancelled, events };
};

test("nothing is deferred while the merge queue has no waiting work", async () => {
  const result = await defer({
    waiting: false,
    runs: [{ id: 1, head: "head-1", jobs: ["completed", "queued"] }],
  });
  expect(result.events).toEqual([]);
});

test("a run with only queued jobs left is marked deferred, then cancelled", async () => {
  const result = await defer({
    runs: [{ id: 1, head: "head-1", jobs: ["completed", "queued", "waiting"] }],
  });
  expect(result.events).toEqual(["status:head-1:pending", "cancel:1"]);
});

test("a run with work in progress, or nothing queued, keeps running", async () => {
  const result = await defer({
    runs: [
      { id: 1, head: "head-1", jobs: ["completed", "in_progress", "queued"] },
      { id: 2, head: "head-2", jobs: ["completed", "in_progress"] },
    ],
  });
  expect(result.events).toEqual([]);
});

test("resumed, fork and Dependabot runs are never deferred", async () => {
  const result = await defer({
    runs: [
      { id: 1, head: "head-1", attempt: 2, jobs: ["queued"] },
      { id: 2, head: "head-2", fork: true, jobs: ["queued"] },
      { id: 3, head: "head-3", actor: "dependabot[bot]", jobs: ["queued"] },
      { id: 4, head: "head-4", jobs: ["queued"] },
    ],
  });
  expect(result.cancelled).toEqual([4]);
});

test("a refused cancellation clears the deferral record", async () => {
  const result = await defer({
    runs: [{ id: 1, head: "head-1", jobs: ["queued"] }],
    cancelFailure: true,
  });
  expect(result.events).toEqual([
    "status:head-1:pending",
    "cancel:1",
    "status:head-1:success",
  ]);
});

test("a protected or unresolvable pull request is never deferred", async () => {
  const result = await defer({
    runs: [
      { id: 1, head: "head-1", protected: true, jobs: ["queued"] },
      { id: 2, head: "head-2", noPull: true, jobs: ["queued"] },
      { id: 3, head: "head-3", jobs: ["queued"] },
    ],
  });
  expect(result.cancelled).toEqual([3]);
  expect(result.events).toEqual(["status:head-3:pending", "cancel:3"]);
});

test("every steward step that cancels a run honours the ci-protect label", () => {
  const cancelling = workflow.jobs.cleanup.steps.filter((step) =>
    /cancelWorkflowRun|force-cancel/u.test(step.with.script),
  );
  expect(cancelling.length).toBeGreaterThan(0);
  for (const [index, step] of cancelling.entries()) {
    expect(step.with.script, `cancelling step ${index}`).toContain(
      'PROTECT_LABEL = "ci-protect"',
    );
    expect(step.with.script, `cancelling step ${index}`).toMatch(
      /labels\?\.some\(\(label\) => label\.name === PROTECT_LABEL\)/u,
    );
  }
});

test("a run is not deferred when any of its pull requests is protected", async () => {
  const result = await defer({
    runs: [
      {
        id: 1,
        head: "head-1",
        jobs: ["queued"],
        extraPulls: [{ number: 77, protected: true }],
      },
    ],
  });
  expect(result.cancelled).toEqual([]);
  expect(result.events).toEqual([]);
});
