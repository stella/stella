import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { GENERATED_MERGE_HEADLINE } from "./generated-conflicts";
import { MAIN_ONLY_BUN_CACHE_SAVE } from "./workflow-cache-policy";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const read = (name: string) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf-8",
  );
const parse = (name: string): unknown => Bun.YAML.parse(read(name));

const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.unknown())),
});
const jobSchema = v.looseObject({
  if: v.optional(v.string()),
  environment: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  steps: v.array(stepSchema),
});
const workflowSchema = v.looseObject({
  concurrency: v.object({
    group: v.string(),
    "cancel-in-progress": v.boolean(),
  }),
  jobs: v.record(v.string(), jobSchema),
});

const DISPATCH = "autofix-generated-conflicts.yml";
const RESOLVE = "generated-conflicts-resolve.yml";
const PUBLISH = "generated-conflicts-publish.yml";
const workflows = {
  dispatch: v.parse(workflowSchema, parse(DISPATCH)),
  resolve: v.parse(workflowSchema, parse(RESOLVE)),
  publish: v.parse(workflowSchema, parse(PUBLISH)),
};
const script = (file: string, job: string, step: string) =>
  new Script(
    `(async () => { ${
      v.parse(
        v.object({ script: v.string() }),
        workflowStepByName(workflowJobSteps(parse(file), job), step)["with"],
      ).script
    } })()`,
  );

// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);

// Where a dispatched run's id comes from: the dispatch answer, a listing
// after it, or nowhere.
type RunIdSource = "named" | "listed" | "missing";

