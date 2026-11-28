// Derives each pooled check's wall-time budget from the durations passing CI
// runs logged for it. The budget only caps a check that keeps progressing;
// the pool stops a silent, idle check much sooner (see ci-check-pool.ts), so
// budgets are generous: legitimate variance never fails a check.
//
// Each check's peak memory is the largest peak RSS those runs measured. The
// pool admits checks by it, so concurrent checks never exceed the runner.
//
// Pull-request runs never see a release candidate's width: its PR-depth run
// checks everything since the merge base. Each check keeps the longest such
// full-range run as a record that no refresh lowers, and its budget stays
// FULL_RANGE_HEADROOM times above it (the budgets parser enforces this).
//
//   bun scripts/ci-check-budgets.ts refresh [runs]
//
// reads the pool logs of the latest passing CI runs and dispatched PR-depth
// runs (gh) and rewrites .github/ci-checks/budgets.json; a check without
// samples gets the default.
import { panic } from "better-result";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHECK_BUDGETS_PATH,
  CHECK_POOL_JOBS,
  type CheckBudget,
  type CheckPoolJob,
  FULL_RANGE_HEADROOM,
  parseCheckPool,
  readCheckBudgets,
  readWorkingTreeCheckPool,
  type TimeBudget,
} from "./ci-check-pool-registry";
import { CODE_CHECK_EXECUTION_BUDGET_MS } from "./code-check-affected";

const FLOOR_SECONDS = 5 * 60;
/** A check no passing run has measured yet. */
export const DEFAULT_BUDGET_MINUTES = 30;
/**
 * The peak memory of a check no passing run has measured yet: generous, so an
 * unmeasured heavy check shares the runner with less until it is measured.
 */
export const DEFAULT_PEAK_RSS_MIB = 4096;

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
  // Each derives capability catalogs from private revision exports, building
  // the MCP Apps first, inside per-test timeouts of their own.
  "ci-checks-rest": {
    // Its pack (480 s) and merge (600 s) tests run in one step.
    "Test CLI runtime package parity": 1200,
    "Release CLI coupling guard": 600,
    "CLI contract changeset guard": 600,
  },
};

