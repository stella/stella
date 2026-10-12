import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

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

  test("starts one run per pull request, on that pull request's own branch", async () => {
    const dispatched: Record<string, unknown>[] = [];
    await dispatch.runInNewContext({
      setTimeout,
      context: { repo: { owner: "stella", repo: "stella" } },
      core: { notice: () => {} },
      github: {
        rest: {
          repos: {
            getBranch: async () => ({ data: { commit: { sha: MAIN } } }),
          },
          actions: {
            createWorkflowDispatch: async (
              request: Record<string, unknown>,
            ) => {
              dispatched.push(request);
            },
          },
        },
        graphql: async () => ({
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                pull({}),
                pull({
                  number: 2,
                  headRefName: "feat/b",
                  headRefOid: "c".repeat(40),
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
              ],
            },
          },
        }),
      },
    });
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

describe("resolve", () => {
  const job = workflows.resolve.jobs["resolve"];

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
        expect(step.with?.["save"]).toBe(false);
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
    run: Record<string, unknown>;
    pulls: Record<string, unknown>[];
  };
  const scenario = (): Scenario => ({
    run: {
      id: 9,
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
  });
  const selectFor = async (input: Scenario) => {
    const outputs: Record<string, string> = {};
    await select.runInNewContext({
      context: {
        repo: { owner: "stella", repo: "stella" },
        payload: { workflow_run: input.run },
      },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        rest: { pulls: { list: "pulls.list" } },
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

  test("publishes only to the branch the resolve run ran on", async () => {
    expect(await selectFor(scenario())).toEqual({
      branch: "feat/a",
      head: HEAD,
      run: "9",
    });
  });

  const refused: { name: string; change: (input: Scenario) => void }[] = [
    {
      name: "another workflow's run",
      change: (input) => (input.run["path"] = ".github/workflows/other.yml"),
    },
    {
      name: "a non-dispatch run",
      change: (input) => (input.run["event"] = "push"),
    },
    {
      name: "a run on main",
      change: (input) => (input.run["head_branch"] = "main"),
    },
    {
      name: "a fork",
      change: (input) =>
        (input.run["head_repository"] = { full_name: "someone/stella" }),
    },
    {
      // A run on another pull request's branch cannot reach this one: the
      // pull request is looked up from the run's own branch.
      name: "a branch with no open pull request",
      change: (input) => (input.pulls = []),
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
      name: "two pull requests from one branch",
      change: (input) => input.pulls.push({ ...input.pulls[0], number: 2 }),
    },
  ];
  for (const { name, change } of refused) {
    test(`refuses ${name}`, async () => {
      const input = scenario();
      change(input);
      expect(await selectFor(input)).toEqual({});
    });
  }

  test("reads only the triggering run's artifact and never checks out the branch", () => {
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
