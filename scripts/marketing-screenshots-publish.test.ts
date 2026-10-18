import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
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

import { rejectionOf } from "@stll/property-testing/rejection";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const read = (name: string) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf-8",
  );
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
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
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  environment: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  steps: v.optional(v.array(stepSchema)),
});
const jobsOf = (workflow: unknown) =>
  v.parse(v.looseObject({ jobs: v.record(v.string(), jobSchema) }), workflow)
    .jobs;
const stepsOf = (workflow: unknown, job: string) =>
  workflowJobSteps(workflow, job).map((step) => v.parse(stepSchema, step));
const workflowSource = read("marketing-screenshots-update.yml");
const publishWorkflow = Bun.YAML.parse(workflowSource);
const captureSource = read("marketing-screenshots-capture.yml");
const captureWorkflow = Bun.YAML.parse(captureSource);
const scriptOf = (job: string, name: string) =>
  v.parse(
    v.object({ script: v.string() }),
    workflowStepByName(workflowJobSteps(publishWorkflow, job), name)["with"],
  ).script;
const executable = (job: string, name: string) =>
  new Script(`(async () => { ${scriptOf(job, name)} })()`);
const HEAD = "a".repeat(40);
const PUBLISHED = "b".repeat(40);
const PRODUCT = "apps/landing/public/media/products/workspace-light.png";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("pixels"),
]);
const BLOB = createHash("sha1")
  .update(`blob ${PNG.length}\0`)
  .update(PNG)
  .digest("hex");

const PUBLISH_SHELL_COMMANDS = new Set([
  "[[",
  "cd",
  "cp",
  "do",
  "done",
  "echo",
  "else",
  "exit",
  "fi",
  "find",
  "for",
  "git",
  "head",
  "if",
  "od",
  "printf",
  "pwd",
  "read",
  "rm",
  "set",
  "then",
  "tr",
  "wc",
  "while",
]);

/** The command word of every simple command in a shell script. */
const commandsOf = (script: string): string[] =>
  script
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean)
    .flatMap((line) =>
      line
        .split(/\|\||&&|;|\||\$\(|<\(|\bthen\b|\bdo\b|^!|\bif\b|\bwhile\b/u)
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .map((part) => part.split(/\s+/u)[0] ?? "")
    .filter(
      (word) =>
        word !== "" &&
        !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) &&
        !/^[\])"'<>(]/u.test(word) &&
        !/^(?:!|\]\]|\)\)?|\(\(|\\|count|total_size|done<|fi\)?)$/u.test(word),
    );