/** max(p99 x 3, p95 x 5, 5 min, the check's own minimum), in whole minutes. */
export const checkBudget = (
  samples: readonly number[],
  minimumSeconds = 0,
): TimeBudget => {
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

/**
 * The largest measured peak, in whole MiB. A peak is a maximum, not a typical
 * value: admitting a check by less would let concurrent peaks exceed the runner.
 */
export const peakRssMiB = (samples: readonly number[]) =>
  samples.length === 0
    ? DEFAULT_PEAK_RSS_MIB
    : Math.max(1, Math.ceil(Math.max(...samples)));

// A run that calls ci.yml as a reusable workflow prefixes its jobs.
const JOB_NAME = /^(?:[\w-]+ \/ )?(?<job>[\w-]+)(?: \(\d+\))?$/u;
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

// The pool's summary table: "| Check | Result | Seconds | Peak RSS (MiB) |",
// with pipes and backslashes in a check name escaped.
const PASSED_ROW =
  /\| (?<name>(?:[^|\\]|\\.)+) \| success \| \d+(?:\.\d+)? \| (?<mib>\d+) \|$/u;
/** Peak RSS of the checks a pool job log's summary table shows as passed. */
export const passedPeaks = (log: string) =>
  log.split(/\r?\n/u).flatMap((line) => {
    const groups = PASSED_ROW.exec(line)?.groups;
    const name = groups?.["name"]?.replaceAll(/\\(.)/gu, "$1");
    const mib = Number(groups?.["mib"]);
    return name === undefined || !Number.isFinite(mib) ? [] : [{ name, mib }];
  });

/**
 * The longest full-range run, in whole seconds: the committed record or a
 * newly measured sample, whichever is longer. A refresh that sees no
 * full-range run keeps the record, so narrow samples never lower it.
 */
export const fullRangeSeconds = (
  recorded: number | undefined,
  samples: readonly number[],
) => {
  const all = recorded === undefined ? samples : [recorded, ...samples];
  return all.length === 0 ? undefined : Math.ceil(Math.max(...all));
};

/** A check's budget from its samples, minimum and full-range record. */
export const derivedBudget = ({
  samples,
  minimumSeconds = 0,
  recordedFullRangeSeconds,
  fullRangeSamples,
  peaks,
}: {
  samples: readonly number[];
  minimumSeconds?: number | undefined;
  recordedFullRangeSeconds: number | undefined;
  fullRangeSamples: readonly number[];
  peaks: readonly number[];
}): CheckBudget => {
  const fullRange = fullRangeSeconds(
    recordedFullRangeSeconds,
    fullRangeSamples,
  );
  return {
    ...checkBudget(
      samples,
      Math.max(minimumSeconds, (fullRange ?? 0) * FULL_RANGE_HEADROOM),
    ),
    ...(fullRange === undefined ? {} : { fullRangeSeconds: fullRange }),
    peakRssMiB: peakRssMiB(peaks),
  };
};

const GH_RETRY = path.resolve(import.meta.dir, "gh-retry.sh");
// Every GitHub API call goes through the retry owner.
const gh = (...args: string[]) => {
  const result = Bun.spawnSync(["bash", GH_RETRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(`gh ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

const REPOSITORY = "stella/stella";

type Samples = Map<string, number[]>;
const add = (into: Samples, key: string, value: number) =>
  into.set(key, [...(into.get(key) ?? []), value]);

/** Run ids of a workflow's latest runs matching a query. */
const runIdsOf = (workflow: string, query: string) =>
  gh(
    "api",
    `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`,
    "--jq",
    ".workflow_runs[].id",
  )
    .split("\n")
    .filter((id) => id !== "");

/** Durations and peaks of the passed checks in a run's pool jobs. */
const collect = (
  runId: string,
  conclusions: readonly string[],
  durations: Samples,
  peaks?: Samples,
) => {
  const jobs = gh(
    "api",
    `repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`,
    "--jq",
    `.jobs[] | select(.conclusion | IN(${conclusions.map((conclusion) => JSON.stringify(conclusion)).join(", ")})) | "\\(.id)\\t\\(.name)"`,
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
      add(durations, `${job}\0${name}`, seconds);
    }
    if (peaks !== undefined) {
      for (const { name, mib } of passedPeaks(log)) {
        add(peaks, `${job}\0${name}`, mib);
      }
    }
  }
};

const refresh = (runs: number) => {
  const committed = readCheckBudgets();
  const samples: Samples = new Map();
  const peaks: Samples = new Map();
  const fullRange: Samples = new Map();
  const runIds = runIdsOf("ci.yml", `status=success&per_page=${runs}`);
  for (const runId of runIds) {
    collect(runId, ["success"], samples, peaks);
  }
  // A release dispatches the PR-depth run for its candidate. A check that
  // passed there measured the full range even when another check failed.
  const fullRangeRunIds = runIdsOf(
    "main-pr-depth.yml",
    `event=workflow_dispatch&status=completed&per_page=${runs}`,
  );
  for (const runId of fullRangeRunIds) {
    collect(runId, ["success", "failure"], fullRange);
  }
  const budgets = Object.fromEntries(
    CHECK_POOL_JOBS.map((job) => [
      job,
      Object.fromEntries(
        parseCheckPool(readWorkingTreeCheckPool(job)).map(
          ({ name }): [string, CheckBudget] => {
            const key = `${job}\0${name}`;
            return [
              name,
              derivedBudget({
                samples: samples.get(key) ?? [],
                minimumSeconds: MINIMUM_BUDGET_SECONDS[job]?.[name],
                recordedFullRangeSeconds: Object.hasOwn(committed[job], name)
                  ? committed[job][name]?.fullRangeSeconds
                  : undefined,
                fullRangeSamples: fullRange.get(key) ?? [],
                peaks: peaks.get(key) ?? [],
              }),
            ];
          },
        ),
      ),
    ]),
  );
  const file = path.resolve(import.meta.dir, "..", CHECK_BUDGETS_PATH);
  writeFileSync(file, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log(
    `Budgets from ${runIds.length} passing runs and ${fullRangeRunIds.length} full-range runs written to ${CHECK_BUDGETS_PATH}`,
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
