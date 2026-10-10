import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { PROBE_PHASE_BUDGET_MS } from "./dated-waiver-probes";
import { evaluate } from "./github-expression";

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
  expect(publish.env?.["STELLA_MERGE_HOLD_CHECKED_BY_WORKFLOW"]).toBe("1");
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
        "dated-waiver-expiry": v.object({
          if: v.string(),
          needs: v.optional(v.array(v.string())),
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
  const expiry = ci.jobs["dated-waiver-expiry"];
  expect(expiry.needs).toBeUndefined();
  const result = ci.jobs["ci-result"];
  expect(result.needs).toContain("dated-waiver-expiry");
  const outcome = result.steps.find(
    ({ name }) => name === "Evaluate CI outcome",
  );
  if (!outcome) {
    throw new TypeError("Missing required CI outcome step");
  }
  expect(JSON.parse(outcome.env?.["JOB_SCOPES"] ?? "{}")).toMatchObject({
    "dated-waiver-expiry": null,
  });
  expect(JSON.parse(outcome.env?.["FAST_REQUIRED"] ?? "[]")).toContain(
    "dated-waiver-expiry",
  );
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    const context = {
      values: {
        "github.event_name": event,
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
    // A heavy-only dispatch adds heavy suites to a tree whose merge group
    // already ran this thin job, so it is the one run that skips it.
    expect(
      evaluate(expiry.if, {
        ...context,
        values: { ...context.values, "inputs.heavy_only": true },
      }),
      event,
    ).toBe(false);
  }
  const install = expiry.steps.find(
    ({ name }) => name === "Install dated waiver guard dependencies",
  );
  const check = expiry.steps.find(
    ({ name }) => name === "Check dated waiver expiry on the current tree",
  );
  expect(install?.run).toContain("bun scripts/ci-install.ts");
  expect(check?.run).toBe(
    "bun --preload ./scripts/offline-network-preload.ts scripts/dated-waivers.ts --check",
  );
  for (const step of expiry.steps) {
    expect(step.env?.["GH_TOKEN"]).toBeUndefined();
    expect(step["continue-on-error"]).not.toBe(true);
  }
});
