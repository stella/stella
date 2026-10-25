// The time budget of every pooled check, in one place.
//
// scripts/ci-check-budgets.json records each check's measured p95 duration
// in its own job, as the pool's summary table reports it under that job's
// real concurrency and load. A check's budget is that p95 times the safety
// factor, never below the floor; an unmeasured check (`null`) gets the
// unmeasured budget. The pool stops a check at its budget and reports a
// timeout, an infrastructure result distinct from a finding, and warns about
// a check that passed after spending the warning fraction of its budget.
//
// Refresh the measurements from downloaded logs of the pooled jobs:
//   bun scripts/ci-check-budgets.ts refresh <job log>...
//
// The pool runs before dependency installation, so this module imports no
// packages.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import ledger from "./ci-check-budgets.json" with { type: "json" };
import {
  CHECK_POOL_JOBS,
  type CheckPoolJob,
  readCheckPool,
} from "./ci-check-pool-registry";

class CheckBudgetError extends Error {
  override name = "CheckBudgetError";
  readonly _tag = "CheckBudgetError";
}

export type CheckBudgets = {
  readonly safetyFactor: number;
  readonly floorSeconds: number;
  readonly unmeasuredSeconds: number;
  readonly warnFraction: number;
  /** Per pooled job, each check's measured p95 in seconds; null: unmeasured. */
  readonly p95Seconds: ReadonlyMap<
    CheckPoolJob,
    ReadonlyMap<string, number | null>
  >;
};

export type CheckBudget = {
  /** The pool stops the check after this many seconds. */
  readonly seconds: number;
  /** The measured p95 the budget derives from; null when unmeasured. */
  readonly p95Seconds: number | null;
};

const LEDGER_KEYS = [
  "floorSeconds",
  "p95Seconds",
  "safetyFactor",
  "unmeasuredSeconds",
  "warnFraction",
];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).toSorted().join("\n") === keys.toSorted().join("\n");

export const parseCheckBudgets = (value: unknown): CheckBudgets => {
  if (!record(value) || !sameKeys(value, LEDGER_KEYS)) {
    throw new CheckBudgetError(
      `Check budgets declare exactly: ${LEDGER_KEYS.join(", ")}`,
    );
  }
  const { safetyFactor, floorSeconds, unmeasuredSeconds, warnFraction } = value;
  if (
    !positive(safetyFactor) ||
    safetyFactor < 1 ||
    !positive(floorSeconds) ||
    !positive(unmeasuredSeconds) ||
    !positive(warnFraction) ||
    warnFraction >= 1
  ) {
    throw new CheckBudgetError(
      "Check budgets need a safety factor of at least 1, positive floor and unmeasured budgets, and a warning fraction below 1",
    );
  }
  const jobs = value["p95Seconds"];
  if (!record(jobs) || !sameKeys(jobs, CHECK_POOL_JOBS)) {
    throw new CheckBudgetError(
      `Check budgets measure exactly the pooled jobs: ${CHECK_POOL_JOBS.join(", ")}`,
    );
  }
  const p95Seconds = new Map(
    CHECK_POOL_JOBS.map((job) => {
      const checks = jobs[job];
      if (!record(checks)) {
        throw new CheckBudgetError(`${job}: p95 seconds must be a mapping`);
      }
      return [
        job,
        new Map(
          Object.entries(checks).map(([name, seconds]) => {
            if (seconds !== null && !positive(seconds)) {
              throw new CheckBudgetError(
                `${job}: "${name}" p95 must be a positive number of seconds or null`,
              );
            }
            return [name, seconds];
          }),
        ),
      ];
    }),
  );
  return {
    safetyFactor,
    floorSeconds,
    unmeasuredSeconds,
    warnFraction,
    p95Seconds,
  };
};

/** The ledger as scripts/ci-check-budgets.json stores it. */
export const serializeCheckBudgets = (budgets: CheckBudgets) =>
  `${JSON.stringify(
    {
      safetyFactor: budgets.safetyFactor,
      floorSeconds: budgets.floorSeconds,
      unmeasuredSeconds: budgets.unmeasuredSeconds,
      warnFraction: budgets.warnFraction,
      p95Seconds: Object.fromEntries(
        CHECK_POOL_JOBS.map((job) => [
          job,
          Object.fromEntries(budgets.p95Seconds.get(job) ?? []),
        ]),
      ),
    },
    null,
    2,
  )}\n`;

export const CHECK_BUDGETS = parseCheckBudgets(ledger);

/**
 * The budget of one pooled check. A declared `timeout-minutes` (the step
 * deadline the network-step policy reads) caps it; a test keeps every
 * measured budget within its declared deadline.
 */
export const checkBudget = (
  job: CheckPoolJob,
  name: string,
  timeoutMinutes: number | undefined,
  budgets: CheckBudgets = CHECK_BUDGETS,
): CheckBudget => {
  const p95Seconds = budgets.p95Seconds.get(job)?.get(name);
  if (p95Seconds === undefined) {
    throw new CheckBudgetError(
      `${job}: "${name}" has no entry in scripts/ci-check-budgets.json; add its measured p95 in seconds, or null until it is measured`,
    );
  }
  const derived =
    p95Seconds === null
      ? budgets.unmeasuredSeconds
      : Math.max(
          budgets.floorSeconds,
          Math.ceil(p95Seconds * budgets.safetyFactor),
        );
  return {
    seconds:
      timeoutMinutes === undefined
        ? derived
        : Math.min(derived, timeoutMinutes * 60),
    p95Seconds,
  };
};

