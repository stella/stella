import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import {
  CANCEL_STEP,
  REQUEUE_CONTEXT,
  RESULT_JOB,
  RESULT_STEP,
  applyRequeues,
  decideRequeue,
  parseEntries,
  planRequeues,
} from "./merge-group-requeue.mjs";

const root = path.resolve(import.meta.dirname, "..");

type Step = { name: string; conclusion: string | null };
type Job = { name: string; conclusion: string | null; steps: Step[] };

type Entry = Parameters<typeof decideRequeue>[0]["entry"];
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  state: "UNMERGEABLE",
  headCommitOid: "group-sha",
  pullRequestId: "PR_1",
  number: 6037,
  headRefOid: "head-sha",
  attemptState: null,
  ...overrides,
});

const cancelledRun = {
  id: 39_063_948_317,
  status: "completed",
  conclusion: "cancelled",
  created_at: "2026-10-17T20:10:00Z",
};

// The jobs of run 39063948317: a step stopped by the run-level cancel and the
// outcome evaluation that fails because of it.
const externallyCancelled: Job[] = [
  {
    name: "code-quality-web-rest",
    conclusion: "failure",
    steps: [
      { name: "Set up job", conclusion: "success" },
      { name: "Code quality (web)", conclusion: "cancelled" },
    ],
  },
  {
    name: RESULT_JOB,
    conclusion: "failure",
    steps: [{ name: RESULT_STEP, conclusion: "failure" }],
  },
];

const realFailure: Job[] = [
  {
    name: "ci-tests (2)",
    conclusion: "failure",
    steps: [
      { name: "Run tests", conclusion: "failure" },
      { name: CANCEL_STEP, conclusion: "success" },
    ],
  },
  {
    name: RESULT_JOB,
    conclusion: "failure",
    steps: [{ name: RESULT_STEP, conclusion: "failure" }],
  },
];

describe("decideRequeue", () => {
  test("requeues a group cancelled with no failed step", () => {
    expect(
      decideRequeue({
        entry: entry(),
        run: cancelledRun,
        jobs: externallyCancelled,
      }),
    ).toMatchObject({ action: "requeue" });
  });

  test("leaves a real failed step alone", () => {
    const decision = decideRequeue({
      entry: entry(),
      run: cancelledRun,
      jobs: [
        {
          name: "lint",
          conclusion: "failure",
          steps: [{ name: "Lint", conclusion: "failure" }],
        },
        ...externallyCancelled,
      ],
    });
    expect(decision).toEqual({
      action: "skip",
      reason: "run 39063948317 has failed steps: lint / Lint",
    });
  });

  test("leaves a group alone that cancelled itself after a real failure", () => {
    expect(
      decideRequeue({ entry: entry(), run: cancelledRun, jobs: realFailure }),
    ).toMatchObject({
      action: "skip",
      reason: "run 39063948317 has failed steps: ci-tests (2) / Run tests",
    });
  });

  test("counts the outcome step as real outside ci-result", () => {
    expect(
      decideRequeue({
        entry: entry(),
        run: cancelledRun,
        jobs: [
          {
            name: "other",
            conclusion: "failure",
            steps: [{ name: RESULT_STEP, conclusion: "failure" }],
          },
        ],
      }).action,
    ).toBe("skip");
  });

  test("a second cancel on the same head is exhausted, not requeued", () => {
    for (const attemptState of ["SUCCESS", "ERROR"]) {
      expect(
        decideRequeue({
          entry: entry({ attemptState }),
          run: cancelledRun,
          jobs: externallyCancelled,
        }).action,
      ).toBe("exhausted");
    }
  });

  test("a real failure on an attempted head stays a plain skip", () => {
    expect(
      decideRequeue({
        entry: entry({ attemptState: "SUCCESS" }),
        run: cancelledRun,
        jobs: realFailure,
      }).action,
    ).toBe("skip");
  });

  test("a missing, running or failed run is left alone", () => {
    expect(decideRequeue({ entry: entry(), run: undefined, jobs: [] })).toEqual(
      {
        action: "skip",
        reason: "no CI Checks run for the merge group",
      },
    );
    expect(
      decideRequeue({
        entry: entry(),
        run: { ...cancelledRun, status: "in_progress", conclusion: null },
        jobs: [],
      }).action,
    ).toBe("skip");
    expect(
      decideRequeue({
        entry: entry(),
        run: { ...cancelledRun, conclusion: "failure" },
        jobs: externallyCancelled,
      }).action,
    ).toBe("skip");
  });

  test("an entry that is not unmergeable is left alone", () => {
    for (const state of ["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED"]) {
      expect(
        decideRequeue({
          entry: entry({ state }),
          run: cancelledRun,
          jobs: externallyCancelled,
        }),
      ).toEqual({ action: "skip", reason: `entry is ${state}` });
    }
  });
});

