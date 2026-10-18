// Runs the checks of one CI job in a bounded process pool.
//
// Each check in .github/ci-checks/<job>.yml keeps the fields of the workflow
// step it replaced. The pool evaluates every condition against the job's own
// context (event, `needs`, earlier step outcomes and outputs), so selection by
// changed inputs and static-receipt reuse behave exactly as they did per step.
// Selected checks run concurrently, one fewer than the runner CPUs; each log is
// printed whole, in registry order, and every failure is annotated. Any failed
// check fails the step after all selected checks have finished, unless its
// `continue-on-error` holds: then, as for a step, the failure is reported as a
// warning and its conclusion is success.
//
// The pool runs even when dependency installation failed (install-free checks
// still run), so it imports no packages.
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import {
  CHECK_POOL_JOBS,
  checkPoolResultsPath,
  readCheckPool,
  type CheckPoolJob,
  type PoolCheck,
} from "./ci-check-pool-registry";
import {
  evaluate,
  toValue,
  UNKNOWN,
  type Context,
  type Value,
} from "./github-expression";

class CheckPoolError extends Error {
  override name = "CheckPoolError";
  readonly _tag = "CheckPoolError";
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (source: string | undefined, label: string): Value => {
  if (source === undefined || source === "") {
    throw new CheckPoolError(`Missing ${label}`);
  }
  const parsed: unknown = JSON.parse(source);
  return toValue(parsed);
};

/**
 * The workflow contexts a pooled expression may read. The pool step hands
 * each one over (CI_CHECK_POOL_<ROOT>); any other root is unknown, and a
 * census test keeps every pooled expression within these.
 */
export const POOL_CONTEXT_ROOTS = [
  "github",
  "needs",
  "steps",
  "inputs",
] as const;
type PoolContextOptions = {
  github: Record<string, Value>;
  needs: Value;
  steps: Value;
  /** `null` outside workflow_dispatch and workflow_call, as GitHub renders it. */
  inputs: Value;
};
/**
 * GitHub's context for a step in this job. A missing property reads as null,
 * as it does in a workflow expression; status functions other than
 * `cancelled()` are unknown, so a condition that needs them fails loudly.
 */
export const poolContext = ({
  github,
  needs,
  steps,
  inputs,
}: PoolContextOptions): Context => {
  const roots = new Map<string, Value>([
    ["github", github],
    ["needs", needs],
    ["steps", steps],
    ["inputs", inputs],
  ]);
  return {
    values: {},
    status: { cancelled: false },
    fallback: (reference) => {
      const [root, ...parts] = reference.split(".");
      if (root === undefined || !roots.has(root)) {
        return undefined;
      }
      let value: unknown = roots.get(root);
      for (const part of parts) {
        value =
          record(value) && Object.hasOwn(value, part) ? value[part] : null;
      }
      return toValue(value ?? null);
    },
  };
};

const truthy = (value: Value) =>
  !(
    value === false ||
    value === null ||
    value === 0 ||
    value === "" ||
    Number.isNaN(value)
  );

export const conditionHolds = (condition: string, context: Context) => {
  const value = evaluate(condition, context);
  if (value === UNKNOWN) {
    throw new CheckPoolError(`Condition is not decidable: ${condition}`);
  }
  return truthy(value);
};

/**
 * Whether a failure of this check may let the pool pass, as `continue-on-error`
 * does for a step. An expression the pool cannot decide fails closed: the
 * check stays blocking.
 */
export const continueOnErrorHolds = (
  declared: PoolCheck["continueOnError"],
  context: Context,
) => {
  if (declared === undefined || typeof declared === "boolean") {
    return declared === true;
  }
  try {
    const value = evaluate(declared, context);
    return value !== UNKNOWN && truthy(value);
  } catch {
    return false;
  }
};

const EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/u;
/** Resolve `${{ }}` env values the way the runner renders them into a step. */
export const resolveEnv = (
  env: Readonly<Record<string, string>>,
  context: Context,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, source]) => {
      const expression = EXPRESSION.exec(source.trim())?.[1];
      if (expression === undefined) {
        if (source.includes("${{")) {
          throw new CheckPoolError(`${key}: embedded expressions unsupported`);
        }
        return [key, source];
      }
      const value = evaluate(expression, context);
      if (value === UNKNOWN) {
        throw new CheckPoolError(`${key}: value is not decidable`);
      }
      if (value === null) {
        return [key, ""];
      }
      return [
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      ];
    }),
  );

