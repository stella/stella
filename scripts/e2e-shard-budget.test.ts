import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { createSha256 } from "@stll/sha256/node";

import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };
import {
  measuredShardBudget,
  shardBudgetViolation,
} from "./e2e-shard-deadline";
import { allE2eMatrix, E2E_SHARD_COUNT } from "./e2e-spec-shards-core";
import { evaluate } from "./github-expression";
import { lexShell } from "./install-free-ci";

const jobSchema = v.object({
  "timeout-minutes": v.number(),
  steps: v.array(
    v.object({
      name: v.string(),
      if: v.optional(v.string()),
      run: v.optional(v.string()),
      uses: v.optional(v.string()),
      with: v.optional(
        v.object({ "installer-budget-ms": v.optional(v.string()) }),
      ),
      "timeout-minutes": v.optional(v.union([v.number(), v.string()])),
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

const deadlineMinutes = (deadline: number | string, shard: number | string) =>
  typeof deadline === "number"
    ? deadline
    : v.parse(
        v.number(),
        evaluate(deadline, {
          values: {
            "steps.e2e-budget.outputs.minutes": String(
              typeof shard === "number"
                ? measuredShardBudget(shard).minutes
                : 1,
            ),
          },
        }),
      );

const budgetViolations = (candidate: typeof job) => {
  const restoreHeadroomMs = 30_000;
  const violations: string[] = [];
  const isInstall = (step: (typeof candidate.steps)[number]) =>
    step.uses === "$/.github/actions/ci-install" ||
    step.uses === "./.github/actions/ci-install";
  if (candidate.steps.filter(isInstall).length !== 1) {
    violations.push("production shards need exactly one scoped install owner");
  }
  for (const shard of candidate.strategy.matrix.shard) {
    let total = 0;
    for (const step of candidate.steps) {
      // Cancellation and runner post hooks share the two-minute job margin.
      if (step.name === CANONICAL_CANCEL_STEP.name) {
        continue;
      }
      const deadline = step["timeout-minutes"];
      let allocation: number;
      if (isInstall(step)) {
        if (deadline !== undefined) {
          violations.push(`${step.name} must use only the job deadline`);
        }
        const budget = Number(step.with?.["installer-budget-ms"]);
        if (!Number.isSafeInteger(budget) || budget <= 0) {
          violations.push(`${step.name} needs a positive warning allowance`);
          continue;
        }
        // Reserve the warning allowance inside the outer job budget; a
        // progressing install may use remaining job time beyond this allowance.
        allocation = Math.ceil((budget + restoreHeadroomMs) / 60_000);
      } else if (
        deadline === undefined ||
        deadlineMinutes(deadline, shard) <= 0
      ) {
        violations.push(`${step.name} needs an independent deadline`);
        continue;
      } else {
        allocation = deadlineMinutes(deadline, shard);
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
                "steps.e2e-stack.outcome": "success",
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
        total += allocation;
      }
    }
    if (candidate["timeout-minutes"] < total + 2) {
      violations.push(`shard ${shard} loses phase budget or cleanup margin`);
    }
  }
  return violations;
};

test("every production shard reserves install warning time, phase deadlines and cleanup inside its job", () => {
  expect(budgetViolations(job)).toEqual([]);
});

test("the shard budget guard rejects install deadlines, missing install allowances and unbounded phases", () => {
  expect(
    budgetViolations({ ...job, "timeout-minutes": 12 }).length,
  ).toBeGreaterThan(0);
  for (const step of job.steps) {
    if (step.name === CANONICAL_CANCEL_STEP.name) {
      continue;
    }
    if (
      step.uses === "$/.github/actions/ci-install" ||
      step.uses === "./.github/actions/ci-install"
    ) {
      expect(
        budgetViolations({
          ...job,
          steps: job.steps.map((entry) =>
            entry === step ? { ...entry, "timeout-minutes": 2 } : entry,
          ),
        }),
      ).toContain(`${step.name} must use only the job deadline`);
      expect(
        budgetViolations({
          ...job,
          steps: job.steps.map((entry) =>
            entry === step ? { ...entry, with: undefined } : entry,
          ),
        }),
      ).toContain(`${step.name} needs a positive warning allowance`);
      expect(
        budgetViolations({
          ...job,
          steps: job.steps.filter((entry) => entry !== step),
        }),
      ).toContain("production shards need exactly one scoped install owner");
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
      if (filterIndex === -1) {
        continue;
      }
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
      const deadline =
        deadlineMinutes(
          v.parse(v.union([v.number(), v.string()]), step["timeout-minutes"]),
          1,
        ) * 60_000;
      expect(deadline, step.name).toBeGreaterThan(
        testTimeout + STARTUP_MARGIN_MS,
      );
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test("every shard inherits a measured parent budget with the sparse-sample margin", () => {
  expect(
    [
      ...new Set(
        configuredBudgets.e2eProductionShards.samples.map(({ shard }) => shard),
      ),
    ].toSorted((left, right) => left - right),
  ).toEqual([1, 2]);
  const step = job.steps.find(({ name }) => name === "Run Playwright shard");
  expect(step?.["timeout-minutes"]).toBe(
    `\${{ fromJSON(steps.e2e-budget.outputs.minutes) }}`,
  );
  for (let shard = 1; shard <= E2E_SHARD_COUNT; shard++) {
    const budget = measuredShardBudget(shard);
    const samples = configuredBudgets.e2eProductionShards.samples.filter(
      (sample) => sample.shard === Math.ceil(shard / 2),
    );
    expect(budget.seconds).toBeGreaterThanOrEqual(budget.p95 * 1.5);
    for (const sample of samples) {
      expect(budget.seconds).toBeGreaterThanOrEqual(sample.seconds * 2);
    }
    expect(budget.minutes * 60).toBeGreaterThanOrEqual(budget.seconds + 30);
    expect(shardBudgetViolation(shard, budget.seconds)).toBeUndefined();
    expect(shardBudgetViolation(shard, budget.seconds + 1)).toContain(
      "exceeding its measured",
    );
  }
});

test("changing the measured shard split requires fresh wall-time evidence", () => {
  const run = v.parse(
    v.string(),
    job.steps.find(({ name }) => name === "Run Playwright shard")?.run,
  );
  const fingerprint = (command: string) => {
    const hash = createSha256().update(command);
    for (const file of configuredBudgets.e2eProductionShards.planFiles) {
      hash.update(readFileSync(new URL(`../${file}`, import.meta.url)));
    }
    return hash.digest("hex");
  };
  expect(
    fingerprint(run),
    "Remeasure the current split before updating its fingerprint",
  ).toBe(configuredBudgets.e2eProductionShards.planSha256);
  // The shard total comes from the matrix planner's step output: changing it
  // must change the fingerprint.
  const shardTotal = `/\${{ steps.e2e-shards.outputs.count }}`;
  expect(run).toContain(shardTotal);
  expect(fingerprint(run.replaceAll(shardTotal, "/5"))).not.toBe(
    configuredBudgets.e2eProductionShards.planSha256,
  );
  expect(run).toContain(
    `bun --preload ./scripts/offline-network-preload.ts scripts/e2e-shard-deadline.ts --check \${{ matrix.shard }} "$SECONDS"`,
  );
  expect(run).toContain("SECONDS=0");
});

test("the workflow publishes computed deadlines and an over-budget shard fails with an annotation", () => {
  const budgetStep = v.parse(
    v.string(),
    job.steps.find(({ name }) => name === "Resolve e2e shard budget")?.run,
  );
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), "e2e-budget-output-"),
  );
  const output = path.join(outputDirectory, "github-output");
  try {
    for (const shard of allE2eMatrix().shard) {
      writeFileSync(output, "");
      const result = Bun.spawnSync(
        [
          "bash",
          "-euc",
          budgetStep.replaceAll(`\${{ matrix.shard }}`, () => String(shard)),
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: { ...process.env, GITHUB_OUTPUT: output },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf-8").trim()).toBe(
        `minutes=${typeof shard === "number" ? measuredShardBudget(shard).minutes : 1}`,
      );
    }
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
  const result = Bun.spawnSync([
    process.execPath,
    path.join(import.meta.dir, "e2e-shard-deadline.ts"),
    "--check",
    "2",
    String(measuredShardBudget(2).seconds + 1),
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("::error::Shard 2");
  expect(result.stderr.toString()).toContain("exceeding its measured");
});