describe("step names match the CI workflow", () => {
  const workflow = v.parse(
    v.object({
      jobs: v.record(
        v.string(),
        v.object({
          steps: v.optional(
            v.array(v.looseObject({ name: v.optional(v.string()) })),
            [],
          ),
        }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );

  test("the discounted self-cancel step is the canonical one", () => {
    expect(CANCEL_STEP).toBe(CANONICAL_CANCEL_STEP.name);
    expect(
      Object.values(workflow.jobs).some(({ steps }) =>
        steps.some(({ name }) => name === CANCEL_STEP),
      ),
    ).toBe(true);
  });

  test("ci-result evaluates the outcome in the discounted step", () => {
    expect(workflow.jobs[RESULT_JOB]?.steps.map(({ name }) => name)).toContain(
      RESULT_STEP,
    );
  });
});

type EntryNode = {
  state: string;
  headCommit: { oid: string } | null;
  pullRequest: {
    id: string;
    number: number;
    headRefOid: string;
    commits: {
      nodes: {
        commit: { oid: string; status: null | { context: { state: string } } };
      }[];
    };
  };
};

const entryNode = (overrides: Partial<EntryNode> = {}): EntryNode => ({
  state: "UNMERGEABLE",
  headCommit: { oid: "group-sha" },
  pullRequest: {
    id: "PR_1",
    number: 6037,
    headRefOid: "head-sha",
    commits: {
      nodes: [{ commit: { oid: "head-sha", status: null } }],
    },
  },
  ...overrides,
});

const queueData = (nodes: unknown[]) => ({
  repository: { mergeQueue: { entries: { nodes } } },
});

describe("parseEntries", () => {
  test("reads the requeue record on the pull request head", () => {
    const attempted = entryNode();
    attempted.pullRequest.commits.nodes[0] = {
      commit: {
        oid: "head-sha",
        status: { context: { state: "SUCCESS" } },
      },
    };
    expect(parseEntries(queueData([attempted, entryNode()]))).toEqual({
      entries: [{ ...entry(), attemptState: "SUCCESS" }, entry()],
      failure: null,
    });
  });

  test("drops an entry whose last commit is not the head", () => {
    const moved = entryNode();
    moved.pullRequest.commits.nodes[0] = {
      commit: { oid: "other", status: null },
    };
    expect(parseEntries(queueData([moved]))).toEqual({
      entries: [],
      failure: null,
    });
  });

  test("an entry with no merge group yet has no head commit", () => {
    expect(
      parseEntries(queueData([entryNode({ headCommit: null })])).entries[0]
        ?.headCommitOid,
    ).toBeNull();
  });

  test("an unreadable queue reports a failure instead of reading as empty", () => {
    expect(parseEntries({ repository: null })).toEqual({
      entries: [],
      failure: "Merge queue entries are unavailable",
    });
  });
});

const fakeGithub = ({
  nodes,
  runs = [],
  jobs = [],
}: {
  nodes: unknown[];
  runs?: (typeof cancelledRun)[];
  jobs?: Job[];
}) => {
  const calls: string[] = [];
  const statuses: { sha: string; state: string; context: string }[] = [];
  const listJobsForWorkflowRun = Symbol("listJobsForWorkflowRun");
  return {
    calls,
    statuses,
    github: {
      graphql: async (_query: string, variables: Record<string, unknown>) => {
        calls.push(`entries:${String(variables["context"])}`);
        return queueData(nodes);
      },
      paginate: async (method: unknown, options: Record<string, unknown>) => {
        expect(method).toBe(listJobsForWorkflowRun);
        calls.push(`jobs:${String(options["run_id"])}`);
        return jobs;
      },
      rest: {
        actions: {
          listJobsForWorkflowRun,
          listWorkflowRuns: async (options: Record<string, unknown>) => {
            calls.push(`runs:${String(options["head_sha"])}`);
            expect(options).toMatchObject({
              workflow_id: "ci.yml",
              event: "merge_group",
            });
            return { data: { workflow_runs: runs } };
          },
        },
        repos: {
          createCommitStatus: async (options: Record<string, unknown>) => {
            calls.push(`status:${String(options["state"])}`);
            statuses.push({
              sha: String(options["sha"]),
              state: String(options["state"]),
              context: String(options["context"]),
            });
          },
        },
      },
    },
  };
};

const repo = { owner: "stella", repo: "stella" };
const log = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (message: string) => lines.push(`info ${message}`),
      warning: (message: string) => lines.push(`warning ${message}`),
      error: (message: string) => lines.push(`error ${message}`),
    },
  };
};

describe("planRequeues", () => {
  test("reads only unmergeable entries and the newest run's jobs", async () => {
    const fake = fakeGithub({
      nodes: [entryNode(), entryNode({ state: "AWAITING_CHECKS" })],
      runs: [
        { ...cancelledRun, id: 1, created_at: "2026-10-17T19:00:00Z" },
        cancelledRun,
      ],
      jobs: externallyCancelled,
    });
    const { plans, failure } = await planRequeues({
      github: fake.github,
      repo,
    });
    expect(failure).toBeNull();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      action: "requeue",
      runId: cancelledRun.id,
    });
    expect(fake.calls).toEqual([
      `entries:${REQUEUE_CONTEXT}`,
      "runs:group-sha",
      `jobs:${cancelledRun.id}`,
    ]);
  });

  test("a merge group with no run is left alone", async () => {
    const fake = fakeGithub({ nodes: [entryNode()] });
    expect(await planRequeues({ github: fake.github, repo })).toEqual({
      plans: [expect.objectContaining({ action: "skip", runId: null })],
      failure: null,
    });
    const noGroup = fakeGithub({ nodes: [entryNode({ headCommit: null })] });
    expect(
      (await planRequeues({ github: noGroup.github, repo })).plans[0]?.action,
    ).toBe("skip");
    expect(noGroup.calls).toEqual([`entries:${REQUEUE_CONTEXT}`]);
  });
});

