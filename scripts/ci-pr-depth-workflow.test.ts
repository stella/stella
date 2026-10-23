import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { prDepthJobs, prHeavyJobs, QUICK_GATED_CLAUSE } from "./ci-pr-jobs";
import { evaluate } from "./github-expression";

const readWorkflow = (name: string) =>
  v.parse(
    v.record(v.string(), v.unknown()),
    Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${name}`, import.meta.url),
        "utf-8",
      ),
    ),
  );
const ci = readWorkflow("ci.yml");
const main = readWorkflow("main-pr-depth.yml");
const releaseHealth = readFileSync(
  new URL("check-release-main-health.sh", import.meta.url),
  "utf-8",
);

const command = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(args, { cwd });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

const patchId = (cwd: string, base: string, head: string) => {
  const diff = Bun.spawnSync(["git", "diff", "--binary", `${base}..${head}`], {
    cwd,
  });
  expect(diff.exitCode).toBe(0);
  const result = Bun.spawnSync(["git", "patch-id", "--stable"], {
    cwd,
    stdin: diff.stdout,
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split(" ").at(0);
};

test("stable patch ids match across bases and reject a resolved change", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pr-depth-patch-id-"));
  try {
    command(directory, "git", "init", "-q", "--initial-branch", "main");
    command(directory, "git", "config", "commit.gpgsign", "false");
    command(directory, "git", "config", "user.name", "test");
    command(directory, "git", "config", "user.email", "test@example.com");
    writeFileSync(path.join(directory, "file"), "base\n");
    command(directory, "git", "add", "file");
    command(directory, "git", "commit", "-qm", "base");
    const base = command(directory, "git", "rev-parse", "HEAD");
    command(directory, "git", "switch", "-qc", "first");
    writeFileSync(path.join(directory, "file"), "base\nchange\n");
    command(directory, "git", "commit", "-qam", "change");
    const first = command(directory, "git", "rev-parse", "HEAD");
    command(directory, "git", "switch", "-q", "main");
    writeFileSync(path.join(directory, "other"), "other\n");
    command(directory, "git", "add", "other");
    command(directory, "git", "commit", "-qm", "new base");
    const secondBase = command(directory, "git", "rev-parse", "HEAD");
    writeFileSync(path.join(directory, "file"), "base\nchange\n");
    command(directory, "git", "commit", "-qam", "same change");
    const same = command(directory, "git", "rev-parse", "HEAD");
    expect(patchId(directory, base, first)).toBe(
      patchId(directory, secondBase, same),
    );
    writeFileSync(path.join(directory, "file"), "base\nresolved differently\n");
    command(directory, "git", "commit", "-qam", "resolved change");
    const resolved = command(directory, "git", "rev-parse", "HEAD");
    expect(patchId(directory, secondBase, resolved)).not.toBe(
      patchId(directory, base, first),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hourly workflow calls the derived PR-depth set and publishes its status", () => {
  const parsed = v.parse(
    v.object({
      on: v.object({
        schedule: v.array(v.object({ cron: v.string() })),
        workflow_dispatch: v.unknown(),
      }),
      jobs: v.record(v.string(), v.unknown()),
    }),
    main,
  );
  expect(parsed.on.schedule).toEqual([{ cron: "47 * * * *" }]);
  expect(JSON.stringify(main)).toContain("main/pr-depth");
  expect(JSON.stringify(main)).toContain('"pr_depth_only":true');
  expect(prDepthJobs(ci)).toEqual([
    "ci-checks-generated",
    "ci-checks-policy",
    "ci-checks-rest",
    "code-quality-api",
    "code-quality-web-rest",
    "generated-sources",
  ]);
  expect(prHeavyJobs(ci)).toEqual([
    "api-test-durations",
    "ci-browser",
    "ci-tests",
    "e2e-landing",
    "e2e-production-shard",
    "e2e-report",
    "marketing-screenshots",
    "marketing-screenshots-cancel",
    "postgres-service-suites",
    "route-smoke",
    "service-suites",
    "web-build",
  ]);
});

test("Bun YAML resolves anchors, aliases and merge keys for PR job planning", () => {
  const parsed: unknown = Bun.YAML.parse(`
defaults: &defaults
  needs: pr-heavy-gate
jobs:
  ci-result:
    steps:
      - name: Evaluate CI outcome
        env:
          FAST_REQUIRED: '["ci-checks-policy"]'
  ci-checks-policy: &check
    needs: generated-sources
  code-quality-api: *check
  inherited:
    <<: *defaults
`);
  expect(prDepthJobs(parsed)).toEqual([
    "ci-checks-policy",
    "generated-sources",
  ]);
  expect(prHeavyJobs(parsed)).toEqual(["inherited"]);
});

const ciJobs = v.parse(
  v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      steps: v.optional(
        v.array(
          v.looseObject({
            id: v.optional(v.string()),
            name: v.optional(v.string()),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      ),
    }),
  ),
  ci["jobs"],
);
const REUSE_SKIP = "needs.ci-plan.outputs.pr_depth_reused != 'true'";
const MAIN_SKIP = "inputs.pr_depth_only != true";
// Jobs that only orchestrate: the planner, the result gate and a cancellation
// helper that acts on another job's failure. The quick checks also run on a
// PR-depth run for the wall-clock waiver guard; each other part's step keeps
// the main skip.
const ORCHESTRATION_JOBS = new Set([
  "ci-plan",
  "ci-result",
  "ci-quick-checks",
  "marketing-screenshots-cancel",
  "code-quality-api-cancel",
  "code-quality-web-rest-cancel",
]);

type SkipViolationsOptions = {
  jobs: typeof ciJobs;
  depthJobs: readonly string[];
};
const skipViolations = ({ jobs, depthJobs }: SkipViolationsOptions) =>
  Object.entries(jobs).flatMap(([job, { if: condition = "" }]) => {
    if (ORCHESTRATION_JOBS.has(job)) {
      return [];
    }
    const depth = depthJobs.includes(job);
    const reuseSkip = condition.includes(REUSE_SKIP);
    const mainSkip = condition.includes(MAIN_SKIP);
    return depth === reuseSkip && depth !== mainSkip ? [] : [job];
  });

test("PR-depth jobs retain reuse guards; other jobs stay off the main PR-depth run", () => {
  const depthJobs = prDepthJobs(ci);
  expect(skipViolations({ jobs: ciJobs, depthJobs })).toEqual([]);
  const malware = ciJobs["dependency-malware"];
  expect(
    skipViolations({
      jobs: { ...ciJobs, "dependency-malware": { ...malware, if: REUSE_SKIP } },
      depthJobs,
    }),
  ).toEqual(["dependency-malware"]);
  // Only the waiver guard of the quick checks runs on a PR-depth run.
  const quickParts = (ciJobs["ci-quick-checks"]?.steps ?? []).filter(
    ({ name }) =>
      name?.startsWith("parser-version-guard: ") ||
      name?.startsWith("ci-checks-docs: "),
  );
  expect(quickParts).toHaveLength(2);
  for (const step of quickParts) {
    expect(step.if, step.name).toContain(MAIN_SKIP);
  }
  expect(
    skipViolations({ jobs: ciJobs, depthJobs: [...depthJobs, "ci-tests"] }),
  ).toEqual(["ci-tests"]);
});

// A PR-depth run checks a dispatched commit, which differs from the workflow's
// own ref for a release candidate. A producer and its consumers that check out
// different commits restore generated sources that belong to another tree.
const TARGET_REF = [
  "$",
  "{{ (inputs.heavy_only == true || inputs.pr_depth_only == true) && inputs.sha || '' }}",
].join("");
const checkoutRef = (job: string) => {
  const checkout = (ciJobs[job]?.steps ?? [])
    .map((step) =>
      v.parse(
        v.looseObject({
          uses: v.optional(v.string()),
          with: v.optional(v.record(v.string(), v.unknown())),
        }),
        step,
      ),
    )
    .find(({ uses }) => uses?.startsWith("actions/checkout@"));
  return checkout?.with?.["ref"] ?? null;
};

test("every PR-depth job checks out the commit the run checks", () => {
  const depthJobs = prDepthJobs(ci);
  expect(depthJobs).toContain("generated-sources");
  expect(depthJobs.filter((job) => checkoutRef(job) !== TARGET_REF)).toEqual(
    [],
  );
});

test("reused PR-depth evidence still schedules every merge-group code check", () => {
  for (const event of ["pull_request", "merge_group"]) {
    for (const queueDepth of ["thin", "full"]) {
      for (const job of prDepthJobs(ci)) {
        const scheduled = evaluate(ciJobs[job]?.if ?? "false", {
          values: {
            "github.event_name": event,
            "inputs.heavy_only": false,
            "inputs.pr_depth_only": false,
            "needs.ci-plan.result": "success",
            "needs.generated-sources.result": "success",
            // The gate runs on pull requests only.
            "needs.pr-heavy-gate.result":
              event === "merge_group" ? "skipped" : "success",
            "needs.ci-plan.outputs.pr_depth_reused": "true",
            "needs.ci-plan.outputs.run_required": "true",
            "needs.ci-plan.outputs.trusted": "true",
            "needs.ci-plan.outputs.suite_depth": "full",
            "needs.ci-plan.outputs.queue_depth": queueDepth,
            "needs.ci-plan.outputs.coverage_profile": "normal-v1",
            "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
          },
          fallback: (name) =>
            name.startsWith("needs.ci-plan.outputs.") &&
            name.endsWith("_required")
              ? "true"
              : undefined,
          status: {
            always: true,
            success: true,
            failure: false,
            cancelled: false,
          },
        });
        expect(scheduled, `${event}/${queueDepth}/${job}`).toBe(
          event === "merge_group",
        );
      }
    }
  }
});

// The repository checks and the desktop Rust lint wait for the quick checks
// on a pull request, like the heavy suites, but never in a merge group and
// not on a push whose plan schedules no gate.
const QUICK_GATED_JOBS = [
  "ci-checks-policy",
  "ci-checks-rest",
  "code-quality-api",
  "code-quality-web-rest",
  "desktop-rust-lint",
] as const;

const jobNeeds = (job: string) => {
  const { needs } = v.parse(
    v.object({ needs: v.union([v.string(), v.array(v.string())]) }),
    v.parse(v.record(v.string(), v.unknown()), ci["jobs"])[job],
  );
  return typeof needs === "string" ? [needs] : needs;
};

test("the repository checks and desktop Rust lint wait for the quick checks on pull requests only", () => {
  for (const job of QUICK_GATED_JOBS) {
    expect(jobNeeds(job), job).toContain("pr-heavy-gate");
    expect(ciJobs[job]?.if, job).toContain(QUICK_GATED_CLAUSE);
  }
  // Other jobs consume the generated sources, so they never wait.
  expect(jobNeeds("generated-sources")).not.toContain("pr-heavy-gate");
  expect(
    prHeavyJobs(ci).filter((job) =>
      QUICK_GATED_JOBS.some((gated) => gated === job),
    ),
  ).toEqual([]);
  expect(prDepthJobs(ci)).not.toContain("pr-heavy-gate");

  const runs = (
    job: string,
    event: string,
    gatePlanned: boolean,
    gate: string,
  ) =>
    evaluate(ciJobs[job]?.if ?? "false", {
      values: {
        "github.event_name": event,
        "inputs.heavy_only": false,
        "inputs.pr_depth_only": false,
        "needs.ci-plan.result": "success",
        "needs.generated-sources.result": "success",
        "needs.pr-heavy-gate.result": gate,
        "needs.ci-plan.outputs.pr_heavy_gate_required": String(gatePlanned),
        "needs.ci-plan.outputs.pr_depth_reused": "false",
        "needs.ci-plan.outputs.run_required": "true",
        "needs.ci-plan.outputs.trusted": "true",
      },
      fallback: (name) =>
        name.startsWith("needs.ci-plan.outputs.") && name.endsWith("_required")
          ? "true"
          : undefined,
      status: { always: true, success: true, failure: false, cancelled: false },
    });
  for (const job of QUICK_GATED_JOBS) {
    expect(runs(job, "pull_request", true, "success"), job).toBe(true);
    for (const gate of ["failure", "skipped", "cancelled"]) {
      expect(runs(job, "pull_request", true, gate), `${job}/${gate}`).toBe(
        false,
      );
    }
    // A push that only merges the base reuses the heavy suites, schedules no
    // gate, and still runs these checks.
    expect(runs(job, "pull_request", false, "skipped"), job).toBe(true);
    expect(runs(job, "merge_group", false, "skipped"), job).toBe(true);
  }
});

const planSteps = v.parse(
  v.array(
    v.looseObject({
      id: v.optional(v.string()),
      name: v.optional(v.string()),
      if: v.optional(v.string()),
      run: v.optional(v.string()),
      with: v.optional(v.record(v.string(), v.unknown())),
    }),
  ),
  ciJobs["ci-plan"]?.steps,
);
const planStep = (name: string) =>
  v.parse(
    v.looseObject({
      if: v.optional(v.string()),
      run: v.optional(v.string()),
      "working-directory": v.optional(v.string()),
      with: v.optional(v.record(v.string(), v.unknown())),
    }),
    planSteps.find((step) => step.name === name),
  );
const derivation = planStep("Derive PR jobs");
const planStepIndex = (name: string) =>
  planSteps.findIndex((step) => step.name === name);

type RunDerivationOptions = {
  runnerTemp: string;
};
const runDerivation = ({ runnerTemp }: RunDerivationOptions) => {
  // An empty workspace, like a scheduled caller before any source checkout.
  const workspace = mkdtempSync(path.join(tmpdir(), "pr-depth-workspace-"));
  const output = path.join(runnerTemp, "output");
  writeFileSync(output, "");
  try {
    const result = Bun.spawnSync(
      [process.execPath, path.join(runnerTemp, "ci-pr-jobs-cli.ts")],
      {
        cwd: workspace,
        env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp },
      },
    );
    return { result, output: readFileSync(output, "utf-8") };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
};

test("the PR job derivation never reads Bun config from the pull request tree before trust", () => {
  // The step runs before the trust check, so its working directory must hold
  // only the trusted tooling copies: Bun loads bunfig.toml (preload scripts)
  // and tsconfig paths from the current directory.
  expect(derivation["working-directory"]).toBe(`\${{ runner.temp }}`);
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "pr-jobs-runner-"));
  const pullRequestTree = mkdtempSync(path.join(tmpdir(), "pr-jobs-tree-"));
  const marker = path.join(pullRequestTree, "preloaded");
  try {
    for (const file of ["ci-pr-jobs.ts", "ci-pr-jobs-cli.ts"]) {
      writeFileSync(
        path.join(runnerTemp, file),
        readFileSync(new URL(file, import.meta.url), "utf-8"),
      );
    }
    writeFileSync(
      path.join(runnerTemp, "ci-workflow.yml"),
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    );
    writeFileSync(
      path.join(pullRequestTree, "bunfig.toml"),
      'preload = ["./hostile.ts"]\n',
    );
    writeFileSync(
      path.join(pullRequestTree, "hostile.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    const output = path.join(runnerTemp, "output");
    const derive = (cwd: string) => {
      writeFileSync(output, "");
      return Bun.spawnSync(
        [process.execPath, path.join(runnerTemp, "ci-pr-jobs-cli.ts")],
        {
          cwd,
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            RUNNER_TEMP: runnerTemp,
          },
        },
      );
    };
    // Control: from the pull request tree, the hostile preload runs.
    derive(pullRequestTree);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // From the step's working directory it never does, and the plan still works.
    const result = derive(runnerTemp);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(pullRequestTree, { recursive: true, force: true });
  }
});

test("the planner derives exactly prDepthJobs before any source checkout", () => {
  // The workflow file comes from the unconditional tooling fetch at
  // workflow_sha and is preserved before the derivation runs.
  const fetch = planStep("Fetch GitHub API tooling");
  expect(fetch.if).toBeUndefined();
  expect(fetch.with?.["ref"]).toBe(`\${{ github.workflow_sha }}`);
  expect(String(fetch.with?.["sparse-checkout"])).toContain(
    ".github/workflows/ci.yml",
  );
  expect(String(fetch.with?.["sparse-checkout"])).toContain(
    "scripts/ci-pr-jobs-cli.ts",
  );
  const preserve = planStep("Preserve this run's CI workflow for planning").run;
  expect(preserve).toContain(
    'cp "$GITHUB_WORKSPACE/.workflow-tooling/.github/workflows/ci.yml" "$RUNNER_TEMP/ci-workflow.yml"',
  );
  expect(preserve).toContain('"$RUNNER_TEMP/ci-pr-jobs-cli.ts"');
  expect(derivation.if).toBeUndefined();
  for (const earlier of [
    "Fetch GitHub API tooling",
    "Preserve this run's CI workflow for planning",
  ]) {
    expect(planStepIndex(earlier)).toBeLessThan(
      planStepIndex("Derive PR jobs"),
    );
  }

  expect(derivation.run).toBe('bun "$RUNNER_TEMP/ci-pr-jobs-cli.ts"');
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "pr-depth-runner-"));
  try {
    for (const file of ["ci-pr-jobs.ts", "ci-pr-jobs-cli.ts"]) {
      writeFileSync(
        path.join(runnerTemp, file),
        readFileSync(new URL(file, import.meta.url), "utf-8"),
      );
    }
    const missing = runDerivation({ runnerTemp });
    expect(missing.result.exitCode).not.toBe(0);
    writeFileSync(
      path.join(runnerTemp, "ci-workflow.yml"),
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    );
    const derived = runDerivation({ runnerTemp });
    expect(derived.result.exitCode, derived.result.stderr.toString()).toBe(0);
    expect(derived.output).toBe(
      `pr_depth_jobs=${JSON.stringify(prDepthJobs(ci))}\npr_heavy_jobs=${JSON.stringify(prHeavyJobs(ci))}\n`,
    );
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("the release gate requires heavy and PR-depth status provenance", () => {
  expect(releaseHealth).toContain('validate_workflow_status "main/heavy"');
  expect(releaseHealth).toContain('validate_workflow_status "main/pr-depth"');
});

test("the patch-id step leaves reuse off for an empty net change", () => {
  const script = v.parse(v.string(), planStep("Compute stable patch id").run);
  const directory = mkdtempSync(path.join(tmpdir(), "pr-depth-empty-change-"));
  try {
    command(directory, "git", "init", "-q", "--initial-branch", "main");
    command(directory, "git", "config", "commit.gpgsign", "false");
    command(directory, "git", "config", "user.name", "test");
    command(directory, "git", "config", "user.email", "test@example.com");
    mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(directory, ".github/workflows/ci.yml"),
      "name: CI\n",
    );
    writeFileSync(path.join(directory, "file"), "base\n");
    command(directory, "git", "add", ".");
    command(directory, "git", "commit", "-qm", "base");
    const base = command(directory, "git", "rev-parse", "HEAD");
    const run = (head: string) => {
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", script], {
        cwd: directory,
        env: {
          ...process.env,
          EVENT_NAME: "pull_request",
          PR_BASE_SHA: base,
          PR_HEAD_SHA: head,
          WORKFLOW_SHA: head,
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return readFileSync(output, "utf-8");
    };
    // A pull request that reverts itself: the head moved, the net change is empty.
    writeFileSync(path.join(directory, "file"), "changed\n");
    command(directory, "git", "commit", "-qam", "change");
    writeFileSync(path.join(directory, "file"), "base\n");
    command(directory, "git", "commit", "-qam", "revert");
    expect(run(command(directory, "git", "rev-parse", "HEAD"))).toMatch(
      /^patch_id=\n/mu,
    );
    writeFileSync(path.join(directory, "file"), "real change\n");
    command(directory, "git", "commit", "-qam", "real");
    expect(run(command(directory, "git", "rev-parse", "HEAD"))).toMatch(
      /^patch_id=[0-9a-f]{40}\n/mu,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the hourly workflow never cancels a running check", () => {
  const concurrency = v.parse(
    v.object({ group: v.string(), "cancel-in-progress": v.literal(false) }),
    main["concurrency"],
  );
  expect(concurrency.group).toContain("github.ref");
});

const statusScript = new URL("main-pr-depth-status.sh", import.meta.url)
  .pathname;
const statusSha = "b".repeat(40);
type WorkflowRun = {
  id: number;
  event: string;
  display_title: string;
  status: string;
  conclusion: string | null;
};
type StatusCase = {
  results: Record<string, string>;
  runs?: WorkflowRun[];
};
const publishStatus = ({ results, runs = [] }: StatusCase) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pr-depth-status-"));
  try {
    const calls = path.join(directory, "calls");
    const runsFile = path.join(directory, "runs.json");
    writeFileSync(runsFile, JSON.stringify({ workflow_runs: runs }));
    writeFileSync(calls, "");
    const stub = path.join(directory, "gh-retry.sh");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$*" in *"/runs?"*) cat "${runsFile}";; esac\n`,
    );
    const result = Bun.spawnSync(["bash", statusScript], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GH_RETRY: stub,
        RESULTS: JSON.stringify(
          Object.fromEntries(
            Object.entries(results).map(([job, outcome]) => [
              job,
              { result: outcome },
            ]),
          ),
        ),
        SHA: statusSha,
        RUN_ID: "100",
        REPOSITORY: "example/repository",
        RUN_URL: "https://example.test/run/100",
      },
    });
    const posted = readFileSync(calls, "utf-8")
      .split("\n")
      .filter((line) => line.includes("--method POST"))
      .map((line) => /state=(\w+)/u.exec(line)?.[1]);
    return { exitCode: result.exitCode, posted };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
