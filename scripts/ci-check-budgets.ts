// Derives each pooled check's wall-time budget from the durations passing CI
// runs logged for it. The budget only caps a check that keeps progressing;
// the pool stops a silent, idle check much sooner (see ci-check-pool.ts), so
// budgets are generous: legitimate variance never fails a check.
//
//   bun scripts/ci-check-budgets.ts refresh [runs]
//
// reads the pool logs of the latest passing CI runs (gh) and rewrites
// .github/ci-checks/budgets.json; a check without samples gets the default.
import { panic } from "better-result";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHECK_BUDGETS_PATH,
  CHECK_POOL_JOBS,
  type CheckBudget,
  type CheckPoolJob,
  parseCheckPool,
  readWorkingTreeCheckPool,
} from "./ci-check-pool-registry";
import { CODE_CHECK_EXECUTION_BUDGET_MS } from "./code-check-affected";

const FLOOR_SECONDS = 5 * 60;
/** A check no passing run has measured yet. */
export const DEFAULT_BUDGET_MINUTES = 30;

/** Nearest-rank percentile of a non-empty sample. */
export const percentile = (samples: readonly number[], rank: number) => {
  const sorted = samples.toSorted((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? panic("percentile of an empty sample");
};

/**
 * Checks that must never stop before a limit of their own: the code-quality
 * runs warn only after their execution budget, so their cap stays above it.
 */
export const MINIMUM_BUDGET_SECONDS: Readonly<
  Partial<Record<CheckPoolJob, Readonly<Record<string, number>>>>
> = {
  "code-quality-web-rest": {
    "Code quality (web)": CODE_CHECK_EXECUTION_BUDGET_MS / 1000,
    "Code quality (rest)": CODE_CHECK_EXECUTION_BUDGET_MS / 1000,
  },
};

/** max(p99 x 3, p95 x 5, 5 min, the check's own minimum), in whole minutes. */
export const checkBudget = (
  samples: readonly number[],
  minimumSeconds = 0,
): CheckBudget => {
  if (samples.length === 0) {
    return {
      minutes: Math.max(DEFAULT_BUDGET_MINUTES, Math.ceil(minimumSeconds / 60)),
      samples: 0,
    };
  }
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const seconds = Math.max(p99 * 3, p95 * 5, FLOOR_SECONDS, minimumSeconds);
  return {
    minutes: Math.ceil(seconds / 60),
    samples: samples.length,
    p95Seconds: Math.round(p95),
    p99Seconds: Math.round(p99),
  };
};

const JOB_NAME = /^(?<job>[\w-]+)(?: \(\d+\))?$/u;
/** The pool a CI job (or one of its matrix partitions) runs, if any. */
export const poolJobOf = (jobName: string): CheckPoolJob | undefined => {
  const job = JOB_NAME.exec(jobName)?.groups?.["job"];
  return CHECK_POOL_JOBS.find((known) => known === job);
};

// The pool opens each settled check's group with its duration.
const PASSED =
  /##\[group\](?<name>.+): passed in (?<seconds>\d+(?:\.\d+)?) s$/u;
/** Durations of the checks a pool job log shows as passed. */
export const passedDurations = (log: string) =>
  log.split(/\r?\n/u).flatMap((line) => {
    const groups = PASSED.exec(line)?.groups;
    const name = groups?.["name"];
    const seconds = Number(groups?.["seconds"]);
    return name === undefined || !Number.isFinite(seconds)
      ? []
      : [{ name, seconds }];
  });

const gh = (...args: string[]) => {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(`gh ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const REPOSITORY = "stella/stella";

const refresh = (runs: number) => {
  const samples = new Map<string, number[]>();
  const runIds = gh(
    "api",
    `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?status=success&per_page=${runs}`,
    "--jq",
    ".workflow_runs[].id",
  )
    .split("\n")
    .filter((id) => id !== "");
  for (const runId of runIds) {
    const jobs = gh(
      "api",
      `repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`,
      "--jq",
      '.jobs[] | select(.conclusion == "success") | "\\(.id)\\t\\(.name)"',
    )
      .split("\n")
      .flatMap((line) => {
        const [id, name] = line.split("\t");
        const job = name === undefined ? undefined : poolJobOf(name);
        return id === undefined || job === undefined ? [] : [{ id, job }];
      });
    for (const { id, job } of jobs) {
      const log = gh(
        "api",
        "--allow-escape-sequences",
        `repos/${REPOSITORY}/actions/jobs/${id}/logs`,
      );
      for (const { name, seconds } of passedDurations(log)) {
        const key = `${job}\0${name}`;
        samples.set(key, [...(samples.get(key) ?? []), seconds]);
      }
    }
  }
  const budgets = Object.fromEntries(
    CHECK_POOL_JOBS.map((job) => [
      job,
      Object.fromEntries(
        parseCheckPool(readWorkingTreeCheckPool(job)).map(({ name }) => [
          name,
          checkBudget(
            samples.get(`${job}\0${name}`) ?? [],
            MINIMUM_BUDGET_SECONDS[job]?.[name],
          ),
        ]),
      ),
    ]),
  );
  const file = path.resolve(import.meta.dir, "..", CHECK_BUDGETS_PATH);
  writeFileSync(file, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(
    `Budgets from ${runIds.length} passing runs written to ${CHECK_BUDGETS_PATH}`,
  );
};

if (import.meta.main) {
  const [mode, runs = "40", ...extra] = process.argv.slice(2);
  const count = Number(runs);
  if (mode !== "refresh" || extra.length > 0 || !Number.isInteger(count)) {
    panic("usage: bun scripts/ci-check-budgets.ts refresh [runs]");
  }
  refresh(count);
}
