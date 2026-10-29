import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { PROBE_PHASE_BUDGET_MS } from "./dated-waiver-probes";
import { evaluate } from "./github-expression";
import { workflowCiInstallFlags } from "./workflow-steps";

const workflow = v.parse(
  v.object({
    on: v.object({
      schedule: v.array(v.object({ cron: v.string() })),
      workflow_dispatch: v.unknown(),
    }),
    concurrency: v.object({ "cancel-in-progress": v.boolean() }),
    permissions: v.record(v.string(), v.string()),
    jobs: v.object({
      heal: v.object({
        if: v.string(),
        "timeout-minutes": v.number(),
        permissions: v.record(v.string(), v.string()),
        steps: v.array(
          v.looseObject({
            name: v.string(),
            id: v.optional(v.string()),
            if: v.optional(v.string()),
            uses: v.optional(v.string()),
            run: v.optional(v.string()),
            "timeout-minutes": v.optional(v.number()),
            with: v.optional(v.record(v.string(), v.unknown())),
            env: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/dated-waiver-healing.yml", import.meta.url),
      "utf-8",
    ),
  ),
);

const steps = workflow.jobs.heal.steps;
const requiredStep = (name: string) => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new TypeError(`Missing healing step: ${name}`);
  }
  return step;
};

test("scheduled healing is serialized and cannot write through the workflow token", () => {
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.heal.permissions).toEqual({
    contents: "read",
    "pull-requests": "read",
    checks: "read",
  });
  expect(workflow.jobs.heal.if).toBe("github.repository == 'stella/stella'");
  expect(requiredStep("Checkout default branch").with).toMatchObject({
    ref: `\${{ github.event.repository.default_branch }}`,
    "persist-credentials": false,
  });
});

test("package and probe execution precede conditional write credential minting", () => {
  const token = requiredStep("Mint app token");
  const probe = requiredStep("Probe dated entries");
  const publish = requiredStep("Publish healing results");
  const condition = "steps.probe.outputs.write_needed == 'true'";
  expect(steps.indexOf(requiredStep("Install dependencies"))).toBeLessThan(
    steps.indexOf(probe),
  );
  expect(steps.indexOf(probe)).toBeLessThan(steps.indexOf(token));
  expect(probe.env?.["GH_TOKEN"]).toBe(`\${{ github.token }}`);
  expect(token.if).toBe(condition);
  expect(publish.if).toBe(condition);
  expect(requiredStep("Validate private task configuration").if).toBe(
    condition,
  );
  for (const step of steps.slice(0, steps.indexOf(token))) {
    expect(JSON.stringify(step)).not.toContain("app-token.outputs.token");
  }
  expect(
    Object.fromEntries(
      Object.entries(token.with ?? {}).filter(([key]) =>
        key.startsWith("permission-"),
      ),
    ),
  ).toEqual({
    "permission-contents": "write",
    "permission-issues": "write",
    "permission-pull-requests": "write",
  });
  expect(token.with?.["repositories"]).toContain("DATED_WAIVER_FIX_REPOSITORY");
  expect(publish.env?.["GH_READ_TOKEN"]).toBe(`\${{ github.token }}`);
});

test("probe evidence stays local and public output does not expose failed probes", () => {
  const probe = requiredStep("Probe dated entries");
  const publish = requiredStep("Publish healing results");
  const evidenceArgument =
    '--evidence "$RUNNER_TEMP/dated-waiver-evidence.json"';
  expect(probe.run).toContain(`--probe ${evidenceArgument}`);
  expect(publish.run).toContain(`--publish ${evidenceArgument}`);
  expect(requiredStep("Remove local evidence")).toMatchObject({
    if: "always()",
    run: 'rm -f "$RUNNER_TEMP/dated-waiver-evidence.json"',
  });
  for (const step of steps) {
    expect(step.uses ?? "").not.toContain("upload-artifact");
    expect(step.run ?? "").not.toMatch(/\b(cat|tee)\b|gh pr merge/u);
  }
});

test("the shared probe deadline preserves a separate publication budget", () => {
  const minuteMs = 60_000;
  const probeMinutes = v.parse(
    v.number(),
    requiredStep("Probe dated entries")["timeout-minutes"],
  );
  const publishMinutes = v.parse(
    v.number(),
    requiredStep("Publish healing results")["timeout-minutes"],
  );
  expect(PROBE_PHASE_BUDGET_MS).toBeGreaterThan(0);
  expect(PROBE_PHASE_BUDGET_MS).toBeLessThan(probeMinutes * minuteMs);
  expect(probeMinutes).toBeLessThan(workflow.jobs.heal["timeout-minutes"]);
  expect(publishMinutes).toBeGreaterThanOrEqual(15);
  const allocatedMinutes = steps.reduce(
    (total, step) => total + (step["timeout-minutes"] ?? 0),
    0,
  );
  // Checkout and Bun setup have at least two minutes outside these allocations.
  expect(allocatedMinutes).toBeLessThanOrEqual(
    workflow.jobs.heal["timeout-minutes"] - 2,
  );
  for (const name of [
    "Install dependencies",
    "Probe dated entries",
    "Validate private task configuration",
    "Mint app token",
    "Publish healing results",
  ]) {
    expect(requiredStep(name)["timeout-minutes"]).toBeGreaterThan(0);
  }
  expect(requiredStep("Publish healing results").if).toBe(
    "steps.probe.outputs.write_needed == 'true'",
  );
});

test("every healing job has an explicit main event policy", () => {
  const policy = v.parse(
    v.object({ jobs: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(
        new URL("../.github/ci-event-policy.json", import.meta.url),
        "utf-8",
      ),
    ),
  );
  for (const job of Object.keys(workflow.jobs)) {
    expect(policy.jobs[`dated-waiver-healing.yml/${job}`]).toBe("main");
  }
});

test("required CI expiry checks cannot be skipped by paths, reuse, or queue depth", () => {
  const ci = v.parse(
    v.object({
      jobs: v.object({
        "ci-quick-checks": v.object({
          if: v.string(),
          needs: v.string(),
          steps: v.array(
            v.looseObject({
              name: v.string(),
              if: v.optional(v.string()),
              run: v.optional(v.string()),
              "continue-on-error": v.optional(v.boolean()),
              with: v.optional(v.record(v.string(), v.unknown())),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        }),
        "pr-heavy-gate": v.object({
          if: v.string(),
          needs: v.string(),
          steps: v.array(
            v.looseObject({
              name: v.string(),
              if: v.optional(v.string()),
              run: v.optional(v.string()),
              "continue-on-error": v.optional(v.boolean()),
              with: v.optional(v.record(v.string(), v.unknown())),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        }),
        "ci-result": v.object({
          needs: v.array(v.string()),
          steps: v.array(
            v.looseObject({
              name: v.string(),
              env: v.optional(v.record(v.string(), v.string())),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  // Both event-specific quick-check carriers wait for the plan without
  // reading its result, so a failed plan still runs the active carrier.
  const expiry = ci.jobs["ci-quick-checks"];
  const pullRequestExpiry = ci.jobs["pr-heavy-gate"];
  expect(expiry.needs).toBe("ci-plan");
  expect(pullRequestExpiry.needs).toBe("ci-plan");
  expect(expiry.if).not.toContain("needs.");
  expect(pullRequestExpiry.if).not.toContain("needs.");
  const result = ci.jobs["ci-result"];
  expect(result.needs).toContain("ci-quick-checks");
  const outcome = result.steps.find(
    ({ name }) => name === "Evaluate CI outcome",
  );
  if (!outcome) {
    throw new TypeError("Missing required CI outcome step");
  }
  expect(JSON.parse(outcome.env?.["JOB_SCOPES"] ?? "{}")).toMatchObject({
    "ci-quick-checks": null,
    "pr-heavy-gate": null,
  });
  expect(JSON.parse(outcome.env?.["FAST_REQUIRED"] ?? "[]")).toContain(
    "pr-heavy-gate",
  );
  const guardSteps = expiry.steps.filter(({ name }) =>
    name.startsWith("dated-waiver-expiry: "),
  );
  expect(guardSteps).toHaveLength(3);
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    const context = {
      values: {
        "github.event_name": event,
        "github.event.action": "reopened",
        "github.event.pull_request.draft": false,
        "needs.ci-plan.outputs.run_required": "false",
        "needs.ci-plan.outputs.package_checks_required": "false",
        "needs.ci-plan.outputs.docs_checks_required": "true",
        "needs.ci-plan.outputs.pr_depth_reused": "true",
        "inputs.heavy_only": false,
        "inputs.pr_depth_only": true,
      },
      status: { always: true, cancelled: false },
    };
    const carrier = event === "pull_request" ? pullRequestExpiry : expiry;
    context.values["inputs.pr_depth_only"] = event !== "pull_request";
    expect(evaluate(carrier.if, context), event).toBe(true);
    for (const step of guardSteps) {
      expect(evaluate(step.if ?? "true", context), step.name).toBe(true);
    }
    // A heavy-only dispatch adds heavy suites to a tree whose merge group
    // already ran this thin job, so it is the one run that skips it.
    expect(
      evaluate(carrier.if, {
        ...context,
        values: { ...context.values, "inputs.heavy_only": true },
      }),
      event,
    ).toBe(false);
    // An enqueued head skips it: its merge group runs it on the queued tree.
    expect(
      evaluate(carrier.if, {
        ...context,
        values: { ...context.values, "github.event.action": "enqueued" },
      }),
      event,
    ).toBe(event !== "pull_request");
  }
  const install = expiry.steps.find(
    ({ name }) => name === "Install dependencies",
  );
  const check = expiry.steps.find(
    ({ name }) =>
      name ===
      "dated-waiver-expiry: Check dated waiver expiry on the current tree",
  );
  const trackedFiles = expiry.steps.find(
    ({ name }) =>
      name === "dated-waiver-expiry: List tracked files for dated waiver guard",
  );
  if (!install) {
    throw new TypeError("Missing dated waiver install");
  }
  expect(workflowCiInstallFlags(install)).toEqual([
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
  expect(trackedFiles?.run).toBe(
    'git ls-files -z > "$RUNNER_TEMP/dated-waiver-tracked-files"',
  );
  // Offline, over the tracked tree, always scoped to the run's change: an
  // unset list fails the check instead of widening it to every waiver.
  expect(check?.run).toBe(
    'bun --preload ./scripts/offline-network-preload.ts scripts/dated-waivers.ts --check --tracked-files "$RUNNER_TEMP/dated-waiver-tracked-files" --changed-files "$DATED_WAIVER_CHANGED_FILES"',
  );
  for (const step of expiry.steps) {
    expect(step.env?.["GH_TOKEN"]).toBeUndefined();
    expect(step["continue-on-error"]).not.toBe(true);
  }
});

// A run lists the change it carries, so a waiver that elapses overnight fails
// the change touching its file, never a main run that changed nothing.
test("CI expiry runs list the files their change touched", () => {
  const ci: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  );
  const quickChecks = v.parse(
    v.object({
      jobs: v.object({
        "ci-quick-checks": v.object({
          steps: v.array(
            v.looseObject({ name: v.string(), run: v.optional(v.string()) }),
          ),
        }),
      }),
    }),
    ci,
  ).jobs["ci-quick-checks"].steps;
  const list = quickChecks.find(
    ({ name }) => name === "dated-waiver-expiry: List files the change touches",
  )?.run;
  if (list === undefined) {
    throw new TypeError("Missing dated waiver change listing");
  }
  const directory = mkdtempSync(path.join(tmpdir(), "dated-waiver-scope-"));
  const runnerTemp = mkdtempSync(path.join(tmpdir(), "dated-waiver-runner-"));
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: directory });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    const commit = (file: string) => {
      writeFileSync(path.join(directory, file), `${file}\n`);
      git("add", file);
      git("commit", "--quiet", "--message", file);
    };
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI");
    commit("readme.md");
    const before = git("rev-parse", "HEAD");
    // One push carries the waiver change and then an unrelated commit.
    commit("waivers.ts");
    commit("unrelated.ts");
    git("update-ref", "refs/remotes/origin/main", before);

    const listed = (event: string, env: Record<string, string> = {}) => {
      const githubEnv = path.join(runnerTemp, `${event}.env`);
      writeFileSync(githubEnv, "");
      const run = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", list], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_ENV: githubEnv,
          GITHUB_EVENT_NAME: event,
          RUNNER_TEMP: runnerTemp,
          TARGET_REF: "",
          PUSH_BEFORE: "",
          ...env,
        },
      });
      expect(run.stderr.toString(), event).toBe("");
      expect(run.exitCode, event).toBe(0);
      const changed = path.join(runnerTemp, "dated-waiver-changed-files");
      expect(readFileSync(githubEnv, "utf-8"), event).toBe(
        `DATED_WAIVER_CHANGED_FILES=${changed}\n`,
      );
      return readFileSync(changed, "utf-8");
    };

    expect(listed("push", { PUSH_BEFORE: before })).toBe(
      "unrelated.ts\0waivers.ts\0",
    );
    // A pushed-from commit outside the checkout lists every tracked file.
    expect(listed("push", { PUSH_BEFORE: "0".repeat(40) })).toBe(
      "readme.md\0unrelated.ts\0waivers.ts\0",
    );
    expect(listed("pull_request", { TARGET_REF: "main" })).toBe(
      "unrelated.ts\0waivers.ts\0",
    );
    expect(listed("merge_group", { TARGET_REF: "refs/heads/main" })).toBe(
      "unrelated.ts\0waivers.ts\0",
    );
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(listed(event), event).toBe("");
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
    rmSync(runnerTemp, { force: true, recursive: true });
  }
});