type LaterRunOptions = {
  id?: number;
  event?: string;
  sha?: string;
  status?: string;
  conclusion?: string | null;
};
const laterRun = ({
  id = 101,
  event = "schedule",
  sha = statusSha,
  status = "in_progress",
  conclusion = null,
}: LaterRunOptions): WorkflowRun => ({
  id,
  event,
  display_title: `Main PR-depth checks ${sha}`,
  status,
  conclusion,
});

test("the workflow publishes its status through the supersession-aware script", () => {
  expect(JSON.stringify(main)).toContain("scripts/main-pr-depth-status.sh");
});

test("green suites publish success and red suites publish failure", () => {
  expect(
    publishStatus({ results: { validate: "success", suites: "success" } }),
  ).toEqual({ exitCode: 0, posted: ["success"] });
  expect(
    publishStatus({ results: { validate: "success", suites: "failure" } }),
  ).toEqual({ exitCode: 1, posted: ["failure"] });
});

test("a cancelled run defers only to a later running or completed green run for the same commit", () => {
  const cancelled = { validate: "success", suites: "cancelled" };
  for (const run of [
    laterRun({}),
    laterRun({ status: "completed", conclusion: "success" }),
  ]) {
    // Writing nothing means a successor's terminal status can never be overwritten.
    expect(publishStatus({ results: cancelled, runs: [run] })).toEqual({
      exitCode: 0,
      posted: [],
    });
  }
  for (const run of [
    laterRun({ status: "queued" }),
    laterRun({ status: "pending" }),
    laterRun({ status: "waiting" }),
    laterRun({ status: "requested" }),
    laterRun({ sha: "c".repeat(40) }),
    laterRun({ status: "completed", conclusion: "failure" }),
    laterRun({ status: "completed", conclusion: "cancelled" }),
    laterRun({ id: 99 }),
    // A dispatched run may stop before it knows its SHA, so it never owns the status.
    laterRun({ event: "workflow_dispatch" }),
  ]) {
    expect(publishStatus({ results: cancelled, runs: [run] })).toEqual({
      exitCode: 1,
      posted: ["failure"],
    });
  }
  expect(publishStatus({ results: cancelled })).toEqual({
    exitCode: 1,
    posted: ["failure"],
  });
});