/** A passing check that spent enough of its budget to warn about. */
export const nearBudget = (
  seconds: number,
  budget: CheckBudget,
  budgets: CheckBudgets = CHECK_BUDGETS,
) => seconds >= budget.seconds * budgets.warnFraction;

/** What a budget derives from, for timeout and warning messages. */
export const budgetBasis = (budget: CheckBudget) =>
  budget.p95Seconds === null
    ? `budget ${budget.seconds} s, unmeasured`
    : `budget ${budget.seconds} s from p95 ${budget.p95Seconds} s`;

// ---------------------------------------------------------------------------
// Refresh from job logs

const POOL_HEADER =
  /^([\w-]+): \d+ of \d+ checks selected; running \d+ at a time$/u;
const TABLE_HEADER = "| Check | Result | Seconds |";
// A downloaded job log line starts with its timestamp.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /u;

/**
 * Each pooled check's durations in the given job logs: the pool's opening
 * line names the job, its summary table the checks. A skipped check has no
 * duration; a check stopped at its budget counts as observed, a lower bound.
 */
export const durationsFromLogs = (
  logs: readonly string[],
): Map<CheckPoolJob, Map<string, number[]>> => {
  const durations = new Map<CheckPoolJob, Map<string, number[]>>();
  for (const log of logs) {
    let job: CheckPoolJob | undefined;
    let inTable = false;
    for (const raw of log.split(/\r?\n/u)) {
      const line = raw.replace(TIMESTAMP, "");
      const pool = POOL_HEADER.exec(line)?.[1];
      const known = CHECK_POOL_JOBS.find((candidate) => candidate === pool);
      if (known !== undefined) {
        job = known;
        inTable = false;
        continue;
      }
      if (line.startsWith(TABLE_HEADER)) {
        inTable = job !== undefined;
        continue;
      }
      if (!inTable || job === undefined) {
        continue;
      }
      if (!line.startsWith("| ")) {
        inTable = false;
        continue;
      }
      // An escaped pipe stays inside its cell.
      const [name, , seconds] = line
        .slice(2, -2)
        .split(/(?<!\\) \| /u)
        .map((cell) => cell.replaceAll("\\|", "|").replaceAll("\\\\", "\\"));
      if (name === undefined || name === "---" || !seconds) {
        continue;
      }
      const checks = durations.get(job) ?? new Map<string, number[]>();
      durations.set(job, checks);
      checks.set(name, [...(checks.get(name) ?? []), Number(seconds)]);
    }
  }
  return durations;
};

/** The nearest-rank p95, rounded up to a tenth of a second. */
export const p95 = (values: readonly number[]) => {
  const sorted = values.toSorted((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * 0.95));
  return Math.max(0.1, Math.ceil((sorted[rank - 1] ?? 0) * 10) / 10);
};

/**
 * The ledger with every check the logs measured set to its p95. A check the
 * logs never ran keeps its recorded value; a check its registry no longer
 * declares is dropped, and a new one starts unmeasured.
 */
export const refreshedBudgets = (
  budgets: CheckBudgets,
  durations: ReadonlyMap<CheckPoolJob, ReadonlyMap<string, readonly number[]>>,
  declared: ReadonlyMap<CheckPoolJob, readonly string[]>,
): CheckBudgets => ({
  ...budgets,
  p95Seconds: new Map(
    CHECK_POOL_JOBS.map((job) => [
      job,
      new Map(
        (declared.get(job) ?? []).map((name) => {
          const measured = durations.get(job)?.get(name) ?? [];
          return [
            name,
            measured.length === 0
              ? (budgets.p95Seconds.get(job)?.get(name) ?? null)
              : p95(measured),
          ];
        }),
      ),
    ]),
  ),
});

if (import.meta.main) {
  const [mode, ...logs] = process.argv.slice(2);
  if (mode !== "refresh" || logs.length === 0) {
    throw new CheckBudgetError(
      "Usage: bun scripts/ci-check-budgets.ts refresh <job log>...",
    );
  }
  const declared = new Map(
    CHECK_POOL_JOBS.map((job) => [
      job,
      readCheckPool(job).map(({ name }) => name),
    ]),
  );
  const durations = durationsFromLogs(
    logs.map((file) => readFileSync(file, "utf-8")),
  );
  const ledgerPath = path.join(import.meta.dir, "ci-check-budgets.json");
  writeFileSync(
    ledgerPath,
    serializeCheckBudgets(refreshedBudgets(CHECK_BUDGETS, durations, declared)),
  );
  const samples = [...durations.values()]
    .flatMap((checks) => [...checks.values()])
    .reduce((total, values) => total + values.length, 0);
  console.log(
    `Refreshed scripts/ci-check-budgets.json from ${logs.length} log(s), ${samples} check durations`,
  );
}
