import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import { allE2eMatrix } from "./e2e-spec-shards-core";
import { evaluate } from "./github-expression";

const jobSchema = v.object({
  "timeout-minutes": v.number(),
  steps: v.array(
    v.object({
      name: v.string(),
      if: v.optional(v.string()),
      "timeout-minutes": v.optional(v.number()),
    }),
  ),
});
const workflow = v.parse(
  v.object({ jobs: v.object({ "e2e-production-shard": v.unknown() }) }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const parsedJob = v.parse(jobSchema, workflow.jobs["e2e-production-shard"]);
const job = {
  "timeout-minutes": parsedJob["timeout-minutes"],
  strategy: { matrix: allE2eMatrix() },
  steps: parsedJob.steps,
};

const budgetViolations = (candidate: typeof job) => {
  const violations: string[] = [];
  for (const shard of candidate.strategy.matrix.shard) {
    let total = 0;
    for (const step of candidate.steps) {
      // Cancellation and runner post hooks share the two-minute job margin.
      if (step.name === CANONICAL_CANCEL_STEP.name) {
        continue;
      }
      const deadline = step["timeout-minutes"];
      if (deadline === undefined || deadline <= 0) {
        violations.push(`${step.name} needs an independent deadline`);
        continue;
      }
      const active =
        step.if === undefined
          ? true
          : evaluate(step.if, {
              values: {
                "github.event_name": "merge_group",
                "github.event.pull_request.head.repo.fork": false,
                "github.token": "test-token",
                "matrix.shard": shard,
                "steps.e2e-stack.outputs.status": "ready",
              },
              // Include failure-only uploads as well as tests for a conservative cap.
              status: {
                always: true,
                cancelled: false,
                failure: true,
                success: true,
              },
            });
      expect(typeof active, step.name).toBe("boolean");
      if (active === true) {
        total += deadline;
      }
    }
    if (candidate["timeout-minutes"] < total + 2) {
      violations.push(`shard ${shard} loses phase budget or cleanup margin`);
    }
  }
  return violations;
};

test("every production shard retains independent phase deadlines and cleanup time", () => {
  expect(budgetViolations(job)).toEqual([]);
});

test("the shard budget guard rejects a shared deadline and any unbounded phase", () => {
  expect(
    budgetViolations({ ...job, "timeout-minutes": 12 }).length,
  ).toBeGreaterThan(0);
  for (const step of job.steps) {
    if (step.name === CANONICAL_CANCEL_STEP.name) {
      continue;
    }
    const unbounded = {
      ...job,
      steps: job.steps.map((entry) =>
        entry === step ? { name: entry.name, if: entry.if } : entry,
      ),
    };
    expect(budgetViolations(unbounded)).toContain(
      `${step.name} needs an independent deadline`,
    );
  }
});