export type PlannedCheck =
  | {
      check: PoolCheck;
      status: "selected";
      env: Record<string, string>;
      continueOnError: boolean;
    }
  | { check: PoolCheck; status: "skipped" }
  | { check: PoolCheck; status: "invalid"; message: string };

export const planChecks = (
  checks: readonly PoolCheck[],
  context: Context,
): PlannedCheck[] =>
  checks.map((check) => {
    try {
      return conditionHolds(check.condition, context)
        ? {
            check,
            status: "selected",
            env: resolveEnv(check.env, context),
            continueOnError: continueOnErrorHolds(
              check.continueOnError,
              context,
            ),
          }
        : { check, status: "skipped" };
    } catch (error) {
      return {
        check,
        status: "invalid",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

export type Launched = {
  exitCode: number;
  timedOut: boolean;
  maxRssBytes: number | undefined;
};
export type CheckResult = {
  name: string;
  id: string | undefined;
  outcome: "success" | "failure" | "skipped";
  /** A failure that `continue-on-error` lets pass: conclusion success. */
  continuedOnError: boolean;
  detail: string;
  seconds: number;
  maxRssBytes: number | undefined;
};

const launchedOutcome = (
  launched: Launched,
  check: PoolCheck,
): Pick<CheckResult, "outcome" | "detail"> => {
  if (launched.timedOut) {
    return {
      outcome: "failure",
      detail: `timed out after ${check.timeoutMinutes ?? 0} min`,
    };
  }
  return launched.exitCode === 0
    ? { outcome: "success", detail: "passed" }
    : { outcome: "failure", detail: `exit code ${launched.exitCode}` };
};

type RunChecksOptions = {
  planned: readonly PlannedCheck[];
  concurrency: number;
  launch: (
    index: number,
    check: PoolCheck,
    env: Record<string, string>,
  ) => Promise<Launched>;
  /** Called once per check, in registry order, as soon as it can be. */
  report: (index: number, result: CheckResult) => void;
  now?: () => number;
};

/**
 * Run selected checks with at most `concurrency` in flight, in registry
 * order. A failure never stops other checks; results come back in order.
 */
export const runChecks = async ({
  planned,
  concurrency,
  launch,
  report,
  now = () => performance.now(),
}: RunChecksOptions): Promise<CheckResult[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new CheckPoolError(`Invalid concurrency: ${concurrency}`);
  }
  const results: (CheckResult | undefined)[] = planned.map(() => undefined);
  let reported = 0;
  const settle = (index: number, result: CheckResult) => {
    results[index] = result;
    for (
      let next = results[reported];
      next !== undefined;
      next = results[reported]
    ) {
      report(reported, next);
      reported += 1;
    }
  };
  const queue = planned.flatMap((entry, index) => {
    const base = {
      name: entry.check.name,
      id: entry.check.id,
      continuedOnError: false,
      seconds: 0,
      maxRssBytes: undefined,
    };
    if (entry.status === "skipped") {
      settle(index, { ...base, outcome: "skipped", detail: "condition false" });
      return [];
    }
    if (entry.status === "invalid") {
      settle(index, { ...base, outcome: "failure", detail: entry.message });
      return [];
    }
    return [
      {
        index,
        check: entry.check,
        env: entry.env,
        continueOnError: entry.continueOnError,
      },
    ];
  });
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const started = now();
      const base = { name: item.check.name, id: item.check.id };
      try {
        const launched = await launch(item.index, item.check, item.env);
        const seconds = (now() - started) / 1000;
        const outcome = launchedOutcome(launched, item.check);
        settle(item.index, {
          ...base,
          seconds,
          maxRssBytes: launched.maxRssBytes,
          ...outcome,
          continuedOnError:
            item.continueOnError && outcome.outcome === "failure",
        });
      } catch (error) {
        settle(item.index, {
          ...base,
          seconds: (now() - started) / 1000,
          maxRssBytes: undefined,
          outcome: "failure",
          continuedOnError: item.continueOnError,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return results.map((result, index) => {
    if (result === undefined) {
      throw new CheckPoolError(
        `Check did not settle: ${planned[index]?.check.name ?? String(index)}`,
      );
    }
    return result;
  });
};

const POOL_ENV = [
  "CI_CHECK_POOL_NEEDS",
  "CI_CHECK_POOL_STEPS",
  "CI_CHECK_POOL_INPUTS",
  "CI_CHECK_POOL_TOKEN",
];
const active = new Set<number>();
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
};

type ProcessLauncherOptions = { root: string; directory: string };
/** Run a check's script the way a `shell: bash` step does, in its own group. */
export const processLauncher =
  ({ root, directory }: ProcessLauncherOptions) =>
  async (
    index: number,
    check: PoolCheck,
    env: Record<string, string>,
  ): Promise<Launched> => {
    const script = path.join(directory, `${String(index).padStart(3, "0")}.sh`);
    writeFileSync(script, check.run);
    const log = openSync(logPath(directory, index), "w");
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !POOL_ENV.includes(key)),
    );
    const child = Bun.spawn(
      ["bash", "--noprofile", "--norc", "-eo", "pipefail", script],
      {
        cwd: root,
        env: { ...inherited, ...env },
        stdin: "ignore",
        stdout: log,
        stderr: log,
        detached: true,
      },
    );
    active.add(child.pid);
    let timedOut = false;
    const timer =
      check.timeoutMinutes === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
          }, check.timeoutMinutes * 60_000);
    const exitCode = await child.exited;
    clearTimeout(timer);
    // Nothing a check starts may outlive it and contend with the next one.
    killGroup(child.pid);
    active.delete(child.pid);
    closeSync(log);
    const usage = child.resourceUsage();
    return {
      exitCode,
      timedOut,
      maxRssBytes: usage?.maxRSS,
    };
  };

const logPath = (directory: string, index: number) =>
  path.join(directory, `${String(index).padStart(3, "0")}.log`);

// A nested group would end the check's own group in the job log.
const NESTED_GROUP = /^(::(?:end)?group::|##\[(?:end)?group\])/gmu;
const escapeProperty = (value: string) =>
  value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
const escapeData = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const seconds = (value: number) => `${value.toFixed(1)} s`;
const mebibytes = (bytes: number | undefined) =>
  bytes === undefined ? "" : String(Math.round(bytes / 1_048_576));

// Markdown table cell: a pipe would end the cell and a line break the row.
const cell = (value: string) =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/gu, " ");

export const summaryTable = (results: readonly CheckResult[]) =>
  [
    "| Check | Result | Seconds | Peak RSS (MiB) |",
    "| --- | --- | ---: | ---: |",
    ...results.map((result) => {
      const failure = result.continuedOnError
        ? "failure (continue-on-error)"
        : "failure";
      const outcome =
        result.outcome === "failure"
          ? `${failure}: ${result.detail}`
          : result.outcome;
      const elapsed =
        result.outcome === "skipped" ? "" : result.seconds.toFixed(1);
      return `| ${cell(result.name)} | ${cell(outcome)} | ${elapsed} | ${mebibytes(result.maxRssBytes)} |`;
    }),
  ].join("\n");

// One synchronous writer: a large asynchronous stdout write could otherwise
// interleave with the next check's lines.
const pause = new Int32Array(new SharedArrayBuffer(4));
const writeOut = (text: string) => {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (error) {
      // A non-blocking pipe that is full: wait briefly and retry.
      if (
        !(error instanceof Error && "code" in error && error.code === "EAGAIN")
      ) {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};
const print = (...parts: string[]) => {
  writeOut(`${parts.join(" ")}\n`);
};

/** Failures that fail the pool step: those `continue-on-error` does not cover. */
export const blockingFailures = (results: readonly CheckResult[]) =>
  results.filter(
    ({ outcome, continuedOnError }) =>
      outcome === "failure" && !continuedOnError,
  );

const isPoolJob = (job: string): job is CheckPoolJob =>
  CHECK_POOL_JOBS.some((known) => known === job);

const main = async () => {
  const [mode, job = ""] = process.argv.slice(2);
  if (mode !== "run" || !isPoolJob(job)) {
    throw new CheckPoolError(
      `Usage: bun scripts/ci-check-pool.ts run ${CHECK_POOL_JOBS.join("|")}`,
    );
  }
  const root = path.resolve(import.meta.dir, "..");
  const runnerTemp = process.env["RUNNER_TEMP"] ?? path.join(root, ".cache");
  const resultsPath = checkPoolResultsPath(job, runnerTemp);
  const directory = path.dirname(resultsPath);
  mkdirSync(directory, { recursive: true });
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const github: Record<string, Value> = {
    event_name: process.env["GITHUB_EVENT_NAME"] ?? "",
    base_ref: process.env["GITHUB_BASE_REF"] ?? "",
    head_ref: process.env["GITHUB_HEAD_REF"] ?? "",
    ref: process.env["GITHUB_REF"] ?? "",
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    workspace: process.env["GITHUB_WORKSPACE"] ?? root,
    token: process.env["CI_CHECK_POOL_TOKEN"] ?? "",
    event: eventPath ? json(readFileSync(eventPath, "utf-8"), "event") : {},
  };
  const context = poolContext({
    github,
    needs: json(process.env["CI_CHECK_POOL_NEEDS"], "needs context"),
    steps: json(process.env["CI_CHECK_POOL_STEPS"], "steps context"),
    inputs: json(process.env["CI_CHECK_POOL_INPUTS"], "inputs context"),
  });
  const planned = planChecks(readCheckPool(job), context);
  const override = process.env["CI_CHECK_POOL_CONCURRENCY"];
  // One check per CPU but one: four concurrent checks on a four-CPU runner
  // pushed default 5 s Bun test budgets past their limit; three did not.
  const concurrency = override
    ? Number(override)
    : Math.max(1, availableParallelism() - 1);
  const selected = planned.filter(({ status }) => status === "selected").length;
  print(
    `${job}: ${selected} of ${planned.length} checks selected; running ${Math.min(concurrency, selected)} at a time`,
  );
  const stop = () => {
    for (const pid of active) {
      killGroup(pid);
    }
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const started = performance.now();
  const results = await runChecks({
    planned,
    concurrency,
    launch: processLauncher({ root, directory }),
    report: (index, result) => {
      if (result.outcome === "skipped") {
        print(`Skipped: ${result.name} (${result.detail})`);
        return;
      }
      let label = "passed";
      if (result.outcome === "failure") {
        label = result.continuedOnError
          ? "FAILED (continue-on-error)"
          : "FAILED";
      }
      print(`::group::${result.name}: ${label} in ${seconds(result.seconds)}`);
      if (planned[index]?.status === "selected") {
        const output = readFileSync(logPath(directory, index), "utf-8");
        const text = output.replace(NESTED_GROUP, " $1");
        writeOut(text === "" || text.endsWith("\n") ? text : `${text}\n`);
      }
      print("::endgroup::");
      if (result.outcome === "failure") {
        const level = result.continuedOnError ? "warning" : "error";
        const suffix = result.continuedOnError ? " (continue-on-error)" : "";
        print(
          `::${level} title=${escapeProperty(result.name)}::${escapeData(`${result.name} failed${suffix}: ${result.detail}`)}`,
        );
      }
    },
  });
  const table = summaryTable(results);
  print(
    `\n${table}\n\nWall time: ${seconds((performance.now() - started) / 1000)}`,
  );
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    appendFileSync(summary, `### ${job} checks\n\n${table}\n\n`);
  }
  writeFileSync(
    resultsPath,
    JSON.stringify(
      Object.fromEntries(
        results.flatMap(({ id, outcome, continuedOnError }) =>
          id === undefined
            ? []
            : [
                [
                  id,
                  {
                    outcome,
                    conclusion: continuedOnError ? "success" : outcome,
                  },
                ],
              ],
        ),
      ),
    ),
  );
  const failed = blockingFailures(results);
  if (failed.length > 0) {
    print(
      `${failed.length} check(s) failed: ${failed.map(({ name }) => name).join("; ")}`,
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
