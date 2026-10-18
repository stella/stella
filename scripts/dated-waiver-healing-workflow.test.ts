import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
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
  expect(token.with).toMatchObject({
    "permission-contents": "write",
    "permission-pull-requests": "write",
    "permission-issues": "write",
  });
  expect(token.with?.["repositories"]).toContain("DATED_WAIVER_FIX_REPOSITORY");
  expect(publish.env?.["GH_READ_TOKEN"]).toBe(`\${{ github.token }}`);
  expect(publish.env?.["MERGE_HOLD"]).toBe(`\${{ vars.STELLA_MERGE_HOLD }}`);
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
  // The guard is a part of the quick checks. The job waits for the plan but
  // its condition never reads the plan, so a failed plan still runs it.
  const expiry = ci.jobs["ci-quick-checks"];
  expect(expiry.needs).toBe("ci-plan");
  expect(expiry.if).not.toContain("needs.");
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
  });
  expect(JSON.parse(outcome.env?.["FAST_REQUIRED"] ?? "[]")).toContain(
    "ci-quick-checks",
  );
  const guardSteps = expiry.steps.filter(({ name }) =>
    name.startsWith("dated-waiver-expiry: "),
  );
  expect(guardSteps).toHaveLength(2);
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
    expect(evaluate(expiry.if, context), event).toBe(true);
    for (const step of guardSteps) {
      expect(evaluate(step.if ?? "true", context), step.name).toBe(true);
    }
    // A heavy-only dispatch adds heavy suites to a tree whose merge group
    // already ran this thin job, so it is the one run that skips it.
    expect(
      evaluate(expiry.if, {
        ...context,
        values: { ...context.values, "inputs.heavy_only": true },
      }),
      event,
    ).toBe(false);
    // An enqueued head skips it: its merge group runs it on the queued tree.
    expect(
      evaluate(expiry.if, {
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
  expect(trackedFiles?.env).toEqual({
    EVENT_NAME: `\${{ github.event_name }}`,
    PLAN_RESULT: `\${{ needs.ci-plan.result }}`,
    CHANGED_FILES_KNOWN: `\${{ needs.ci-plan.outputs.changed_files_known }}`,
    CHANGED_FILES_JSON: `\${{ needs.ci-plan.outputs.changed_files }}`,
  });
  // A pull request or merge group whose plan read its diff scopes the guard
  // to that change; every other run keeps the whole tree in scope.
  const temp = mkdtempSync(nodePath.join(tmpdir(), "dated-waiver-scope-"));
  try {
    const bin = nodePath.join(temp, "bin");
    mkdirSync(bin);
    // Records the guard's arguments instead of running it.
    writeFileSync(
      nodePath.join(bin, "bun"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/guard-args"\n',
    );
    chmodSync(nodePath.join(bin, "bun"), 0o755);
    const runStep = (run: string | undefined, env: Record<string, string>) => {
      const step = Bun.spawnSync(
        ["bash", "-e", "-o", "pipefail", "-c", run ?? ""],
        {
          env: {
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            RUNNER_TEMP: temp,
            ...env,
          },
        },
      );
      expect(step.exitCode, step.stderr.toString()).toBe(0);
    };
    const changed = JSON.stringify(["apps/api/a.ts", "docs/b c.md"]);
    for (const [env, scoped] of [
      [
        {
          EVENT_NAME: "pull_request",
          PLAN_RESULT: "success",
          CHANGED_FILES_KNOWN: "true",
        },
        true,
      ],
      [
        {
          EVENT_NAME: "merge_group",
          PLAN_RESULT: "success",
          CHANGED_FILES_KNOWN: "true",
        },
        true,
      ],
      [
        {
          EVENT_NAME: "push",
          PLAN_RESULT: "success",
          CHANGED_FILES_KNOWN: "true",
        },
        false,
      ],
      [
        {
          EVENT_NAME: "pull_request",
          PLAN_RESULT: "failure",
          CHANGED_FILES_KNOWN: "true",
        },
        false,
      ],
      [
        {
          EVENT_NAME: "pull_request",
          PLAN_RESULT: "success",
          CHANGED_FILES_KNOWN: "false",
        },
        false,
      ],
    ] as const) {
      const label = JSON.stringify(env);
      runStep(trackedFiles?.run, { ...env, CHANGED_FILES_JSON: changed });
      expect(
        readFileSync(
          nodePath.join(temp, "dated-waiver-changed-files"),
          "utf-8",
        ),
        label,
      ).toBe(scoped ? "apps/api/a.ts\0docs/b c.md\0" : "");
      expect(
        readFileSync(
          nodePath.join(temp, "dated-waiver-tracked-files"),
          "utf-8",
        ),
        label,
      ).toContain("scripts/dated-waivers.ts\0");
      runStep(check?.run, {});
      const args = readFileSync(nodePath.join(temp, "guard-args"), "utf-8")
        .trim()
        .split("\n");
      expect(args.slice(0, 5), label).toEqual([
        "--preload",
        "./scripts/offline-network-preload.ts",
        "scripts/dated-waivers.ts",
        "--check",
        "--tracked-files",
      ]);
      expect(args.includes("--changed-files"), label).toBe(scoped);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  for (const step of expiry.steps) {
    expect(step.env?.["GH_TOKEN"]).toBeUndefined();
    expect(step["continue-on-error"]).not.toBe(true);
  }
});
