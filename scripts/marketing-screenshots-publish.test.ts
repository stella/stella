import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const read = (name: string) =>
  readFileSync(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf-8",
  );
// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
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
  if: v.optional(v.string()),
  environment: v.optional(v.string()),
  permissions: v.optional(v.record(v.string(), v.string())),
  steps: v.optional(v.array(stepSchema)),
});
const jobsOf = (workflow: unknown) =>
  v.parse(v.looseObject({ jobs: v.record(v.string(), jobSchema) }), workflow)
    .jobs;
const stepsOf = (workflow: unknown, job: string) =>
  workflowJobSteps(workflow, job).map((step) => v.parse(stepSchema, step));

const reusable = Bun.YAML.parse(read("marketing-screenshots.yml"));
const captureWorkflow = Bun.YAML.parse(
  read("marketing-screenshots-capture.yml"),
);
const publishWorkflow = Bun.YAML.parse(
  read("marketing-screenshots-publish.yml"),
);
const updateWorkflow = Bun.YAML.parse(read("marketing-screenshots-update.yml"));

const HEAD = "a".repeat(40);

// Commands the publish job's shell steps may run: shell builtins and
// coreutils that read or copy files, nothing that executes a file.
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
  "head",
  "if",
  "od",
  "pwd",
  "read",
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
        !/^(?:!|\]\]|\)\)?|\(\(|\\|count|done<|fi\)?)$/u.test(word),
    );

describe("screenshot regeneration trust boundary", () => {
  test("the shell allowlist sees commands that would run branch files", () => {
    for (const script of [
      "bash scripts/x.sh",
      "./tool --flag",
      "if true; then python tool.py; fi",
      "x=$(node -e 1)",
      "echo ok && sh run.sh",
      "find . | xargs rm",
    ]) {
      expect(
        commandsOf(script).every((command) =>
          PUBLISH_SHELL_COMMANDS.has(command),
        ),
        script,
      ).toBe(false);
    }
  });

  test("only the publish job can read the push key, in its environment", () => {
    for (const workflow of [reusable, captureWorkflow, updateWorkflow]) {
      expect(JSON.stringify(workflow)).not.toContain(
        "STELLA_RELEASE_APP_PRIVATE_KEY",
      );
      for (const job of Object.values(jobsOf(workflow))) {
        expect(job.environment).toBeUndefined();
      }
    }
    expect(jobsOf(publishWorkflow)["publish"]?.environment).toBe("release-app");
  });

  test("branch code runs only on the branch's own ref, never on main", () => {
    const capture = jobsOf(captureWorkflow)["capture"];
    expect(capture?.if).toContain("github.ref != 'refs/heads/main'");
    expect(capture?.if).toContain("startsWith(github.ref, 'refs/heads/')");
    expect(capture?.permissions).toEqual({ contents: "read" });
    const steps = stepsOf(captureWorkflow, "capture");
    expect(steps.find((step) => step.name === "Checkout")?.with?.["ref"]).toBe(
      githubExpression("github.sha"),
    );
    expect(
      steps.find((step) => step.name === "Upload regenerated baselines")
        ?.with?.["name"],
    ).toBe("marketing-screenshots");
    for (const step of steps) {
      expect(step.uses?.startsWith("actions/cache") ?? false).toBe(false);
    }
    // The dispatch on main runs no branch code: it only starts the capture.
    for (const step of stepsOf(updateWorkflow, "update")) {
      expect(step.uses?.startsWith("./") ?? false).toBe(false);
      expect(step.uses?.startsWith("actions/checkout@") ?? false).toBe(false);
    }
    // The comparison workflow no longer regenerates anything.
    expect(Object.keys(jobsOf(reusable))).toEqual(["check"]);
  });

  test("the publish job runs no branch code and mints the token last", () => {
    const publish = stepsOf(publishWorkflow, "publish");
    // An allowlist, not a denylist: the job holds the push key, so every
    // step is pinned by name and action, and shell steps may only call the
    // commands above. Anything new fails here until reviewed.
    expect(publish.map((step) => [step.name, step.uses ?? "run"])).toEqual([
      [
        "Select the branch",
        "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      ],
      [
        "Checkout the captured head",
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      ],
      [
        "Download regenerated baselines",
        "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
      ],
      ["Stage validated baselines", "run"],
      [
        "Mint App token",
        "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
      ],
      [
        "Push regenerated baselines",
        "stella/.github/.github/actions/signed-commit@a6a6cd30646c18321ef71e344bf0af6b8d3634b8",
      ],
    ]);
    for (const step of publish) {
      if (step.run !== undefined) {
        expect(commandsOf(step.run), step.name).toEqual(
          commandsOf(step.run).filter((command) =>
            PUBLISH_SHELL_COMMANDS.has(command),
          ),
        );
      }
    }
    const checkout = publish.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.["submodules"]).toBeUndefined();
    expect(checkout?.with?.["ref"]).toBe(
      githubExpression("steps.select.outputs.head"),
    );
    const download = publish.find(
      (step) => step.name === "Download regenerated baselines",
    );
    expect(download?.with).toMatchObject({
      name: "marketing-screenshots",
      "run-id": githubExpression("steps.select.outputs.run"),
    });
    const index = (name: string) =>
      publish.findIndex((step) => step.name === name);
    expect(index("Stage validated baselines")).toBeGreaterThan(
      index("Download regenerated baselines"),
    );
    expect(index("Mint App token")).toBeGreaterThan(
      index("Stage validated baselines"),
    );
    expect(index("Push regenerated baselines")).toBe(publish.length - 1);
    // Append mode builds on the checked-out head, the commit the capture ran
    // on, so a push that landed since fails instead of being overwritten.
    expect(publish.at(-1)?.with).toMatchObject({
      mode: "append",
      branch: githubExpression("steps.select.outputs.branch"),
      paths: "apps/landing/public/media/products/*.png",
    });
  });
});

