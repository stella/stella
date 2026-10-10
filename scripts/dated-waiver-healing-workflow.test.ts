import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

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
        permissions: v.record(v.string(), v.string()),
        steps: v.array(
          v.looseObject({
            name: v.string(),
            id: v.optional(v.string()),
            if: v.optional(v.string()),
            uses: v.optional(v.string()),
            run: v.optional(v.string()),
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