const queueClient = (fail = false) => {
  const mutations: string[] = [];
  return {
    mutations,
    queue: {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        const name = query.includes("dequeuePullRequest")
          ? "dequeue"
          : "enqueue";
        mutations.push(`${name}:${JSON.stringify(variables)}`);
        if (fail && name === "enqueue") {
          throw new Error("enqueue refused");
        }
        return {};
      },
    },
  };
};

type Plan = Parameters<typeof applyRequeues>[0]["plans"][number];
const plan = (overrides: Partial<Plan>): Plan => ({
  ...entry(),
  action: "requeue",
  reason: "run 1 was cancelled with no failed step",
  runId: 1,
  ...overrides,
});

describe("applyRequeues", () => {
  test("records the attempt on the head before dequeuing and enqueuing it", async () => {
    const fake = fakeGithub({ nodes: [] });
    const { queue, mutations } = queueClient();
    const failed = await applyRequeues({
      github: fake.github,
      queue,
      repo,
      plans: [plan({})],
      runUrl: () => "url",
      log: log().log,
    });
    expect(failed).toBe(0);
    expect(fake.statuses).toEqual([
      { sha: "head-sha", state: "success", context: REQUEUE_CONTEXT },
    ]);
    expect(mutations).toEqual([
      'dequeue:{"id":"PR_1"}',
      'enqueue:{"id":"PR_1","head":"head-sha"}',
    ]);
  });

  test("an exhausted head is annotated once and never requeued", async () => {
    const fake = fakeGithub({ nodes: [] });
    const { queue, mutations } = queueClient();
    const output = log();
    await applyRequeues({
      github: fake.github,
      queue,
      repo,
      plans: [
        plan({ action: "exhausted", attemptState: "SUCCESS" }),
        plan({ action: "exhausted", attemptState: "ERROR", number: 6043 }),
      ],
      runUrl: () => "url",
      log: output.log,
    });
    expect(mutations).toEqual([]);
    expect(fake.statuses.map(({ state }) => state)).toEqual(["error"]);
    expect(
      output.lines.filter((line) => line.startsWith("warning")),
    ).toHaveLength(2);
  });

  test("a failed enqueue is reported and marks the head", async () => {
    const fake = fakeGithub({ nodes: [] });
    const { queue } = queueClient(true);
    const output = log();
    const failed = await applyRequeues({
      github: fake.github,
      queue,
      repo,
      plans: [plan({})],
      runUrl: () => "url",
      log: output.log,
    });
    expect(failed).toBe(1);
    expect(fake.statuses.map(({ state }) => state)).toEqual([
      "success",
      "error",
    ]);
    expect(output.lines.some((line) => line.startsWith("error #6037"))).toBe(
      true,
    );
  });

  test("without a queue token nothing is recorded or requeued", async () => {
    const fake = fakeGithub({ nodes: [] });
    const output = log();
    await applyRequeues({
      github: fake.github,
      queue: null,
      repo,
      plans: [plan({}), plan({ action: "skip", reason: "entry is QUEUED" })],
      runUrl: () => "url",
      log: output.log,
    });
    expect(fake.statuses).toEqual([]);
    expect(output.lines).toHaveLength(2);
  });
});