describe("dispatch", () => {
  const dispatch = script(
    DISPATCH,
    "dispatch",
    "Dispatch one resolve run per conflicting pull request",
  );
  const pull = (overrides: Record<string, unknown>) => ({
    number: 1,
    mergeable: "CONFLICTING",
    isCrossRepository: false,
    headRefName: "feat/a",
    headRefOid: HEAD,
    author: { login: "someone" },
    ...overrides,
  });

  const run = async (
    nodes: Record<string, unknown>[],
    plannedHeads: string[] = [],
    refusedRefs: string[] = [],
    failingStatus?: number,
    runId: RunIdSource = "named",
  ) => {
    const dispatched: Record<string, unknown>[] = [];
    const outputs: Record<string, string> = {};
    const warnings: string[] = [];
    const info: string[] = [];
    const summaries: string[] = [];
    await dispatch.runInNewContext({
      setTimeout: (resolve: () => void) => {
        resolve();
      },
      context: { repo: { owner: "stella", repo: "stella" } },
      core: {
        info: (message: string) => {
          info.push(message);
        },
        summary: {
          addRaw: (message: string) => {
            summaries.push(message);
            return { write: async () => {} };
          },
        },
        notice: () => {},
        warning: (message: string) => {
          warnings.push(message);
        },
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        rest: {
          repos: {
            getBranch: async () => ({ data: { commit: { sha: MAIN } } }),
          },
          actions: {
            listWorkflowRuns: async (request: Record<string, unknown>) => {
              expect(request["workflow_id"]).toBe(RESOLVE);
              // The lookup of a dispatch that named no run.
              if (request["branch"] !== undefined) {
                const lookup = v.parse(
                  v.looseObject({
                    branch: v.string(),
                    event: v.literal("workflow_dispatch"),
                    created: v.pipe(v.string(), v.regex(/^>=\d{4}-/u)),
                  }),
                  request,
                );
                const index = dispatched.findIndex(
                  (entry) => entry["ref"] === lookup.branch,
                );
                return {
                  data: {
                    workflow_runs:
                      runId === "listed"
                        ? [
                            {
                              id: 1001 + index,
                              display_title: `Resolve generated-only conflicts on ${lookup.branch}`,
                            },
                            { id: 9999, display_title: "Some other run" },
                          ]
                        : [],
                  },
                };
              }
              return {
                data: {
                  workflow_runs: plannedHeads.map((head) => ({
                    head_sha: head,
                  })),
                },
              };
            },
            createWorkflowDispatch: async (
              request: Record<string, unknown>,
            ) => {
              if (failingStatus !== undefined) {
                throw Object.assign(new Error("Request failed"), {
                  status: failingStatus,
                });
              }
              if (refusedRefs.includes(String(request["ref"]))) {
                throw Object.assign(new Error("Unprocessable Entity"), {
                  status: 422,
                });
              }
              expect(request["return_run_details"]).toBe(true);
              const { return_run_details: _, ...accepted } = request;
              dispatched.push(accepted);
              return {
                data:
                  runId === "named"
                    ? { workflow_run_id: 1000 + dispatched.length }
                    : undefined,
              };
            },
          },
        },
        graphql: async () => ({
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        }),
      },
    });
    // Every accepted dispatch whose run was found is followed by the
    // publish step; a run never found is only reported.
    expect(JSON.parse(outputs["runs"] ?? "")).toEqual(
      runId === "missing" ? [] : dispatched.map((_, index) => 1001 + index),
    );
    expect(warnings).toHaveLength(runId === "missing" ? dispatched.length : 0);
    return { dispatched, info, summaries, outputs };
  };
  const sha = (index: number) => index.toString(16).padStart(40, "0");
  const updatedAt = (day: number) =>
    `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`;

  test("starts one run per pull request, on that pull request's own branch", async () => {
    const { dispatched } = await run([
      pull({ updatedAt: updatedAt(2) }),
      pull({
        number: 2,
        headRefName: "feat/b",
        headRefOid: "c".repeat(40),
        updatedAt: updatedAt(1),
      }),
      pull({
        number: 3,
        isCrossRepository: true,
        headRefName: "fork",
      }),
      pull({ number: 4, headRefName: "main" }),
      pull({
        number: 5,
        mergeable: "MERGEABLE",
        headRefName: "clean",
      }),
      pull({
        number: 6,
        author: { login: "dependabot[bot]" },
        headRefName: "dep",
      }),
    ]);
    expect(dispatched).toEqual([
      {
        owner: "stella",
        repo: "stella",
        workflow_id: RESOLVE,
        ref: "feat/a",
        inputs: { head: HEAD, main: MAIN },
      },
      {
        owner: "stella",
        repo: "stella",
        workflow_id: RESOLVE,
        ref: "feat/b",
        inputs: { head: "c".repeat(40), main: MAIN },
      },
    ]);
  });

  test("ineligible pull requests never take a slot", async () => {
    const ineligible = Array.from({ length: 10 }, (_, index) =>
      pull({
        number: 100 + index,
        isCrossRepository: true,
        headRefName: `fork/${String(index)}`,
        updatedAt: updatedAt(20),
      }),
    );
    const { dispatched } = await run([
      ...ineligible,
      pull({ headRefName: "feat/late", updatedAt: updatedAt(1) }),
    ]);
    expect(dispatched.map((request) => request["ref"])).toEqual(["feat/late"]);
  });

  const committed = (minutesAgo: number) => ({
    nodes: [
      {
        commit: {
          committedDate: new Date(
            Date.now() - minutesAgo * 60_000,
          ).toISOString(),
        },
      },
    ],
  });

  test("defers a head committed 14 minutes ago and reports the typed skip", async () => {
    const result = await run([
      pull({ commits: committed(14), updatedAt: updatedAt(1) }),
    ]);
    expect(result.dispatched).toEqual([]);
    expect(result.info).toContain("deferred #1: head-active (14 min < 15)");
    expect(result.summaries).toEqual([
      "deferred #1: head-active (14 min < 15)\nresolved: 0; deferred-active: 1; other-skipped: 0\n",
    ]);
  });

  test("dispatches a head committed 16 minutes ago", async () => {
    const { dispatched } = await run([
      pull({ commits: committed(16), updatedAt: updatedAt(1) }),
    ]);
    expect(dispatched).toHaveLength(1);
  });

  test("dispatches a head whose committed date is missing", async () => {
    const { dispatched } = await run([
      pull({ commits: { nodes: [] }, updatedAt: updatedAt(1) }),
    ]);
    expect(dispatched).toHaveLength(1);
  });

  test("queries the head commit date", () => {
    expect(read(DISPATCH)).toContain(
      "committedDate messageHeadline statusCheckRollup { state }",
    );
  });

  test("a branch that refuses the dispatch never takes a slot", async () => {
    const refused = Array.from({ length: 8 }, (_, index) =>
      pull({
        number: 30 + index,
        headRefName: `old/${String(index)}`,
        headRefOid: sha(30 + index),
        updatedAt: updatedAt(20 + index),
      }),
    );
    const { dispatched } = await run(
      [
        ...refused,
        pull({
          number: 2,
          headRefName: "feat/conflicting",
          headRefOid: sha(2),
          updatedAt: updatedAt(1),
        }),
      ],
      [],
      refused.map((entry) => entry.headRefName),
    );
    expect(dispatched.map((request) => request["ref"])).toEqual([
      "feat/conflicting",
    ]);
  });

  test("a failure that is not a refused branch fails the run", async () => {
    for (const status of [403, 429, 502]) {
      expect(
        await rejectionOf(
          run([pull({ updatedAt: updatedAt(1) })], [], [], status),
        ),
      ).toMatchObject({ status });
    }
  });

  test("a dispatch that names no run is found by listing, never fails main", async () => {
    const pulls = [
      pull({ updatedAt: updatedAt(2) }),
      pull({
        number: 2,
        headRefName: "feat/b",
        headRefOid: "c".repeat(40),
        updatedAt: updatedAt(1),
      }),
    ];
    for (const source of ["listed", "missing"] as const) {
      expect(
        (await run(pulls, [], [], undefined, source)).dispatched.map(
          (request) => request["ref"],
        ),
        source,
      ).toEqual(["feat/a", "feat/b"]);
    }
  });

  test("green heads precede red heads even when green was already planned", async () => {
    const greenHead = pull({
      headRefName: "green/planned",
      updatedAt: updatedAt(1),
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
      },
    });
    const red = Array.from({ length: 8 }, (_, index) =>
      pull({
        number: index + 10,
        headRefName: `red/${index}`,
        headRefOid: sha(index + 10),
        updatedAt: updatedAt(20),
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }],
        },
      }),
    );
    const result = await run([...red, greenHead], [HEAD]);
    expect(result.dispatched[0]?.["ref"]).toBe("green/planned");
    expect(result.dispatched).toHaveLength(8);
  });

  test.each([0, 1, 2, 3, 4])(
    "%i published heads with pending checks reserve publication capacity",
    async (count) => {
      const active = Array.from({ length: count }, (_, index) =>
        pull({
          number: index + 10,
          mergeable: "MERGEABLE",
          headRefName: `active/${index}`,
          commits: {
            nodes: [
              {
                commit: {
                  messageHeadline:
                    "chore: merge main and regenerate conflicted generated files",
                  statusCheckRollup: { state: "FAILURE" },
                  checkSuites:
                    index % 2 === 0
                      ? { nodes: [{ status: "IN_PROGRESS" }] }
                      : null,
                },
              },
            ],
          },
        }),
      );
      const result = await run([...active, pull({})]);
      expect(result.outputs["publish-slots"]).toBe(
        String(Math.max(0, 3 - count)),
      );
      expect(result.dispatched).toHaveLength(count >= 3 ? 0 : 1);
      if (count >= 3) {
        expect(result.summaries.join("")).toContain("deferred #1: ci-capacity");
      }
    },
  );

  test.each(["SUCCESS", "FAILURE", "ERROR"])(
    "completed %s checks release capacity",
    async (state) => {
      const result = await run([
        pull({
          commits: {
            nodes: [
              {
                commit: {
                  messageHeadline:
                    "chore: merge main and regenerate conflicted generated files",
                  statusCheckRollup: { state },
                  checkSuites: { nodes: [{ status: "COMPLETED" }] },
                },
              },
            ],
          },
        }),
      ]);
      expect(result.outputs["publish-slots"]).toBe("3");
    },
  );

  test("unplanned heads go first, then the most recently updated", async () => {
    const stale = Array.from({ length: 8 }, (_, index) =>
      pull({
        number: 10 + index,
        headRefName: `stale/${String(index)}`,
        headRefOid: sha(10 + index),
        updatedAt: updatedAt(20 + index),
      }),
    );
    const { dispatched } = await run(
      [
        ...stale,
        pull({
          number: 2,
          headRefName: "fresh/old",
          headRefOid: sha(2),
          updatedAt: updatedAt(1),
        }),
        pull({
          number: 3,
          headRefName: "fresh/new",
          headRefOid: sha(3),
          updatedAt: updatedAt(5),
        }),
      ],
      stale.map((entry) => entry.headRefOid),
    );
    expect(dispatched.map((request) => request["ref"])).toEqual([
      "fresh/new",
      "fresh/old",
      "stale/7",
      "stale/6",
      "stale/5",
      "stale/4",
      "stale/3",
      "stale/2",
    ]);
  });

  test("capacity tracking uses the actual generated merge headline", () => {
    for (const file of [DISPATCH, PUBLISH]) {
      expect(read(file)).toContain(`=== '${GENERATED_MERGE_HEADLINE}'`);
    }
  });

  test("runs no branch code and holds no push key", () => {
    const job = workflows.dispatch.jobs["dispatch"];
    expect(
      job?.steps.every((step) =>
        step.uses?.startsWith("actions/github-script@"),
      ),
    ).toBe(true);
    expect(read(DISPATCH)).not.toContain("secrets.");
  });
});