describe("publish selection", () => {
  const select = new Script(
    `(async () => { ${
      v.parse(
        v.object({ script: v.string() }),
        workflowStepByName(
          workflowJobSteps(publishWorkflow, "publish"),
          "Select the branch",
        )["with"],
      ).script
    } })()`,
  );
  type Scenario = {
    runId: string;
    run: Record<string, unknown>;
    pulls: Record<string, unknown>[];
    artifacts: { name: string; expired: boolean }[];
  };
  const scenario = (): Scenario => ({
    runId: "7",
    run: {
      id: 7,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/marketing-screenshots-capture.yml",
      event: "workflow_dispatch",
      head_branch: "feat/ui",
      head_sha: HEAD,
      head_repository: { full_name: "stella/stella" },
    },
    pulls: [
      {
        head: {
          ref: "feat/ui",
          sha: HEAD,
          repo: { full_name: "stella/stella" },
        },
      },
    ],
    artifacts: [{ name: "marketing-screenshots", expired: false }],
  });
  const selectFor = async (input: Scenario) => {
    const outputs: Record<string, string> = {};
    const failures: string[] = [];
    const notices: string[] = [];
    await select.runInNewContext({
      process: { env: { CAPTURE_RUN_ID: input.runId } },
      context: { repo: { owner: "stella", repo: "stella" } },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        setFailed: (message: string) => {
          failures.push(message);
        },
        notice: (message: string) => {
          notices.push(message);
        },
      },
      github: {
        paginate: async (_route: unknown, params: Record<string, unknown>) => {
          expect(params["head"]).toBe(
            `stella:${String(input.run["head_branch"])}`,
          );
          return input.pulls;
        },
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
              return { data: { artifacts: input.artifacts } };
            },
          },
        },
      },
    });
    return { outputs, failures, notices };
  };

  test("publishes to the branch the capture ran on", async () => {
    expect(await selectFor(scenario())).toEqual({
      outputs: { branch: "feat/ui", head: HEAD, run: "7" },
      failures: [],
      notices: [],
    });
  });

  // The capture for a fork's pull request runs on a branch without one.
  test("leaves a branch with no pull request to its artifact", async () => {
    const input = scenario();
    input.pulls = [];
    const result = await selectFor(input);
    expect(result.outputs).toEqual({});
    expect(result.failures).toEqual([]);
    expect(result.notices).toHaveLength(1);
  });

  // A fork's pull request from a same-named branch is not this branch's.
  test("never publishes to a fork's pull request of the same branch name", async () => {
    const input = scenario();
    input.pulls = [
      {
        head: {
          ref: "feat/ui",
          sha: HEAD,
          repo: { full_name: "someone/stella" },
        },
      },
    ];
    const result = await selectFor(input);
    expect(result.outputs).toEqual({});
    expect(result.failures).toEqual([]);
  });

  const refused: { name: string; change: (input: Scenario) => void }[] = [
    ...["", "0", "7x", "-7", "1".repeat(16)].map((runId) => ({
      name: `the run id ${JSON.stringify(runId)}`,
      change: (input: Scenario) => {
        input.runId = runId;
      },
    })),
    {
      name: "a failed capture",
      change: (input) => {
        input.run["conclusion"] = "failure";
      },
    },
    {
      name: "a capture still running",
      change: (input) => {
        input.run["status"] = "in_progress";
        input.run["conclusion"] = null;
      },
    },
    {
      name: "another workflow's run",
      change: (input) => {
        input.run["path"] = ".github/workflows/x.yml";
      },
    },
    {
      name: "a non-dispatch run",
      change: (input) => {
        input.run["event"] = "push";
      },
    },
    {
      name: "main",
      change: (input) => {
        input.run["head_branch"] = "main";
      },
    },
    ...["feat/a..b", "-feat", "feat ui", ""].map((branch) => ({
      name: `the branch name ${JSON.stringify(branch)}`,
      change: (input: Scenario) => {
        input.run["head_branch"] = branch;
      },
    })),
    {
      name: "a malformed head SHA",
      change: (input) => {
        input.run["head_sha"] = "abc123";
      },
    },
    {
      name: "a fork",
      change: (input) => {
        input.run["head_repository"] = { full_name: "someone/stella" };
      },
    },
    {
      name: "a branch heading two pull requests",
      change: (input) => {
        input.pulls = [...input.pulls, ...input.pulls];
      },
    },
    {
      name: "a branch that moved since the capture",
      change: (input) => {
        input.pulls = [
          {
            head: {
              ref: "feat/ui",
              sha: "e".repeat(40),
              repo: { full_name: "stella/stella" },
            },
          },
        ];
      },
    },
    {
      name: "a run without baselines",
      change: (input) => {
        input.artifacts = [];
      },
    },
    {
      name: "expired baselines",
      change: (input) => {
        input.artifacts = [{ name: "marketing-screenshots", expired: true }];
      },
    },
  ];
  for (const { name, change } of refused) {
    // A refusal fails the run instead of finishing green with nothing pushed.
    test(`refuses ${name}`, async () => {
      const input = scenario();
      change(input);
      const result = await selectFor(input);
      expect(result.outputs).toEqual({});
      expect(result.failures).toHaveLength(1);
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

describe("update follows the capture to its publish", () => {
  const update = new Script(
    `(async () => { ${
      v.parse(
        v.object({ script: v.string() }),
        workflowStepByName(
          workflowJobSteps(updateWorkflow, "update"),
          "Capture on the branch and publish",
        )["with"],
      ).script
    } })()`,
  );
  const CAPTURE = 101;
  const PUBLISH = 202;
  type Run = { status: string; conclusion: string | null };
  const done = (conclusion: string): Run => ({
    status: "completed",
    conclusion,
  });
  const running: Run = { status: "in_progress", conclusion: null };
  type Scenario = {
    // States each run reports on successive polls; the last one repeats.
    polls: Record<number, Run[]>;
    runIds: Record<string, number | undefined>;
    // Runs a listing shows when a dispatch named none.
    listed: Record<string, { id: number; display_title: string }[]>;
  };
  const scenario = (): Scenario => ({
    polls: {
      [CAPTURE]: [running, running, done("success")],
      [PUBLISH]: [running, done("success")],
    },
    runIds: {
      "marketing-screenshots-capture.yml": CAPTURE,
      "marketing-screenshots-publish.yml": PUBLISH,
    },
    listed: {},
  });
  const updateFor = async (input: Scenario) => {
    const dispatches: Record<string, unknown>[] = [];
    const failures: string[] = [];
    const reads = new Map<number, number>();
    let sleeps = 0;
    let thrown: unknown;
    try {
      await update.runInNewContext({
        process: { env: { BRANCH: "feat/ui" } },
        setTimeout: (resolve: () => void) => {
          sleeps += 1;
          resolve();
        },
        context: { repo: { owner: "stella", repo: "stella" } },
        core: {
          notice: () => {},
          setFailed: (message: string) => {
            failures.push(message);
          },
        },
        github: {
          rest: {
            actions: {
              createWorkflowDispatch: async (
                request: Record<string, unknown>,
              ) => {
                expect(request["return_run_details"]).toBe(true);
                const { return_run_details: _, ...accepted } = request;
                dispatches.push(accepted);
                const id = input.runIds[String(request["workflow_id"])];
                return {
                  data:
                    id === undefined
                      ? undefined
                      : { workflow_run_id: id, html_url: `run/${String(id)}` },
                };
              },
              listWorkflowRuns: async (params: Record<string, unknown>) => {
                expect(params["event"]).toBe("workflow_dispatch");
                return {
                  data: {
                    workflow_runs:
                      input.listed[String(params["workflow_id"])] ?? [],
                  },
                };
              },
              getWorkflowRun: async (params: Record<string, unknown>) => {
                const id = Number(params["run_id"]);
                const states = input.polls[id] ?? [];
                const polled = reads.get(id) ?? 0;
                reads.set(id, polled + 1);
                return {
                  data: {
                    id,
                    html_url: `run/${String(id)}`,
                    ...states[Math.min(polled, states.length - 1)],
                  },
                };
              },
            },
          },
        },
      });
    } catch (error) {
      thrown = error;
    }
    return { dispatches, failures, sleeps, error: thrown };
  };

  test("publishes exactly the capture run it started, from main", async () => {
    const result = await updateFor(scenario());
    expect(result.error).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.dispatches).toEqual([
      {
        owner: "stella",
        repo: "stella",
        workflow_id: "marketing-screenshots-capture.yml",
        ref: "feat/ui",
      },
      {
        owner: "stella",
        repo: "stella",
        workflow_id: "marketing-screenshots-publish.yml",
        ref: "main",
        inputs: { capture_run_id: String(CAPTURE) },
      },
    ]);
  });

  test("a failed capture fails the update and publishes nothing", async () => {
    const input = scenario();
    input.polls[CAPTURE] = [done("failure")];
    const result = await updateFor(input);
    expect(result.dispatches).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });

  test("a capture that never finishes fails the update in bounded time", async () => {
    const input = scenario();
    input.polls[CAPTURE] = [running];
    const result = await updateFor(input);
    expect(result.dispatches).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.sleeps).toBe(80);
  });

  // The failure this guards against: a capture that succeeded while no
  // publish ever ran, and the update still finished green.
  for (const [name, states] of [
    ["a failed publish", [done("failure")]],
    ["a publish that never finishes", [running]],
  ] as const) {
    test(`${name} fails the update`, async () => {
      const input = scenario();
      input.polls[PUBLISH] = [...states];
      const result = await updateFor(input);
      expect(result.dispatches).toHaveLength(2);
      expect(result.failures).toHaveLength(1);
    });
  }

  for (const workflow of [
    "marketing-screenshots-capture.yml",
    "marketing-screenshots-publish.yml",
  ]) {
    test(`a ${workflow} run the dispatch did not name is found by listing`, async () => {
      const input = scenario();
      input.runIds[workflow] = undefined;
      input.listed = {
        "marketing-screenshots-capture.yml": [
          { id: CAPTURE, display_title: "Capture marketing screenshots" },
        ],
        "marketing-screenshots-publish.yml": [
          { id: 1, display_title: "Publish marketing screenshots of run 1" },
          {
            id: PUBLISH,
            display_title: `Publish marketing screenshots of run ${String(CAPTURE)}`,
          },
        ],
      };
      const result = await updateFor(input);
      expect(result.error).toBeUndefined();
      expect(result.failures).toEqual([]);
      expect(result.dispatches).toHaveLength(2);
    });

    test(`a ${workflow} run never found fails the update without publishing`, async () => {
      const input = scenario();
      input.runIds[workflow] = undefined;
      const result = await updateFor(input);
      expect(result.error).toBeUndefined();
      expect(result.failures).toEqual([
        `The dispatched ${workflow} run was not found`,
      ]);
      expect(result.dispatches.at(-1)?.["workflow_id"]).toBe(workflow);
    });
  }

  test("publish takes its capture from the dispatch input, on main only", () => {
    expect(jobsOf(publishWorkflow)["publish"]?.if).toBe(
      "github.ref == 'refs/heads/main'",
    );
    expect(
      v.parse(
        v.looseObject({ on: v.record(v.string(), v.unknown()) }),
        publishWorkflow,
      ).on,
    ).toEqual({
      workflow_dispatch: {
        inputs: {
          capture_run_id: expect.objectContaining({
            required: true,
            type: "string",
          }),
        },
      },
    });
    expect(
      stepsOf(publishWorkflow, "publish").find(
        (step) => step.name === "Select the branch",
      )?.env,
    ).toEqual({ CAPTURE_RUN_ID: githubExpression("inputs.capture_run_id") });
  });
});
