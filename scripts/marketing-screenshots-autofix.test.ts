import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
const readWorkflow = (name: string) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf-8",
  );
const autofixText = readWorkflow("marketing-screenshots-autofix.yml");
const autofix = Bun.YAML.parse(autofixText);
const reusableText = readWorkflow("marketing-screenshots.yml");
const reusable = Bun.YAML.parse(reusableText);
const dispatch = Bun.YAML.parse(
  readWorkflow("marketing-screenshots-update.yml"),
);

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
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  environment: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  secrets: v.optional(v.record(v.string(), v.string())),
  concurrency: v.optional(v.unknown()),
  steps: v.optional(v.array(stepSchema)),
});
const workflowSchema = v.looseObject({
  jobs: v.record(v.string(), jobSchema),
});
const reusableJobs = v.parse(workflowSchema, reusable).jobs;
const autofixJobs = v.parse(workflowSchema, autofix).jobs;
const stepsOf = (workflow: unknown, job: string) =>
  workflowJobSteps(workflow, job).map((step) => v.parse(stepSchema, step));

const selection = v.parse(
  v.object({ script: v.string() }),
  workflowStepByName(
    workflowJobSteps(autofix, "select"),
    "Select a pull request with a pixel diff",
  )["with"],
).script;
const selectionScript = new Script(`(async () => { ${selection} })()`);
const REGENERATION_HEADLINE =
  "chore(landing): regenerate marketing screenshots";
const HEAD = "a".repeat(40);

type Scenario = {
  run: Record<string, unknown>;
  artifacts: { name: string; expired: boolean }[];
  pull: {
    number: number;
    state: string;
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string; default_branch: string } };
  };
  headMessage: string;
};

const scenario = (): Scenario => ({
  run: {
    id: 7,
    event: "pull_request",
    head_sha: HEAD,
    head_branch: "feat/new-ui",
    pull_requests: [{ number: 42, head: { sha: HEAD } }],
  },
  artifacts: [{ name: "marketing-screenshots-pixel-diff", expired: false }],
  pull: {
    number: 42,
    state: "open",
    head: {
      ref: "feat/new-ui",
      sha: HEAD,
      repo: { full_name: "stella/stella" },
    },
    base: {
      repo: { full_name: "stella/stella", default_branch: "main" },
    },
  },
  headMessage: "feat(web): new UI\n\nBody",
});

const select = async (input: Scenario) => {
  const outputs: Record<string, string> = {};
  const notices: string[] = [];
  const pullsRead: number[] = [];
  await selectionScript.runInNewContext({
    context: {
      repo: { owner: "stella", repo: "stella" },
      payload: { workflow_run: input.run },
    },
    core: {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      notice: (message: string) => {
        notices.push(message);
      },
    },
    github: {
      paginate: async (route: string, params: Record<string, unknown>) => {
        expect(route).toBe(
          "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
        );
        expect(params["run_id"]).toBe(input.run["id"]);
        return input.artifacts;
      },
      rest: {
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            pullsRead.push(pull_number);
            return { data: input.pull };
          },
        },
        git: {
          getCommit: async ({ commit_sha }: { commit_sha: string }) => {
            expect(commit_sha).toBe(input.pull.head.sha);
            return { data: { message: input.headMessage } };
          },
        },
      },
    },
  });
  return { outputs, notices, pullsRead };
};