describe("dispatch follows each resolve run to its publish", () => {
  const follow = script(DISPATCH, "dispatch", "Publish each resolution");
  type Run = { status: string; conclusion: string | null };
  const done = (conclusion: string): Run => ({
    status: "completed",
    conclusion,
  });
  const running: Run = { status: "in_progress", conclusion: null };
  type Scenario = {
    resolves: number[];
    // States each run reports on successive polls; the last one repeats.
    polls: Map<number, Run[]>;
    // Resolve runs that uploaded a resolution.
    uploaded: Set<number>;
    // Where each publish run's id comes from.
    publishRunId: RunIdSource;
    slots: number;
  };
  // Publish runs are numbered after the resolve run they publish.
  const publishOf = (resolve: number) => resolve + 100;
  const scenario = (): Scenario => ({
    resolves: [1, 2, 3],
    polls: new Map([
      [1, [running, done("success")]],
      [2, [done("success")]],
      [3, [done("failure")]],
      [101, [running, done("success")]],
      [102, [done("success")]],
    ]),
    uploaded: new Set([1, 2, 3]),
    publishRunId: "named",
    slots: 3,
  });
  const followFor = async (input: Scenario) => {
    const dispatches: Record<string, unknown>[] = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    const summaries: string[] = [];
    const reads = new Map<number, number>();
    await follow.runInNewContext({
      process: {
        env: {
          RUNS: JSON.stringify(input.resolves),
          PUBLISH_SLOTS: String(input.slots),
        },
      },
      setTimeout: (resolve: () => void) => {
        resolve();
      },
      context: { repo: { owner: "stella", repo: "stella" } },
      core: {
        summary: {
          addRaw: (message: string) => {
            summaries.push(message);
            return { write: async () => {} };
          },
        },
        warning: (message: string) => {
          warnings.push(message);
        },
        setFailed: (message: string) => {
          failures.push(message);
        },
      },
      github: {
        rest: {
          actions: {
            getWorkflowRun: async (params: Record<string, unknown>) => {
              const id = Number(params["run_id"]);
              const states = input.polls.get(id) ?? [running];
              const polled = reads.get(id) ?? 0;
              reads.set(id, polled + 1);
              return {
                data: {
                  html_url: `run/${String(id)}`,
                  ...states[Math.min(polled, states.length - 1)],
                },
              };
            },
            listWorkflowRunArtifacts: async (
              params: Record<string, unknown>,
            ) => {
              expect(params["name"]).toBe("generated-conflicts");
              return {
                data: {
                  artifacts: input.uploaded.has(Number(params["run_id"]))
                    ? [{ name: "generated-conflicts", expired: false }]
                    : [],
                },
              };
            },
            createWorkflowDispatch: async (
              request: Record<string, unknown>,
            ) => {
              expect(request["return_run_details"]).toBe(true);
              const { return_run_details: _, ...accepted } = request;
              dispatches.push(accepted);
              const inputs = v.parse(
                v.object({ resolve_run_id: v.string() }),
                request["inputs"],
              );
              return {
                data:
                  input.publishRunId === "named"
                    ? {
                        workflow_run_id: publishOf(
                          Number(inputs.resolve_run_id),
                        ),
                      }
                    : undefined,
              };
            },
            listWorkflowRuns: async (params: Record<string, unknown>) => {
              expect(params).toMatchObject({
                workflow_id: PUBLISH,
                branch: "main",
                event: "workflow_dispatch",
              });
              if (input.publishRunId === "missing") {
                return { data: { workflow_runs: [] } };
              }
              // Every publish dispatched so far is listed; the title names
              // the resolve run each one publishes.
              return {
                data: {
                  workflow_runs: dispatches.map((request) => {
                    const resolve = v.parse(
                      v.object({ resolve_run_id: v.string() }),
                      request["inputs"],
                    ).resolve_run_id;
                    return {
                      id: publishOf(Number(resolve)),
                      display_title: `Publish generated-only conflict resolution of run ${resolve}`,
                    };
                  }),
                },
              };
            },
          },
        },
      },
    });
    return { dispatches, failures, warnings, summaries };
  };

  test.each([0, 1, 2, 3])(
    "publishes at most %i available slots without queuing the remainder",
    async (slots) => {
      const input = scenario();
      input.slots = slots;
      const result = await followFor(input);
      expect(result.dispatches).toHaveLength(Math.min(slots, 2));
      expect(
        result.summaries.filter((line) =>
          line.includes("deferred-ci-capacity"),
        ),
      ).toHaveLength(Math.max(0, 2 - slots));
    },
  );

  test("an unconfirmed publication stops further dispatches", async () => {
    const input = scenario();
    input.slots = 1;
    input.publishRunId = "missing";
    const result = await followFor(input);
    expect(result.dispatches).toHaveLength(1);
    expect(result.summaries).toContain("resolve-run 1: publish-run-missing\n");
  });

  test("publishes exactly each successful resolve run, from main", async () => {
    const result = await followFor(scenario());
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.dispatches).toEqual(
      [1, 2].map((id) => ({
        owner: "stella",
        repo: "stella",
        workflow_id: PUBLISH,
        ref: "main",
        inputs: { resolve_run_id: String(id) },
      })),
    );
  });

  test("a publish run the dispatch did not name is found by its title", async () => {
    const input = scenario();
    input.publishRunId = "listed";
    const result = await followFor(input);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  test("a publish run never found is reported, never fails main", async () => {
    const input = scenario();
    input.publishRunId = "missing";
    const result = await followFor(input);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  test("a run that uploaded no resolution starts no publish", async () => {
    const input = scenario();
    input.uploaded.delete(2);
    const result = await followFor(input);
    expect(result.failures).toEqual([]);
    expect(result.dispatches.map((request) => request["inputs"])).toEqual([
      { resolve_run_id: "1" },
    ]);
  });

  // The failure this guards against: a resolution that was never published
  // while the run that started it finished green.
  for (const [name, change] of [
    [
      "a failed publish",
      (input: Scenario) => input.polls.set(101, [done("failure")]),
    ],
    [
      "a publish that never finishes",
      (input: Scenario) => input.polls.set(102, [running]),
    ],
    [
      "a resolve run that never finishes",
      (input: Scenario) => input.polls.set(2, [running]),
    ],
  ] as const) {
    test(`${name} fails the run`, async () => {
      const input = scenario();
      change(input);
      expect((await followFor(input)).failures).toHaveLength(1);
    });
  }

  test("runs only after resolve runs were started", () => {
    const step = workflows.dispatch.jobs["dispatch"]?.steps.find(
      (candidate) => candidate.name === "Publish each resolution",
    );
    expect(step?.if).toBe(
      "steps.dispatch.outputs.runs != '' && steps.dispatch.outputs.runs != '[]'",
    );
    expect(step?.env).toEqual({
      RUNS: githubExpression("steps.dispatch.outputs.runs"),
      PUBLISH_SLOTS: githubExpression("steps.dispatch.outputs.publish-slots"),
    });
  });
});

describe("resolve", () => {
  const job = workflows.resolve.jobs["resolve"];

  test("merged lockfiles refresh without lifecycle scripts before frozen install", () => {
    const steps = job?.steps ?? [];
    const refresh = steps.findIndex(
      (step) => step.name === "Re-resolve merged lockfile with frozen pins",
    );
    const install = steps.findIndex(
      (step) => step.name === "Install dependencies",
    );
    expect(refresh).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(install);
    expect(steps.at(refresh)?.["timeout-minutes"]).toBe(5);
    expect(steps.at(refresh)?.run).toContain("refresh-lock --repo .");
    expect(steps.at(install)?.run).toContain("bun ci --ignore-scripts");
    const regenerate = steps.find(
      (step) => step.name === "Regenerate conflicted outputs",
    );
    expect(regenerate?.run).toContain('if [[ -n "$GENERATOR_IDS" ]]');
  });

  test("never runs in a default-branch context and saves no cache", () => {
    // Branch code runs here. On a branch ref its caches and artifacts are
    // branch-scoped, so main, release and deploy runs never restore them.
    expect(job?.if).toContain("github.ref != 'refs/heads/main'");
    expect(job?.if).toContain("startsWith(github.ref, 'refs/heads/')");
    expect(job?.if).toContain("github.sha == inputs.head");
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(read(RESOLVE)).not.toContain("secrets.");
    expect(read(RESOLVE)).not.toContain("environment:");
    for (const step of job?.steps ?? []) {
      expect(step.uses?.startsWith("actions/cache") ?? false).toBe(false);
      if (step.uses?.includes("setup-bun-cached")) {
        expect(step.with?.["save"]).toBe(MAIN_ONLY_BUN_CACHE_SAVE);
      }
    }
    const upload = job?.steps.find(
      (step) => step.name === "Upload the resolution",
    );
    expect(upload?.with?.["name"]).toBe("generated-conflicts");
  });
});

describe("publish", () => {
  const job = workflows.publish.jobs["publish"];
  const select = script(PUBLISH, "publish", "Select the pull request");

  type Scenario = {
    runId: string;
    run: Record<string, unknown>;
    pulls: Record<string, unknown>[];
    artifacts: { name: string; expired: boolean }[];
    active: number;
  };
  const scenario = (): Scenario => ({
    runId: "9",
    active: 0,
    run: {
      id: 9,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/generated-conflicts-resolve.yml",
      event: "workflow_dispatch",
      head_branch: "feat/a",
      head_sha: HEAD,
      head_repository: { full_name: "stella/stella" },
    },
    pulls: [
      {
        number: 1,
        head: {
          ref: "feat/a",
          sha: HEAD,
          repo: { full_name: "stella/stella" },
        },
        base: { ref: "main" },
      },
    ],
    artifacts: [{ name: "generated-conflicts", expired: false }],
  });
  const selectFor = async (input: Scenario) => {
    const outputs: Record<string, string> = {};
    await select.runInNewContext({
      process: { env: { RESOLVE_RUN_ID: input.runId } },
      context: { repo: { owner: "stella", repo: "stella" } },
      core: {
        summary: { addRaw: () => ({ write: async () => {} }) },
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        graphql: async () => ({
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: Array.from({ length: input.active }, () => ({
                commits: {
                  nodes: [
                    {
                      commit: {
                        messageHeadline:
                          "chore: merge main and regenerate conflicted generated files",
                        statusCheckRollup: null,
                      },
                    },
                  ],
                },
              })),
            },
          },
        }),
        rest: {
          pulls: { list: "pulls.list" },
          actions: {
            getWorkflowRun: async (params: Record<string, unknown>) => {
              expect(params["run_id"]).toBe(Number(input.runId));
              return { data: input.run };
            },
            listWorkflowRunArtifacts: async (
              params: Record<string, unknown>,
            ) => {
              expect(params["run_id"]).toBe(input.run["id"]);
              expect(params["name"]).toBe("generated-conflicts");
              return { data: { artifacts: input.artifacts } };
            },
          },
        },
        paginate: async (route: unknown, params: Record<string, unknown>) => {
          expect(route).toBe("pulls.list");
          expect(params["head"]).toBe(
            `stella:${String(input.run["head_branch"])}`,
          );
          return input.pulls;
        },
      },
    });
    return outputs;
  };

  test.each([3, 4])(
    "defers publication with %i active published heads",
    async (active) => {
      const input = scenario();
      input.active = active;
      expect(await selectFor(input)).toEqual({});
      expect(workflows.publish.concurrency.group).toBe(
        githubExpression("github.workflow"),
      );
    },
  );

  test("publishes only to the branch the resolve run ran on", async () => {
    expect(await selectFor(scenario())).toEqual({
      branch: "feat/a",
      head: HEAD,
      run: "9",
    });
  });

  const refused: { name: string; change: (input: Scenario) => void }[] = [
    ...["", "0", "9x", "-9", "1".repeat(16)].map((runId) => ({
      name: `the run id ${JSON.stringify(runId)}`,
      change: (input: Scenario) => {
        input.runId = runId;
      },
    })),
    {
      name: "a failed resolve run",
      change: (input) => {
        input.run["conclusion"] = "failure";
      },
    },
    {
      name: "a resolve run still running",
      change: (input) => {
        input.run["status"] = "in_progress";
        input.run["conclusion"] = null;
      },
    },
    {
      name: "another workflow's run",
      change: (input) => {
        input.run["path"] = ".github/workflows/other.yml";
      },
    },
    {
      name: "a non-dispatch run",
      change: (input) => {
        input.run["event"] = "push";
      },
    },
    {
      name: "a run on main",
      change: (input) => {
        input.run["head_branch"] = "main";
      },
    },
    {
      name: "a fork",
      change: (input) => {
        input.run["head_repository"] = { full_name: "someone/stella" };
      },
    },
    {
      // A run on another pull request's branch cannot reach this one: the
      // pull request is looked up from the run's own branch.
      name: "a branch with no open pull request",
      change: (input) => {
        input.pulls = [];
      },
    },
    {
      name: "a branch that moved since the run started",
      change: (input) => {
        const pull = input.pulls[0];
        if (pull) {
          pull["head"] = {
            ref: "feat/a",
            sha: "e".repeat(40),
            repo: { full_name: "stella/stella" },
          };
        }
      },
    },
    {
      // A plan left to people uploads nothing.
      name: "a run that uploaded no resolution",
      change: (input) => {
        input.artifacts = [];
      },
    },
    {
      name: "an expired resolution",
      change: (input) => {
        input.artifacts = [{ name: "generated-conflicts", expired: true }];
      },
    },
    {
      name: "two pull requests from one branch",
      change: (input) => {
        input.pulls.push({ ...input.pulls[0], number: 2 });
      },
    },
  ];
  for (const { name, change } of refused) {
    test(`refuses ${name}`, async () => {
      const input = scenario();
      change(input);
      expect(await selectFor(input)).toEqual({});
    });
  }

  test("takes its resolve run from the dispatch input, on main only", () => {
    expect(job?.if).toBe(
      "github.repository == 'stella/stella' && github.ref == 'refs/heads/main'",
    );
    expect(
      v.parse(
        v.looseObject({ on: v.record(v.string(), v.unknown()) }),
        parse(PUBLISH),
      ).on,
    ).toEqual({
      workflow_dispatch: {
        inputs: {
          resolve_run_id: expect.objectContaining({
            required: true,
            type: "string",
          }),
        },
      },
    });
    expect(
      job?.steps.find((step) => step.name === "Select the pull request")?.env,
    ).toEqual({ RESOLVE_RUN_ID: githubExpression("inputs.resolve_run_id") });
  });

  test("reads only the dispatched run's artifact and never checks out the branch", () => {
    const steps = job?.steps ?? [];
    const download = steps.find(
      (step) => step.name === "Download the resolution",
    );
    expect(download?.with).toMatchObject({
      name: "generated-conflicts",
      "run-id": githubExpression("steps.select.outputs.run"),
    });
    const checkouts = steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with).toMatchObject({
      ref: githubExpression("github.workflow_sha"),
      path: ".trusted",
      "persist-credentials": false,
    });
    for (const step of steps) {
      expect(step.uses?.startsWith("./") ?? false).toBe(false);
      expect(step.run ?? "").not.toMatch(
        /\bbun (?:ci|install|run)\b|autofix-plan/u,
      );
    }
    const index = (name: string) =>
      steps.findIndex((step) => step.name === name);
    expect(index("Mint App token")).toBeGreaterThan(
      index("Rebuild and verify the merge"),
    );
    expect(index("Push the merge commit")).toBe(steps.length - 1);
    expect(job?.environment).toBe("release-app");
  });
});

test("no run cancels another mid-push", () => {
  for (const workflow of Object.values(workflows)) {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  }
});