test("a queued same-SHA successor replaced by a different-SHA request leaves a terminal status", () => {
  const cancelled = { validate: "success", suites: "cancelled" };
  const pendingSuccessor = laterRun({ status: "queued" });
  const replacement = laterRun({
    id: 102,
    sha: "c".repeat(40),
    status: "queued",
  });
  for (const runs of [
    [pendingSuccessor],
    [
      { ...pendingSuccessor, status: "completed", conclusion: "cancelled" },
      replacement,
    ],
  ]) {
    expect(publishStatus({ results: cancelled, runs })).toEqual({
      exitCode: 1,
      posted: ["failure"],
    });
  }
});

test("a cancellation next to a failed job is never treated as superseded", () => {
  expect(
    publishStatus({
      results: { validate: "failure", suites: "cancelled" },
      runs: [laterRun({})],
    }),
  ).toEqual({ exitCode: 1, posted: ["failure"] });
});

const statusStep = v
  .parse(
    v.object({
      jobs: v.object({
        status: v.object({
          steps: v.array(
            v.looseObject({
              name: v.string(),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        }),
      }),
    }),
    main,
  )
  .jobs.status.steps.find(
    (step) => step.name === "Publish PR-depth conclusion",
  );

test("a scheduled successor publishes even when validation stops before its SHA output", () => {
  const source = v.parse(v.string(), statusStep?.env?.["SHA"]);
  const sha = (event: string, validated: string) =>
    evaluate(source, {
      values: {
        "needs.validate.outputs.sha": validated,
        "github.event_name": event,
        "github.sha": statusSha,
      },
    });
  expect(sha("schedule", "")).toBe(statusSha);
  expect(sha("schedule", "d".repeat(40))).toBe("d".repeat(40));
  expect(sha("workflow_dispatch", "")).toBe("");
});

test("cancelled validation with skipped suites defers like cancelled suites; a real failure never does", () => {
  const runs = [laterRun({})];
  expect(
    publishStatus({
      results: { validate: "cancelled", suites: "skipped" },
      runs,
    }),
  ).toEqual({ exitCode: 0, posted: [] });
  expect(
    publishStatus({
      results: { validate: "failure", suites: "skipped" },
      runs,
    }),
  ).toEqual({ exitCode: 1, posted: ["failure"] });
});