describe("pre-release screenshot workflow", () => {
  test("one reusable manual workflow awaits the capture and publishes", () => {
    const names = readdirSync(
      new URL("../.github/workflows/", import.meta.url),
    ).filter((name) => name.startsWith("marketing-screenshots"));
    expect(names.toSorted()).toEqual([
      "marketing-screenshots-capture.yml",
      "marketing-screenshots-update.yml",
    ]);
    const workflows = readdirSync(
      new URL("../.github/workflows/", import.meta.url),
    ).filter((name) => name.endsWith(".yml"));
    expect(
      workflows.filter(
        (name) =>
          read(name).includes("/marketing-capture") ||
          read(name).includes("test:e2e:marketing"),
      ),
    ).toEqual(["marketing-screenshots-capture.yml"]);
    expect(
      workflows
        .filter(
          (name) =>
            !names.includes(name) &&
            read(name).includes("marketing-screenshots-update.yml"),
        )
        .toSorted(),
    ).toEqual(["release-pr.yml", "release-tag.yml"]);
    const triggers = v.parse(
      v.looseObject({ on: v.record(v.string(), v.unknown()) }),
      publishWorkflow,
    ).on;
    expect(Object.keys(triggers).toSorted()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(workflowSource).not.toContain("workflow_run:");
    expect(captureSource).not.toContain("workflow_run:");
    expect(jobsOf(publishWorkflow)["publish"]?.needs).toEqual([
      "select",
      "capture",
    ]);
    for (const name of ["ci.yml", "nightly-test.yml"]) {
      expect(read(name)).not.toContain("marketing-screenshots");
      expect(read(name)).not.toContain("marketing_screenshots_required");
    }
    for (const name of ["release-pr.yml", "release-tag.yml"]) {
      expect(read(name)).toContain(
        "uses: ./.github/workflows/marketing-screenshots-update.yml",
      );
    }
    const release = jobsOf(Bun.YAML.parse(read("release-pr.yml")));
    expect(release["screenshot-plan"]?.needs).toBe("version");
    expect(release["marketing-screenshots"]?.needs).toBe("screenshot-plan");
    expect(release["marketing-screenshots"]?.["if"]).toBe(
      "needs.screenshot-plan.outputs.branch != ''",
    );
  });

  // Runs of the update workflow use main's ref and therefore main's cache
  // scope (the runtime credentials actions/cache uses). Branch install,
  // build and spec code must never execute there: `save: false` only turns
  // off one cooperative save step, not what the branch's code can do.
  test("publication jobs execute only trusted inline commands", () => {
    const jobs = jobsOf(publishWorkflow);
    for (const [name, job] of Object.entries(jobs)) {
      const steps = stepsOf(publishWorkflow, name);
      for (const step of steps) {
        // A local action or a cache action would run or restore tree content.
        expect(
          step.uses?.startsWith("./") ?? false,
          `${name}: ${String(step.uses)}`,
        ).toBe(false);
        expect(step.uses?.startsWith("actions/cache") ?? false).toBe(false);
        expect(step.uses?.includes("setup-bun") ?? false).toBe(false);
      }
      const checkouts = steps.filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      if (name !== "publish") {
        // Only the publish job has a checkout, and it executes nothing from
        // it (its shell commands are pinned below).
        expect(checkouts, name).toEqual([]);
        expect(
          steps.filter((step) => step.run !== undefined),
          name,
        ).toEqual([]);
      }
      expect(JSON.stringify(job)).not.toContain("marketing-capture");
      expect(JSON.stringify(job)).not.toContain("DOCKERHUB");
    }
    const publish = stepsOf(publishWorkflow, "publish");
    for (const step of publish) {
      if (step.run !== undefined) {
        for (const command of commandsOf(step.run)) {
          expect(PUBLISH_SHELL_COMMANDS.has(command), command).toBe(true);
        }
      }
    }
  });

  test("branch code runs only in a capture on its own branch, never on main", () => {
    const triggers = v.parse(
      v.looseObject({ on: v.record(v.string(), v.unknown()) }),
      captureWorkflow,
    ).on;
    expect(Object.keys(triggers)).toEqual(["workflow_dispatch"]);
    expect(
      v.parse(v.looseObject({ permissions: v.unknown() }), captureWorkflow)
        .permissions,
    ).toEqual({});
    const jobs = jobsOf(captureWorkflow);
    expect(Object.keys(jobs)).toEqual(["capture"]);
    const capture = v.parse(
      v.looseObject({ if: v.string(), permissions: v.unknown() }),
      jobs["capture"],
    );
    // Main's cache scope is never handed to branch code.
    expect(capture.if).toBe(
      "inputs.branch != 'main' && github.ref == format('refs/heads/{0}', inputs.branch)",
    );
    for (const [name, job] of Object.entries(jobs)) {
      expect(JSON.stringify(job), name).not.toContain("secrets.");
    }
    // The job that runs branch code holds no write permission, no
    // deployment environment and no release key.
    expect(capture.permissions).toEqual({ contents: "read" });
    expect(jobs["capture"]?.environment).toBeUndefined();
    expect(captureSource).not.toContain("RELEASE_APP");
    expect(captureSource).not.toContain("github-token");
    const steps = stepsOf(captureWorkflow, "capture");
    expect(
      v.parse(v.looseObject({ "run-name": v.string() }), captureWorkflow)[
        "run-name"
      ],
    ).toBe(
      `Capture marketing screenshots ${githubExpression("inputs.sha")} ${githubExpression("inputs.request")}`,
    );
    const checkoutPosition = steps.findIndex(
      (step) => step.name === "Checkout the release tree",
    );
    const assertionPosition = steps.findIndex(
      (step) => step.name === "Verify the checked-out capture commit",
    );
    const executionPosition = steps.findIndex((step) =>
      step.uses?.startsWith("./"),
    );
    expect(assertionPosition).toBeGreaterThan(checkoutPosition);
    expect(assertionPosition).toBeLessThan(executionPosition);

    expect(
      steps.find((step) => step.name === "Checkout the release tree")?.with,
    ).toMatchObject({
      ref: githubExpression("inputs.sha"),
      "persist-credentials": false,
    });
    expect(
      steps.find((step) => step.name === "Capture marketing screenshots"),
    ).toMatchObject({
      uses: "./.github/actions/marketing-capture",
      with: { mode: "update" },
    });
    expect(
      steps.find((step) => step.name === "Upload regenerated baselines")?.with,
    ).toMatchObject({
      name: "marketing-screenshots",
      path: "apps/landing/public/media/products/*.png",
    });

    // The main-ref jobs that hold privileged writes never share a job with
    // branch code: the capture job only dispatches and waits.
    const updateJobs = jobsOf(publishWorkflow);
    expect(updateJobs["capture"]?.permissions).toEqual({
      actions: "write",
      contents: "read",
    });
    expect(updateJobs["capture"]?.environment).toBeUndefined();
    expect(JSON.stringify(updateJobs["capture"])).not.toContain(
      "STELLA_RELEASE_APP_PRIVATE_KEY",
    );
    expect(updateJobs["capture"]?.needs).toEqual(["select", "prepare"]);
    expect(updateJobs["prepare"]?.environment).toBe("release-app");
    expect(updateJobs["prepare"]?.permissions).toEqual({});
    const download = stepsOf(publishWorkflow, "publish").find(
      (step) => step.name === "Download regenerated baselines",
    );
    expect(download?.with).toMatchObject({
      name: "marketing-screenshots",
      "run-id": githubExpression("needs.capture.outputs.run-id"),
    });
    const action = readFileSync(
      new URL(
        "../.github/actions/marketing-capture/action.yml",
        import.meta.url,
      ),
      "utf-8",
    );
    expect(action).toContain("save: false");
  });

  test("jobs that check out branch trees or run local actions have no repository secrets", () => {
    for (const workflow of [captureWorkflow, publishWorkflow]) {
      for (const [name, job] of Object.entries(jobsOf(workflow))) {
        const steps = stepsOf(workflow, name);
        const runsBranchTree = steps.some(
          (step) =>
            step.uses?.startsWith("./") ||
            (step.uses?.startsWith("actions/checkout@") &&
              step.with?.["ref"] !== "main"),
        );
        if (runsBranchTree) {
          expect(JSON.stringify(job), name).not.toContain("secrets.");
        }
      }
    }
  });

  test("publication validates artifact data before minting its isolated App token", () => {
    const jobs = jobsOf(publishWorkflow);
    expect(jobs["publish"]?.environment).toBe("release-app");
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== "publish" && name !== "prepare") {
        expect(JSON.stringify(job)).not.toContain(
          "STELLA_RELEASE_APP_PRIVATE_KEY",
        );
      }
    }
    const steps = stepsOf(publishWorkflow, "publish");
    for (const step of steps) {
      expect(step.uses?.startsWith("./") ?? false).toBe(false);
      expect(step.uses?.startsWith("actions/cache") ?? false).toBe(false);
      if (step.run !== undefined) {
        for (const command of commandsOf(step.run)) {
          expect(PUBLISH_SHELL_COMMANDS.has(command), command).toBe(true);
        }
      }
    }
    const checkout = steps.find(
      (step) => step.name === "Checkout publication tooling from main",
    );
    expect(checkout?.with).toMatchObject({
      ref: "main",
      "persist-credentials": false,
    });
    expect(checkout?.with?.["submodules"]).toBeUndefined();
    const download = steps.find(
      (step) => step.name === "Download regenerated baselines",
    );
    expect(download?.with?.["run-id"]).toBe(
      githubExpression("needs.capture.outputs.run-id"),
    );
    expect(download?.with?.["name"]).toBe("marketing-screenshots");
    const position = (name: string) =>
      steps.findIndex((step) => step.name === name);
    expect(position("Mint App token")).toBeGreaterThan(
      position("Stage validated baselines"),
    );
    expect(position("Mint App token")).toBeGreaterThan(
      position("Classify baseline changes"),
    );
    expect(
      steps.find((step) => step.name === "Push regenerated baselines")?.with,
    ).toMatchObject({
      mode: "append",
      branch: githubExpression("needs.select.outputs.branch"),
      paths: githubExpression("steps.changes.outputs.paths"),
    });
    expect(
      steps.find((step) => step.name === "Push regenerated baselines")?.if,
    ).toBe(
      "steps.changes.outputs.result == 'changed' && steps.publication.outputs.result != 'reuse'",
    );
    expect(
      steps.find(
        (step) => step.name === "Verify publication and report review result",
      )?.env,
    ).toMatchObject({
      PUBLICATION_RESULT: githubExpression("steps.publication.outputs.result"),
      PUBLISHED_HEAD: githubExpression(
        "steps.commit.outputs.commit-sha || steps.publication.outputs.head",
      ),
    });
    expect(
      position("Verify publication and report review result"),
    ).toBeGreaterThan(position("Push regenerated baselines"));
  });
});

