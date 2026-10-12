import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import { allE2eMatrix } from "./e2e-spec-shards-core";
import { evaluate } from "./github-expression";
import { lexShell } from "./install-free-ci";

const jobSchema = v.object({
  "timeout-minutes": v.number(),
  steps: v.array(
    v.object({
      name: v.string(),
      if: v.optional(v.string()),
      run: v.optional(v.string()),
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

const STARTUP_MARGIN_MS = 30_000;

test("every shard Playwright deadline exceeds its configured test timeout and startup margin", async () => {
  let checked = 0;
  for (const step of job.steps) {
    if (!step.run?.includes("setup-playwright/run-in-image.sh")) {
      continue;
    }
    for (const event of lexShell(step.run)) {
      if (event.type !== "command" || !event.words.includes("bun")) {
        continue;
      }
      const filterIndex = event.words.indexOf("--filter");
      const workspace = v.parse(v.string(), event.words.at(filterIndex + 1));
      const script = v.parse(v.string(), event.words.at(filterIndex + 2));
      const directory = path.resolve(
        import.meta.dir,
        "../apps",
        workspace.replace(/^@stll\//u, ""),
      );
      const manifest = v.parse(
        v.object({ scripts: v.record(v.string(), v.string()) }),
        JSON.parse(readFileSync(path.join(directory, "package.json"), "utf-8")),
      );
      const command = v.parse(v.string(), manifest.scripts[script]);
      const words = [...lexShell(command)].flatMap((entry) =>
        entry.type === "command" ? entry.words : [],
      );
      expect(words, step.name).toContain("playwright");
      const config = v.parse(
        v.string(),
        words.at(words.indexOf("--config") + 1),
      );
      const loaded: unknown = (await import(path.join(directory, config)))
        .default;
      const options = v.parse(
        v.object({
          timeout: v.number(),
          projects: v.optional(
            v.array(v.object({ timeout: v.optional(v.number()) })),
            [],
          ),
        }),
        loaded,
      );
      const testTimeout = Math.max(
        options.timeout,
        ...options.projects.map(
          (project) => project.timeout ?? options.timeout,
        ),
      );
      const deadline = v.parse(v.number(), step["timeout-minutes"]) * 60_000;
      expect(deadline, step.name).toBeGreaterThan(
        testTimeout + STARTUP_MARGIN_MS,
      );
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});