describe("workflow", () => {
  const moduleSource = readFileSync(
    path.join(root, "scripts/merge-group-requeue.mjs"),
    "utf-8",
  );
  const source = readFileSync(
    path.join(root, ".github/workflows/requeue-cancelled-merge-groups.yml"),
    "utf-8",
  );

  test("loads this module from its own commit", () => {
    expect(source).toContain(
      "sparse-checkout: scripts/merge-group-requeue.mjs",
    );
    expect(source).toContain(`ref: \${{ github.workflow_sha }}`);
    expect(source).toContain(".requeue/scripts/merge-group-requeue.mjs");
  });

  test("the sparse-checked-out module imports only Node builtins", () => {
    const moduleSpecifiers = [
      ...moduleSource.matchAll(
        /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/gu,
      ),
    ].map((match) => match[1]);

    expect(
      moduleSpecifiers.filter((specifier) => !specifier?.startsWith("node:")),
    ).toEqual([]);
  });

  test("reports an unavailable queue through the github-script boundary", () => {
    expect(source).toContain("if (failure !== null) core.setFailed(failure);");
  });

  test("enqueues only with the App token and only outside a merge hold", () => {
    expect(source).toContain(
      "if: steps.plan.outputs.requeue == 'true' && vars.STELLA_MERGE_HOLD == ''",
    );
    expect(source).toContain(
      `QUEUE_TOKEN: \${{ steps.app-token.outputs.token }}`,
    );
    expect(source).toContain("queue: token ? getOctokit(token) : null");
  });
});