describe("capture checkout validation", () => {
  const step = v.parse(
    v.object({ run: v.string(), env: v.record(v.string(), v.string()) }),
    workflowStepByName(
      workflowJobSteps(captureWorkflow, "capture"),
      "Verify the checked-out capture commit",
    ),
  );
  test("accepts only the requested commit before executing capture code", () => {
    expect(step.env["SHA"]).toBe(githubExpression("inputs.sha"));
    const root = mkdtempSync(path.join(tmpdir(), "marketing-checkout-"));
    try {
      const initialized = Bun.spawnSync(["git", "init", "--quiet"], {
        cwd: root,
      });
      expect(initialized.exitCode).toBe(0);
      const committed = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "--no-verify",
          "--quiet",
          "-m",
          "Capture fixture",
        ],
        { cwd: root },
      );
      expect(committed.exitCode, committed.stderr.toString()).toBe(0);
      const selected = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: root,
      });
      expect(selected.exitCode).toBe(0);
      const sha = selected.stdout.toString().trim();
      expect(sha).not.toBe(HEAD);
      for (const expected of [sha, HEAD]) {
        const result = Bun.spawnSync(["bash", "-c", step.run], {
          cwd: root,
          env: { ...process.env, SHA: expected },
        });
        expect(result.exitCode).toBe(expected === sha ? 0 : 1);
        if (expected !== sha) {
          expect(result.stdout.toString()).toContain(
            "differs from the requested SHA",
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("capture dispatch on the release branch", () => {
  const dispatch = executable("capture", "Capture on the release branch");
  const BRANCH = "changeset-release/main";
  const scenario = () => ({
    branch: BRANCH,
    head: HEAD,
    // The branch tip read before dispatch.
    tip: HEAD,
    runId: 42 as number | undefined,
    run: {
      id: 42,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/marketing-screenshots-capture.yml",
      event: "workflow_dispatch",
      head_branch: BRANCH,
      head_sha: HEAD,
      display_title: `Capture marketing screenshots ${HEAD} 7-1`,
      head_repository: { full_name: "stella/stella" },
      html_url: "https://github.com/stella/stella/actions/runs/42",
    },
  });
  const dispatchFor = async (input: ReturnType<typeof scenario>) => {
    const outputs: Record<string, string> = {};
    const dispatches: unknown[] = [];
    const builder = {
      addHeading: () => builder,
      addLink: () => builder,
      write: async () => {},
    };
    await dispatch.runInNewContext({
      context: { repo: { owner: "stella", repo: "stella" }, runId: 7 },
      process: {
        env: {
          BRANCH: input.branch,
          CAPTURE_HEAD: input.head,
          GITHUB_RUN_ATTEMPT: "1",
        },
      },
      setTimeout: (callback: () => void) => {
        callback();
      },
      Date,
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        summary: builder,
      },
      github: {
        rest: {
          git: {
            getRef: async (params: unknown) => {
              expect(params).toEqual({
                owner: "stella",
                repo: "stella",
                ref: `heads/${input.branch}`,
              });
              expect(dispatches).toEqual([]);
              return { data: { object: { sha: input.tip } } };
            },
          },
          actions: {
            createWorkflowDispatch: async (params: unknown) => {
              dispatches.push(params);
              return input.runId === undefined
                ? { status: 204, data: undefined }
                : { status: 200, data: { workflow_run_id: input.runId } };
            },
            getWorkflowRun: async () => ({ data: input.run }),
          },
        },
      },
    });
    return { outputs, dispatches };
  };

  test("dispatches on the selected branch and returns its run", async () => {
    const input = scenario();
    expect(await dispatchFor(input)).toEqual({
      outputs: { "run-id": "42" },
      dispatches: [
        {
          owner: "stella",
          repo: "stella",
          workflow_id: "marketing-screenshots-capture.yml",
          ref: BRANCH,
          inputs: { branch: BRANCH, sha: HEAD, request: "7-1" },
          return_run_details: true,
        },
      ],
    });
  });

  // A repeat request for a main commit finds its publication branch with
  // baseline commits on top: the run starts at that tip, capturing the commit.
  test("a publication branch tip above the selected commit still captures it", async () => {
    const input = scenario();
    input.tip = PUBLISHED;
    input.run.head_sha = PUBLISHED;
    expect((await dispatchFor(input)).outputs).toEqual({ "run-id": "42" });
  });

  test("rejects a missing dispatched run id without searching by title", async () => {
    const input = scenario();
    input.runId = undefined;
    expect(await rejectionOf(dispatchFor(input))).toMatchObject({
      message: "Dispatch did not return a capture run id",
    });
    expect(scriptOf("capture", "Capture on the release branch")).not.toContain(
      "listWorkflowRuns",
    );
  });

  for (const [name, change, message] of [
    [
      "main",
      (input: ReturnType<typeof scenario>) => {
        input.branch = "main";
      },
      "release branch",
    ],
    [
      "a short commit",
      (input: ReturnType<typeof scenario>) => {
        input.head = "abc";
      },
      "full commit SHA",
    ],
    [
      "a run on main",
      (input: ReturnType<typeof scenario>) => {
        input.run.head_branch = "main";
      },
      "is not this capture",
    ],
    [
      "a run of another workflow",
      (input: ReturnType<typeof scenario>) => {
        input.run.path = ".github/workflows/ci.yml";
      },
      "is not this capture",
    ],
    [
      "a different returned run id",
      (input: ReturnType<typeof scenario>) => {
        input.run.id = 43;
      },
      "is not this capture",
    ],
    [
      "a run at another commit of the branch",
      (input: ReturnType<typeof scenario>) => {
        input.run.head_sha = PUBLISHED;
      },
      "is not this capture",
    ],
    [
      "a different selected head in the run title",
      (input: ReturnType<typeof scenario>) => {
        input.run.display_title = `Capture marketing screenshots ${PUBLISHED} 7-1`;
      },
      "is not this capture",
    ],
    [
      "a failed capture",
      (input: ReturnType<typeof scenario>) => {
        input.run.conclusion = "failure";
      },
      "concluded failure",
    ],
  ] as const) {
    test(`refuses ${name}`, async () => {
      const input = scenario();
      change(input);
      expect(await rejectionOf(dispatchFor(input))).toMatchObject({
        message: expect.stringContaining(message),
      });
    });
  }
});

describe("versioned release screenshot planning", () => {
  const releaseWorkflow = Bun.YAML.parse(read("release-pr.yml"));
  const script = v.parse(
    v.object({ script: v.string() }),
    workflowStepByName(
      workflowJobSteps(releaseWorkflow, "screenshot-plan"),
      "Select the versioned release pull request",
    )["with"],
  ).script;
  const select = new Script(`(async () => { ${script} })()`);
  const release = () => ({
    head: {
      ref: "changeset-release/main",
      repo: { full_name: "stella/stella" },
    },
    base: { ref: "main" },
  });
  const planFor = async (pulls: ReturnType<typeof release>[]) => {
    const outputs: Record<string, string> = {};
    const notices: string[] = [];
    await select.runInNewContext({
      context: { repo: { owner: "stella", repo: "stella" } },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        notice: (message: string) => {
          notices.push(message);
        },
      },
      github: {
        paginate: async (_route: unknown, params: unknown) => {
          expect(params).toMatchObject({
            state: "open",
            head: "stella:changeset-release/main",
          });
          return pulls;
        },
        rest: { pulls: { list: "pulls.list" } },
      },
    });
    return { outputs, notices };
  };
  test("reports no checklist when versioning created no release pull request", async () => {
    const result = await planFor([]);
    expect(result.outputs).toEqual({});
    expect(result.notices).toHaveLength(1);
  });
  test("selects the same-repository versioned release branch", async () => {
    expect(await planFor([release()])).toEqual({
      outputs: { branch: "changeset-release/main" },
      notices: [],
    });
  });
  test("refuses multiple versioned release pull requests", async () => {
    expect(await rejectionOf(planFor([release(), release()]))).toMatchObject({
      message: expect.stringContaining(
        "Multiple versioned release pull requests",
      ),
    });
  });
  test("does not schedule screenshots for a fork release branch", async () => {
    const pull = release();
    pull.head.repo.full_name = "fork/stella";
    const result = await planFor([pull]);
    expect(result.outputs).toEqual({});
    expect(result.notices).toHaveLength(1);
  });
});

describe("release tree selection", () => {
  const select = executable("select", "Select the release tree");
  const scenario = () => ({
    workflowRef: "refs/heads/main",
    branch: "release/test",
    ref: "",
    comparison: "ahead",
    pulls: [
      {
        head: {
          ref: "release/test",
          sha: HEAD,
          repo: { full_name: "stella/stella" },
        },
        base: { ref: "main" },
      },
    ],
  });
  const selectFor = async (input: ReturnType<typeof scenario>) => {
    const outputs: Record<string, string> = {};
    await select.runInNewContext({
      context: {
        repo: { owner: "stella", repo: "stella" },
        ref: input.workflowRef,
      },
      process: { env: { BRANCH: input.branch, RELEASE_REF: input.ref } },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        paginate: async () => input.pulls,
        rest: {
          pulls: { list: "pulls.list" },
          git: { getRef: async () => ({ data: { object: { sha: HEAD } } }) },
          repos: {
            compareCommits: async () => ({
              data: { status: input.comparison },
            }),
            listPullRequestsAssociatedWithCommit: "repos.associated",
          },
        },
      },
    });
    return outputs;
  };
  test("selects exactly one same-repository release pull request", async () => {
    expect(await selectFor(scenario())).toEqual({
      branch: "release/test",
      head: HEAD,
      target: "existing-pr",
    });
  });
  // The release-tag preflight passes a candidate its tree proof accepted;
  // outside main that is a release pull request head, captured on its branch.
  test("selects a release candidate outside main by its open pull request", async () => {
    const input = scenario();
    input.branch = "";
    input.ref = HEAD;
    input.comparison = "diverged";
    const pulls = input.pulls.map((pull) => ({ ...pull, state: "open" }));
    expect(await selectFor({ ...input, pulls })).toEqual({
      branch: "release/test",
      head: HEAD,
      target: "existing-pr",
    });
    expect(await rejectionOf(selectFor({ ...input, pulls: [] }))).toMatchObject(
      {
        message: expect.stringContaining("head of one open pull request"),
      },
    );
  });

  test("selects main or its verified ancestor for a new review branch", async () => {
    for (const ref of ["", "c".repeat(40)]) {
      const input = scenario();
      input.branch = "";
      input.ref = ref;
      expect(await selectFor(input)).toEqual({
        branch: `release/marketing-screenshots-${ref || HEAD}`,
        head: ref || HEAD,
        target: "new-pr",
      });
    }
  });
  const refused = [
    {
      name: "workflow code outside main",
      change: (input: ReturnType<typeof scenario>) => {
        input.workflowRef = "refs/heads/release/test";
      },
      message: "from main",
    },
    {
      name: "both branch and commit",
      change: (input: ReturnType<typeof scenario>) => {
        input.ref = HEAD;
      },
      message: "not both",
    },
    {
      name: "missing pull request",
      change: (input: ReturnType<typeof scenario>) => {
        input.pulls = [];
      },
      message: "exactly one",
    },
    {
      name: "multiple pull requests",
      change: (input: ReturnType<typeof scenario>) => {
        input.pulls.push(...input.pulls);
      },
      message: "exactly one",
    },
    {
      name: "fork pull request",
      change: (input: ReturnType<typeof scenario>) => {
        for (const pull of input.pulls) {
          pull.head.repo.full_name = "fork/stella";
        }
      },
      message: "exactly one",
    },
    {
      name: "another base branch",
      change: (input: ReturnType<typeof scenario>) => {
        for (const pull of input.pulls) {
          pull.base.ref = "other";
        }
      },
      message: "exactly one",
    },
    {
      name: "malformed commit",
      change: (input: ReturnType<typeof scenario>) => {
        input.branch = "";
        input.ref = "abc";
      },
      message: "full SHA",
    },
    {
      name: "commit outside main",
      change: (input: ReturnType<typeof scenario>) => {
        input.branch = "";
        input.ref = HEAD;
        input.comparison = "diverged";
      },
      message: "not on main",
    },
    ...["main", "-branch", "release/..", "release bad"].map((branch) => ({
      name: `unsafe branch ${branch}`,
      change: (input: ReturnType<typeof scenario>) => {
        input.branch = branch;
      },
      message: "invalid review branch",
    })),
  ];
  for (const { name, change, message } of refused) {
    test(`refuses ${name}`, async () => {
      const input = scenario();
      change(input);
      expect(await rejectionOf(selectFor(input))).toMatchObject({
        message: expect.stringContaining(message),
      });
    });
  }
});

describe("publication verification", () => {
  const verify = executable(
    "publish",
    "Verify publication and report review result",
  );
  const reviewPull = (mergedAt: string | null = null) => ({
    head: {
      ref: "release/test",
      sha: PUBLISHED,
      repo: { full_name: "stella/stella" },
    },
    base: { ref: "main" },
    state: "open",
    merged_at: mergedAt,
    html_url: "https://github.com/stella/stella/pull/1",
  });
  const scenario = () => {
    const pulls: ReturnType<typeof reviewPull>[] = [];
    return {
      result: "changed",
      target: "existing-pr",
      remote: PUBLISHED,
      operation: "committed",
      publication: "append",
      pulls,
      failure: "",
      published: PUBLISHED,
      status: "ahead",
      commits: [{ parents: [{ sha: HEAD }] }],
      expected: [PRODUCT],
      files: [{ filename: PRODUCT, sha: BLOB }],
    };
  };
  const verifyFor = async (input: ReturnType<typeof scenario>) => {
    const outputs: Record<string, string> = {};
    const reviews: unknown[] = [];
    const summary: string[] = [];
    const builder = {
      addHeading: (value: string) => {
        summary.push(value);
        return builder;
      },
      addRaw: (value: string) => {
        summary.push(value);
        return builder;
      },
      addLink: (_label: string, value: string) => {
        summary.push(value);
        return builder;
      },
      write: async () => {},
    };
    await verify.runInNewContext({
      context: {
        repo: { owner: "stella", repo: "stella" },
        serverUrl: "https://github.com",
      },
      process: {
        env: {
          CHANGE_RESULT: input.result,
          TARGET: input.target,
          BRANCH: "release/test",
          CAPTURE_HEAD: HEAD,
          COMMIT_OPERATION: input.operation,
          PUBLICATION_RESULT: input.publication,
          PUBLISHED_HEAD: input.published,
        },
      },
      require: (moduleName: string) => {
        switch (moduleName) {
          case "node:crypto":
            return {
              createHash: (algorithm: string) => {
                expect(algorithm).toBe("sha1");
                return createHash("sha1");
              },
            };
          case "node:fs":
            return {
              readFileSync: (name: string) => {
                expect(name).toBe(PRODUCT);
                return PNG;
              },
            };
          case "node:child_process":
            return {
              execFileSync: (command: string, args: string[]) => {
                expect(command).toBe("git");
                expect(args).toEqual(["diff", "--cached", "--name-only", "-z"]);
                return Buffer.from(
                  input.expected.join("\0") +
                    (input.expected.length ? "\0" : ""),
                );
              },
            };
          default:
            throw new TypeError(`Unexpected module ${moduleName}`);
        }
      },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        summary: builder,
      },
      github: {
        paginate: async (_route: unknown, params: unknown) => {
          if (input.failure === "list-pulls") {
            throw new TypeError("API list failure");
          }
          expect(params).toMatchObject({
            state: "all",
            head: "stella:release/test",
          });
          return input.pulls;
        },
        rest: {
          git: {
            getRef: async () => {
              if (input.failure === "get-ref") {
                throw new TypeError("API lookup failure");
              }
              return { data: { object: { sha: input.remote } } };
            },
          },
          repos: {
            compareCommits: async (params: unknown) => {
              if (input.failure === "compare") {
                throw new TypeError("API comparison failure");
              }
              expect(params).toMatchObject({ base: HEAD, head: input.remote });
              return {
                data: {
                  status: input.status,
                  commits: input.commits,
                  files: input.files,
                },
              };
            },
          },
          pulls: {
            list: "pulls.list",
            create: async (request: unknown) => {
              if (input.failure === "create-pull") {
                throw new TypeError("API create failure");
              }
              reviews.push(request);
              input.pulls.push(reviewPull());
              return {
                data: { html_url: "https://github.com/stella/stella/pull/1" },
              };
            },
          },
        },
      },
    });
    return { outputs, reviews, summary };
  };
  test("reports unchanged regeneration explicitly", async () => {
    const input = scenario();
    input.result = "no-change";
    const result = await verifyFor(input);
    expect(result.outputs).toEqual({ result: "no-change", head: HEAD });
    expect(result.reviews).toEqual([]);
    expect(result.summary.join(" ")).toContain("no-change");
  });
  test("reports a verified appended commit for review", async () => {
    const result = await verifyFor(scenario());
    expect(result.outputs).toEqual({ result: "published", head: PUBLISHED });
    expect(result.summary.join(" ")).toContain("compare/release/test");
  });
  test("opens a draft review pull request after verified publication", async () => {
    const input = scenario();
    input.target = "new-pr";
    const result = await verifyFor(input);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews.at(0)).toMatchObject({
      head: "release/test",
      base: "main",
      draft: true,
    });
    expect(result.outputs["result"]).toBe("published");
  });
  const prepare = executable(
    "publish",
    "Prepare the baseline review publication",
  );
  const publicationState = () => {
    const extraRefs: { ref: string; object: { sha: string } }[] = [];
    return { branchHead: "", creations: 0, commits: 0, failure: "", extraRefs };
  };
  const prepareFor = async (state: ReturnType<typeof publicationState>) => {
    const outputs: Record<string, string> = {};
    await prepare.runInNewContext({
      context: { repo: { owner: "stella", repo: "stella" } },
      process: { env: { BRANCH: "release/test", CAPTURE_HEAD: HEAD } },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      github: {
        paginate: async (_route: unknown, params: unknown) => {
          if (state.failure === "list") {
            throw new TypeError("API ref list failure");
          }
          expect(params).toMatchObject({ ref: "heads/release/test" });
          return state.branchHead
            ? [
                {
                  ref: "refs/heads/release/test",
                  object: { sha: state.branchHead },
                },
                ...state.extraRefs,
              ]
            : state.extraRefs;
        },
        rest: {
          git: {
            listMatchingRefs: "git.listMatchingRefs",
            createRef: async (params: unknown) => {
              if (state.failure === "create") {
                throw new TypeError("API ref create failure");
              }
              if (state.branchHead) {
                throw new TypeError("Reference already exists");
              }
              expect(params).toMatchObject({
                ref: "refs/heads/release/test",
                sha: HEAD,
              });
              state.branchHead = HEAD;
              state.creations += 1;
            },
          },
        },
      },
    });
    return outputs;
  };
  const publishCycle = async (
    state: ReturnType<typeof publicationState>,
    input: ReturnType<typeof scenario>,
  ) => {
    const selected = await prepareFor(state);
    input.target = "new-pr";
    input.publication = String(selected["result"]);
    const predicate = v.parse(
      v.string(),
      stepsOf(publishWorkflow, "publish").find(
        (step) => step.name === "Push regenerated baselines",
      )?.if,
    );
    const shouldCommit = new Script(`Boolean(${predicate})`).runInNewContext({
      steps: {
        changes: { outputs: { result: input.result } },
        publication: { outputs: { result: selected["result"] } },
      },
    });
    if (shouldCommit) {
      state.commits += 1;
      state.branchHead = PUBLISHED;
      input.operation = "committed";
    } else {
      input.operation = "";
    }
    input.remote = state.branchHead;
    input.published = state.branchHead;
    return verifyFor(input);
  };
  test("repeated publication of one captured tree creates one branch, commit, and review", async () => {
    const state = publicationState();
    const input = scenario();
    const first = await publishCycle(state, input);
    const second = await publishCycle(state, input);
    expect(first.outputs).toEqual({ result: "published", head: PUBLISHED });
    expect(second.outputs).toEqual(first.outputs);
    expect(first.reviews).toHaveLength(1);
    expect(second.reviews).toEqual([]);
    expect(input.pulls).toHaveLength(1);
    expect(state.creations).toBe(1);
    expect(state.commits).toBe(1);
  });
  test("recovers a branch created before its baseline commit", async () => {
    const state = publicationState();
    state.branchHead = HEAD;
    const result = await publishCycle(state, scenario());
    expect(result.outputs["result"]).toBe("published");
    expect(state.creations).toBe(0);
    expect(state.commits).toBe(1);
  });
  test("recovers a committed baseline whose review pull request was not created", async () => {
    const state = publicationState();
    state.branchHead = PUBLISHED;
    const result = await publishCycle(state, scenario());
    expect(result.outputs["result"]).toBe("published");
    expect(result.reviews).toHaveLength(1);
    expect(state.creations).toBe(0);
    expect(state.commits).toBe(0);
  });
  test("rejects different PNG content on a reused publication with a typed conflict", async () => {
    const state = publicationState();
    state.branchHead = PUBLISHED;
    const input = scenario();
    input.files = [{ filename: PRODUCT, sha: HEAD }];
    expect(await rejectionOf(publishCycle(state, input))).toMatchObject({
      name: "BaselinePublicationConflict",
      code: "BASELINE_PUBLICATION_CONFLICT",
      message: expect.stringContaining("does not match capture"),
    });
    expect(state.commits).toBe(0);
    expect(input.pulls).toEqual([]);
  });
  test("matching-ref prefixes do not count as the publication branch", async () => {
    const state = publicationState();
    state.extraRefs.push({
      ref: "refs/heads/release/test-other",
      object: { sha: PUBLISHED },
    });
    expect(await prepareFor(state)).toEqual({ result: "append", head: HEAD });
    expect(state.creations).toBe(1);
  });
  test("refuses ambiguous exact publication refs", async () => {
    const state = publicationState();
    state.branchHead = PUBLISHED;
    state.extraRefs.push({
      ref: "refs/heads/release/test",
      object: { sha: PUBLISHED },
    });
    expect(await rejectionOf(prepareFor(state))).toMatchObject({
      message: "Ambiguous baseline publication branch",
    });
  });
  for (const failure of ["list", "create"]) {
    test(`propagates publication ref API ${failure} failure`, async () => {
      const state = publicationState();
      state.failure = failure;
      expect(await rejectionOf(prepareFor(state))).toMatchObject({
        name: "TypeError",
        message: `API ref ${failure} failure`,
      });
    });
  }
  for (const failure of ["list-pulls", "create-pull"]) {
    test(`propagates review API ${failure} failure`, async () => {
      const input = scenario();
      input.target = "new-pr";
      input.failure = failure;
      expect(await rejectionOf(verifyFor(input))).toMatchObject({
        name: "TypeError",
        message:
          failure === "list-pulls" ? "API list failure" : "API create failure",
      });
    });
  }
  for (const failure of ["get-ref", "compare"]) {
    test(`propagates publication verification API ${failure} failure`, async () => {
      const input = scenario();
      input.failure = failure;
      expect(await rejectionOf(verifyFor(input))).toMatchObject({
        name: "TypeError",
        message:
          failure === "get-ref"
            ? "API lookup failure"
            : "API comparison failure",
      });
    });
  }
  test("reuses a merged review at the verified publication head", async () => {
    const input = scenario();
    input.target = "new-pr";
    const pull = reviewPull("2026-01-01T00:00:00Z");
    pull.state = "closed";
    input.pulls.push(pull);
    const result = await verifyFor(input);
    expect(result.reviews).toEqual([]);
    expect(result.outputs["result"]).toBe("published");
  });
  const reviewConflicts = [
    {
      name: "duplicate review",
      change: (input: ReturnType<typeof scenario>) => {
        input.pulls.push(reviewPull(), reviewPull());
      },
    },
    {
      name: "review at another head",
      change: (input: ReturnType<typeof scenario>) => {
        const pull = reviewPull();
        pull.head.sha = HEAD;
        input.pulls.push(pull);
      },
    },
    {
      name: "closed unmerged review",
      change: (input: ReturnType<typeof scenario>) => {
        const pull = reviewPull();
        pull.state = "closed";
        input.pulls.push(pull);
      },
    },
  ];
  for (const { name, change } of reviewConflicts) {
    test(`reports typed conflict for ${name}`, async () => {
      const input = scenario();
      input.target = "new-pr";
      change(input);
      expect(await rejectionOf(verifyFor(input))).toMatchObject({
        name: "BaselinePublicationConflict",
        code: "BASELINE_PUBLICATION_CONFLICT",
      });
    });
  }
  const refused = [
    {
      name: "no-op push",
      change: (input: ReturnType<typeof scenario>) => {
        input.remote = HEAD;
      },
      message: "not committed",
    },
    {
      name: "stale parent",
      change: (input: ReturnType<typeof scenario>) => {
        input.commits = [{ parents: [{ sha: PUBLISHED }] }];
      },
      message: "captured head",
    },
    {
      name: "merge commit",
      change: (input: ReturnType<typeof scenario>) => {
        input.commits = [{ parents: [{ sha: HEAD }, { sha: PUBLISHED }] }];
      },
      message: "captured head",
    },
    {
      name: "empty comparison",
      change: (input: ReturnType<typeof scenario>) => {
        input.commits = [];
      },
      message: "captured head",
    },
    {
      name: "non-ahead comparison",
      change: (input: ReturnType<typeof scenario>) => {
        input.status = "diverged";
      },
      message: "captured head",
    },
    {
      name: "uncommitted action result",
      change: (input: ReturnType<typeof scenario>) => {
        input.operation = "no-change";
      },
      message: "not committed",
    },
    {
      name: "invalid action head",
      change: (input: ReturnType<typeof scenario>) => {
        input.published = "bad";
      },
      message: "not committed",
    },
    {
      name: "branch moved after push",
      change: (input: ReturnType<typeof scenario>) => {
        input.remote = "c".repeat(40);
      },
      message: "moved after",
    },
    {
      name: "wrong PNG content",
      change: (input: ReturnType<typeof scenario>) => {
        input.files = [{ filename: PRODUCT, sha: HEAD }];
      },
      message: "does not match capture",
    },
    {
      name: "missing PNG",
      change: (input: ReturnType<typeof scenario>) => {
        input.files = [];
      },
      message: "file set",
    },
    {
      name: "extra committed file",
      change: (input: ReturnType<typeof scenario>) => {
        input.files.push({ filename: "extra", sha: HEAD });
      },
      message: "file set",
    },
    {
      name: "missing classification",
      change: (input: ReturnType<typeof scenario>) => {
        input.result = "";
      },
      message: "classification",
    },
    {
      name: "empty staged set",
      change: (input: ReturnType<typeof scenario>) => {
        input.expected = [];
      },
      message: "no staged PNGs",
    },
    {
      name: "non-baseline staged path",
      change: (input: ReturnType<typeof scenario>) => {
        input.expected = ["other"];
      },
      message: "non-baseline path",
    },
    {
      name: "unknown target",
      change: (input: ReturnType<typeof scenario>) => {
        input.target = "";
      },
      message: "Unknown publication target",
    },
  ];
  for (const { name, change, message } of refused) {
    test(`fails loudly for ${name}`, async () => {
      const input = scenario();
      change(input);
      expect(await rejectionOf(verifyFor(input))).toMatchObject({
        message: expect.stringContaining(message),
      });
    });
  }
});