describe("pixel diff selection", () => {
  test("selects the current head of a same-repository pull request", async () => {
    expect((await select(scenario())).outputs).toEqual({
      branch: "feat/new-ui",
      sha: HEAD,
    });
  });

  test("maps a merge group run to its pull request's current head", async () => {
    const input = scenario();
    const next = "b".repeat(40);
    input.run = {
      id: 7,
      event: "merge_group",
      head_sha: "c".repeat(40),
      head_branch: `gh-readonly-queue/main/pr-42-${"d".repeat(40)}`,
      pull_requests: [],
    };
    input.pull.head.sha = next;
    const result = await select(input);
    expect(result.pullsRead).toEqual([42]);
    expect(result.outputs).toEqual({ branch: "feat/new-ui", sha: next });
  });

  const skipped: { name: string; change: (input: Scenario) => void }[] = [
    { name: "no pixel diff marker", change: (input) => (input.artifacts = []) },
    {
      name: "expired marker",
      change: (input) => {
        input.artifacts = [
          { name: "marketing-screenshots-pixel-diff", expired: true },
        ];
      },
    },
    {
      name: "other failure artifacts only",
      change: (input) => {
        input.artifacts = [
          { name: "marketing-screenshots-check-7-1", expired: false },
        ];
      },
    },
    {
      name: "fork head",
      change: (input) => {
        input.pull.head.repo = { full_name: "someone/stella" };
      },
    },
    {
      name: "deleted fork",
      change: (input) => {
        input.pull.head.repo = null;
      },
    },
    { name: "closed", change: (input) => (input.pull.state = "closed") },
    {
      name: "superseded pull_request run",
      change: (input) => {
        input.pull.head.sha = "e".repeat(40);
      },
    },
    {
      name: "default branch head",
      change: (input) => {
        input.pull.head.ref = "main";
      },
    },
    {
      name: "option-like branch",
      change: (input) => {
        input.pull.head.ref = "-x";
      },
    },
    {
      name: "path traversal branch",
      change: (input) => {
        input.pull.head.ref = "a/../b";
      },
    },
    {
      name: "malformed merge group ref",
      change: (input) => {
        input.run["event"] = "merge_group";
        input.run["head_branch"] = "gh-readonly-queue/main/not-a-pr";
      },
    },
    {
      name: "pull_request run without its pull request",
      change: (input) => {
        input.run["pull_requests"] = [];
      },
    },
  ];
  for (const { name, change } of skipped) {
    test(`skips: ${name}`, async () => {
      const input = scenario();
      change(input);
      expect((await select(input)).outputs).toEqual({});
    });
  }

  test("never regenerates twice in a row", async () => {
    const input = scenario();
    input.headMessage = `${REGENERATION_HEADLINE}\n`;
    const result = await select(input);
    expect(result.outputs).toEqual({});
    expect(result.notices).toHaveLength(1);
  });

  test("the loop guard reads the headline the publish job commits with", () => {
    expect(selection).toContain(`'${REGENERATION_HEADLINE}'`);
    const push = stepsOf(reusable, "publish").find(
      (step) => step.name === "Push regenerated baselines",
    );
    expect(push?.with?.["commit-message"]).toBe(REGENERATION_HEADLINE);
  });

  test("the marker the selection reads is the one the check uploads", () => {
    const upload = stepsOf(reusable, "check").find(
      (step) => step.name === "Upload pixel diff marker",
    );
    expect(upload?.with?.["name"]).toBe("marketing-screenshots-pixel-diff");
    expect(upload?.if).toContain("steps.pixel-diff.outputs.found == 'true'");
    expect(selection).toContain("'marketing-screenshots-pixel-diff'");
  });
});

