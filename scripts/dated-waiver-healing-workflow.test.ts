import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { PROBE_PHASE_BUDGET_MS } from "./dated-waiver-probes";
import { evaluate } from "./github-expression";
import { workflowCiInstallFlags } from "./workflow-steps";

const workflow = v.parse(
  v.object({
    on: v.object({
      schedule: v.optional(v.array(v.object({ cron: v.string() }))),
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
  expect(workflow.on.schedule).toBeUndefined();
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
  const token = requiredStep("Mint app token on write path");
  const probe = requiredStep("Probe exceptions due within three days");
  const publish = requiredStep(
    "Publish proposals and request eligible automatic maintenance",
  );
  const condition = "steps.probe.outputs.write_needed == 'true'";
  expect(
    steps.indexOf(
      requiredStep("Install dependencies without write credentials"),
    ),
  ).toBeLessThan(steps.indexOf(probe));
  expect(steps.indexOf(probe)).toBeLessThan(steps.indexOf(token));
  expect(probe.env?.["GH_TOKEN"]).toBe(`\${{ github.token }}`);
  expect(token.if).toBe(condition);
  expect(publish.if).toBe(condition);
  for (const step of steps.slice(0, steps.indexOf(token))) {
    expect(JSON.stringify(step)).not.toContain("app-token.outputs.token");
  }
  expect(token.with).toMatchObject({
    "permission-contents": "write",
    "permission-pull-requests": "write",
    "permission-actions": "write",
  });
  expect(publish.env?.["MERGE_HOLD"]).toBe(`\${{ vars.STELLA_MERGE_HOLD }}`);
});

test("probe evidence stays local and public output does not expose failed probes", () => {
  const probe = requiredStep("Probe exceptions due within three days");
  const publish = requiredStep(
    "Publish proposals and request eligible automatic maintenance",
  );
  const evidenceArgument =
    '--evidence "$RUNNER_TEMP/dated-exception-radar.json"';
  expect(probe.run).toContain(`--probe ${evidenceArgument}`);
  expect(publish.run).toContain(`--publish ${evidenceArgument}`);
  expect(requiredStep("Remove runner evidence")).toMatchObject({
    if: "always()",
    run: 'rm -f "$RUNNER_TEMP/dated-exception-radar.json"',
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
    requiredStep("Probe exceptions due within three days")["timeout-minutes"],
  );
  const publishMinutes = v.parse(
    v.number(),
    requiredStep(
      "Publish proposals and request eligible automatic maintenance",
    )["timeout-minutes"],
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
    "Install dependencies without write credentials",
    "Probe exceptions due within three days",
    "Mint app token on write path",
    "Publish proposals and request eligible automatic maintenance",
  ]) {
    expect(requiredStep(name)["timeout-minutes"]).toBeGreaterThan(0);
  }
  expect(
    requiredStep("Publish proposals and request eligible automatic maintenance")
      .if,
  ).toBe("steps.probe.outputs.write_needed == 'true'");
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
    'bun scripts/dated-waiver-inventory.ts --prepare --tracked-files "$RUNNER_TEMP/dated-waiver-tracked-files"',
  );
  expect(check?.run).toBe(
    'bun --preload ./scripts/offline-network-preload.ts scripts/dated-waivers.ts --check --tracked-files "$RUNNER_TEMP/dated-waiver-tracked-files"',
  );
  for (const step of expiry.steps) {
    expect(step.env?.["GH_TOKEN"]).toBeUndefined();
    expect(step["continue-on-error"]).not.toBe(true);
  }
});

test("hourly radar shares the manual maintenance flow and checks main expiry after publishing", () => {
  const hourly = v.parse(
    v.object({
      on: v.object({ schedule: v.array(v.object({ cron: v.string() })) }),
      permissions: v.record(v.string(), v.string()),
      concurrency: v.object({
        group: v.string(),
        "cancel-in-progress": v.boolean(),
      }),
      jobs: v.object({ prune: v.object({ steps: v.array(v.unknown()) }) }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/quarantine-prune.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  expect(hourly.on.schedule).toEqual([{ cron: "17 * * * *" }]);
  expect(hourly.permissions).toEqual({});
  expect(hourly.concurrency).toEqual({
    group: "dated-exception-radar",
    "cancel-in-progress": false,
  });
  expect(hourly.jobs.prune.steps).toEqual(steps);
  const expiry = requiredStep("Check main expiry after publication");
  expect(steps.indexOf(expiry)).toBeGreaterThan(
    steps.indexOf(
      requiredStep(
        "Publish proposals and request eligible automatic maintenance",
      ),
    ),
  );
  expect(expiry.run).toContain("--prepare --tracked-files");
  expect(expiry.run).toContain("--check --tracked-files");
});