describe("publication base selection", () => {
  test("loads the selected Git index without materializing branch source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marketing-base-"));
    try {
      const git = (args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: root,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          },
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return result.stdout.toString().trim();
      };
      git(["init", "--quiet"]);
      mkdirSync(path.dirname(path.join(root, PRODUCT)), { recursive: true });
      writeFileSync(path.join(root, PRODUCT), PNG);
      writeFileSync(path.join(root, "tooling.sh"), "main tooling");
      git(["add", "."]);
      const mainTree = git(["write-tree"]);
      const main = git(["commit-tree", mainTree, "-m", "Main fixture"]);
      git(["update-ref", "HEAD", main]);
      writeFileSync(path.join(root, "tooling.sh"), "selected tooling");
      writeFileSync(path.join(root, "branch-only.sh"), "selected source");
      git(["add", "."]);
      const selectedTree = git(["write-tree"]);
      const selected = git([
        "commit-tree",
        selectedTree,
        "-p",
        main,
        "-m",
        "Selected fixture",
      ]);
      git(["reset", "--hard", main]);
      git(["remote", "add", "origin", root]);
      const command = v.parse(
        v.object({ run: v.string() }),
        workflowStepByName(
          workflowJobSteps(publishWorkflow, "publish"),
          "Select the publication base as Git data",
        ),
      ).run;
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: root,
        env: { ...process.env, CAPTURE_HEAD: selected },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(git(["rev-parse", "HEAD"])).toBe(selected);
      expect(git(["write-tree"])).toBe(selectedTree);
      expect(readFileSync(path.join(root, "tooling.sh"), "utf-8")).toBe(
        "main tooling",
      );
      expect(existsSync(path.join(root, "branch-only.sh"))).toBe(false);
      expect(existsSync(path.join(root, PRODUCT))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baseline change classification", () => {
  const command = v.parse(
    v.object({ run: v.string() }),
    workflowStepByName(
      workflowJobSteps(publishWorkflow, "publish"),
      "Classify baseline changes",
    ),
  ).run;
  for (const change of ["unchanged", "modified", "new"] as const) {
    test(`classifies ${change} PNGs from the Git index`, () => {
      const root = mkdtempSync(path.join(tmpdir(), "marketing-classify-"));
      try {
        const git = (args: string[]) => {
          const result = Bun.spawnSync(["git", ...args], {
            cwd: root,
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.test",
              GIT_COMMITTER_NAME: "Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.test",
            },
          });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          return result.stdout.toString().trim();
        };
        git(["init", "--quiet"]);
        mkdirSync(path.dirname(path.join(root, PRODUCT)), { recursive: true });
        writeFileSync(path.join(root, PRODUCT), PNG);
        git(["add", "--", PRODUCT]);
        const tree = git(["write-tree"]);
        const head = git(["commit-tree", tree, "-m", "Baseline fixture"]);
        git(["update-ref", "HEAD", head]);
        if (change === "modified") {
          writeFileSync(
            path.join(root, PRODUCT),
            Buffer.concat([PNG, Buffer.from("changed")]),
          );
        }
        if (change === "new") {
          writeFileSync(path.join(root, path.dirname(PRODUCT), "new.png"), PNG);
        }
        const output = path.join(root, "output");
        const summary = path.join(root, "summary");
        writeFileSync(output, "");
        writeFileSync(summary, "");
        const result = Bun.spawnSync(["bash", "-c", command], {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
          },
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const outputText = readFileSync(output, "utf-8");
        const expectedPaths =
          change === "new"
            ? ["apps/landing/public/media/products/new.png", PRODUCT]
            : [PRODUCT];
        expect(outputText).toBe(
          `paths<<BASELINE_PATHS\n${expectedPaths.join("\n")}\nBASELINE_PATHS\nresult=${change === "unchanged" ? "no-change" : "changed"}\n`,
        );
        expect(readFileSync(summary, "utf-8").length > 0).toBe(
          change !== "unchanged",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("regenerated baseline validation", () => {
  const command = (() => {
    const step = stepsOf(publishWorkflow, "publish").find(
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
  const stage = (
    populate: (source: string) => void,
    shapeCheckout: (root: string, target: string) => void = () => {},
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), "marketing-stage-"));
    try {
      const source = path.join(root, "source");
      const target = "apps/landing/public/media/products";
      mkdirSync(source);
      mkdirSync(path.join(root, target), { recursive: true });
      populate(source);
      shapeCheckout(root, target);
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
        outside: readdirSync(root).toSorted(),
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
      name: "too many PNGs",
      populate: (source) => {
        for (let index = 0; index < 100; index += 1) {
          writeFileSync(path.join(source, `${index}.png`), png);
        }
      },
    },
    {
      name: "too much total PNG data",
      populate: (source) => {
        const large = Buffer.alloc(20_000_000);
        png.copy(large);
        for (let index = 0; index < 11; index += 1) {
          writeFileSync(path.join(source, `${index}.png`), large);
        }
      },
    },
    {
      name: "an oversized PNG",
      populate: (source) => {
        const large = Buffer.alloc(20_000_001);
        png.copy(large);
        writeFileSync(path.join(source, "large.png"), large);
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

  test("refuses a products directory the branch replaced with a symlink", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root, target) => {
        const elsewhere = path.join(root, "elsewhere");
        mkdirSync(elsewhere);
        rmSync(path.join(root, target), { recursive: true });
        symlinkSync(elsewhere, path.join(root, target));
      },
    );
    expect(result.exitCode, result.output).toBe(1);
  });

  test("refuses a products directory reached through a symlinked parent", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root) => {
        const elsewhere = path.join(root, "elsewhere", "media", "products");
        mkdirSync(elsewhere, { recursive: true });
        rmSync(path.join(root, "apps/landing/public"), { recursive: true });
        symlinkSync(
          path.join(root, "elsewhere"),
          path.join(root, "apps/landing/public"),
        );
      },
    );
    expect(result.exitCode, result.output).toBe(1);
  });

  test("refuses a committed baseline that is a symlink", () => {
    const result = stage(
      (source) => writeFileSync(path.join(source, "ok.png"), png),
      (root, target) =>
        symlinkSync("/etc/hosts", path.join(root, target, "ok.png")),
    );
    expect(result.exitCode, result.output).toBe(1);
  });
});