describe("regeneration trust boundary", () => {
  test("the trigger runs trusted code and executes nothing from the pull request", () => {
    expect(autofixText).toContain("workflow_run:");
    expect(autofixText).toContain("workflows: [CI Checks]");
    expect(autofixText).not.toContain("pull_request_target");
    const selectJob = autofixJobs["select"];
    expect(selectJob?.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(selectJob?.if).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    for (const step of stepsOf(autofix, "select")) {
      expect(step.run).toBeUndefined();
      expect(step.uses?.startsWith("actions/github-script@")).toBe(true);
    }
    expect(selectJob?.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    const regenerate = autofixJobs["regenerate"];
    expect(regenerate?.uses).toBe(
      "./.github/workflows/marketing-screenshots.yml",
    );
    expect(regenerate?.with).toEqual({
      mode: "update",
      ref: githubExpression("needs.select.outputs.branch"),
      "expected-sha": githubExpression("needs.select.outputs.sha"),
    });
  });

  test("automatic and manual regenerations of one branch share a concurrency group", () => {
    expect(autofixJobs["regenerate"]?.concurrency).toEqual({
      group: `marketing-screenshots-update-${githubExpression("needs.select.outputs.branch")}`,
      "cancel-in-progress": false,
    });
    expect(dispatch.concurrency).toEqual({
      group: `marketing-screenshots-update-${githubExpression("inputs.branch")}`,
      "cancel-in-progress": false,
    });
  });

  test("only the publish job can reach the push key, and it runs no branch code", () => {
    const withKey = Object.entries(reusableJobs)
      .filter(([, job]) =>
        JSON.stringify(job.steps ?? []).includes(
          "STELLA_RELEASE_APP_PRIVATE_KEY",
        ),
      )
      .map(([name]) => name);
    expect(withKey).toEqual(["publish"]);
    expect(
      Object.entries(reusableJobs)
        .filter(([, job]) => job.environment !== undefined)
        .map(([name, job]) => [name, job.environment]),
    ).toEqual([["publish", "release-app"]]);

    const publish = stepsOf(reusable, "publish");
    for (const step of publish) {
      // A local action would resolve from the checked-out branch.
      expect(step.uses?.startsWith("./") ?? false).toBe(false);
      expect(step.run ?? "").not.toMatch(/\bbun\b|\bnpm\b|\bnode\b|\bmake\b/u);
    }
    const checkout = publish.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.["submodules"]).toBeUndefined();
    const index = (name: string) =>
      publish.findIndex((step) => step.name === name);
    expect(index("Stage validated baselines")).toBeGreaterThan(
      index("Download regenerated baselines"),
    );
    expect(index("Mint App token")).toBeGreaterThan(
      index("Stage validated baselines"),
    );
    expect(index("Push regenerated baselines")).toBe(publish.length - 1);
    const push = publish.at(-1);
    expect(push?.with?.["mode"]).toBe("append");
    expect(push?.with?.["paths"]).toBe(
      "apps/landing/public/media/products/*.png",
    );

    const update = stepsOf(reusable, "update");
    expect(JSON.stringify(update)).not.toContain("app-token");
    const updateCheckout = update.find((step) => step.name === "Checkout");
    expect(updateCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(reusableJobs["publish"]?.needs).toBe("update");
  });
});

describe("regenerated baseline validation", () => {
  const command = (() => {
    const step = stepsOf(reusable, "publish").find(
      (candidate) => candidate.name === "Stage validated baselines",
    );
    if (step?.run === undefined) {
      throw new TypeError("Stage validated baselines has no run script");
    }
    return step.run;
  })();
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("pixels"),
  ]);
  const stage = (populate: (source: string) => void) => {
    const root = mkdtempSync(path.join(tmpdir(), "marketing-stage-"));
    try {
      const source = path.join(root, "source");
      const target = "apps/landing/public/media/products";
      mkdirSync(source);
      mkdirSync(path.join(root, target), { recursive: true });
      populate(source);
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: { ...process.env, SOURCE: source, TARGET: target },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        output: result.stdout.toString(),
        staged: readdirSync(path.join(root, target)).toSorted(),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("stages flat PNG files", () => {
    const result = stage((source) => {
      writeFileSync(path.join(source, "workspace-light.png"), png);
      writeFileSync(path.join(source, "review-dark.png"), png);
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.staged).toEqual(["review-dark.png", "workspace-light.png"]);
  });

  const rejected: { name: string; populate: (source: string) => void }[] = [
    {
      name: "a file that is not a PNG",
      populate: (source) => writeFileSync(path.join(source, "x.png"), "text"),
    },
    {
      name: "a non-PNG name",
      populate: (source) => writeFileSync(path.join(source, "x.js"), png),
    },
    {
      name: "a nested path",
      populate: (source) => {
        mkdirSync(path.join(source, "nested"));
        writeFileSync(path.join(source, "nested", "x.png"), png);
      },
    },
    {
      name: "a symlink",
      populate: (source) => {
        writeFileSync(path.join(source, "real.png"), png);
        symlinkSync("/etc/hosts", path.join(source, "link.png"));
      },
    },
    {
      name: "a hidden file",
      populate: (source) => writeFileSync(path.join(source, ".x.png"), png),
    },
  ];
  test("rejects an empty upload", () => {
    expect(stage(() => {}).exitCode).toBe(1);
  });

  for (const { name, populate } of rejected) {
    test(`rejects ${name}`, () => {
      const result = stage((source) => {
        writeFileSync(path.join(source, "ok.png"), png);
        populate(source);
      });
      expect(result.exitCode, result.output).toBe(1);
      expect(result.staged).toEqual([]);
    });
  }
});
