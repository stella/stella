import { panic, Result, TaggedError } from "better-result";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import apiManifest from "../apps/api/package.json" with { type: "json" };
import { isDbTest } from "../apps/api/scripts/test-batch-plan";
import { selectTestPaths } from "../apps/api/scripts/test-path-filters";
import { analyzeModule, selectApiTestImpact } from "./api-test-impact";
import { testFailures } from "./ci-failure-digest";
import { parseBunTestScript } from "./flake-gate-command";
import {
  cleanupCapability,
  type FlakeCleanup,
  type FlakeProcessOutcome,
  runFlakeProcess,
} from "./flake-gate-process";
import {
  createRustTestListing,
  rustExactCommand,
  rustListCommand,
  type RustTarget,
  selectRustTargets,
} from "./flake-gate-rust";
import {
  encodePlanFileList,
  encodePostgresTestSelection,
} from "./plan-output-codec";

export const REPEATS = 5;
export const MAX_CHANGED_TEST_FILES = 10;
export const BUDGET_MS = 5 * 60 * 1000;
const root = path.resolve(import.meta.dir, "..");
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const manifestSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
});

class FlakeGateError extends TaggedError("FlakeGateError")<{
  message: string;
}> {}

type TrialTarget = {
  file: string;
  cwd: string;
  env: Record<string, string>;
};
export type Target =
  | (TrialTarget & { runner: "bun" | "api" | "web"; command: string[] })
  | (TrialTarget & RustTarget & { runner: "rust" });
export type Skipped = { file: string; reason: string };
type SelectOptions = {
  root: string;
  changed: readonly string[];
  hasDb: boolean;
  apiImpact?: typeof selectApiTestImpact;
};

const packageTestIgnores = (flags: readonly string[], file: string) => {
  const ignored = flags.flatMap((flag, index) => {
    if (flag === "--path-ignore-patterns") {
      const pattern = flags.at(index + 1);
      return pattern === undefined ? [] : [pattern];
    }
    return flag.startsWith("--path-ignore-patterns=")
      ? [flag.slice("--path-ignore-patterns=".length)]
      : [];
  });
  return ignored.some((pattern) => new Bun.Glob(pattern).match(file));
};

export const selectTargets = ({
  root: repo,
  changed,
  hasDb,
  apiImpact = selectApiTestImpact,
}: SelectOptions) => {
  const skipped: Skipped[] = [];
  const targets: Target[] = [];
  let candidates = changed.filter((file) => TEST_FILE.test(file));
  // The gate repeats changed tests only; API impact must never widen it to unchanged suites.
  if (candidates.some((file) => file.startsWith("apps/api/"))) {
    const impact = apiImpact({ root: repo, changed });
    const selected =
      impact.mode === "selected"
        ? selectTestPaths(
            impact.files,
            candidates
              .filter((file) => file.startsWith("apps/api/"))
              .map((file) => file.slice("apps/api/".length)),
          )
        : null;
    candidates = candidates.filter(
      (file) =>
        !file.startsWith("apps/api/") ||
        impact.mode !== "selected" ||
        selected?.has(file.slice("apps/api/".length)),
    );
  }
  for (const file of [...new Set(candidates)].toSorted()) {
    const absolute = path.join(repo, file);
    if (!existsSync(absolute)) {
      skipped.push({ file, reason: "deleted" });
      continue;
    }
    const source = readFileSync(absolute, "utf-8");
    if (
      analyzeModule(file, source).imports.some(({ path: specifier }) =>
        ["@playwright/test", "playwright/test"].includes(specifier),
      ) ||
      (/(?:^|\/)e2e\//u.test(file) && file.includes(".spec."))
    ) {
      skipped.push({ file, reason: "Playwright: not gated in v1" });
      continue;
    }
    if (!hasDb && /\.(?:db|postgres)\.(?:test|spec)\./u.test(file)) {
      skipped.push({ file, reason: "not gated (needs DB)" });
      continue;
    }
    let cwd = path.dirname(absolute);
    while (cwd !== repo && !existsSync(path.join(cwd, "package.json"))) {
      cwd = path.dirname(cwd);
    }
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8")),
    );
    const script = manifest.scripts["test:bun"] ? "test:bun" : "test";
    let env: Record<string, string> = {};
    if (file.startsWith("apps/api/")) {
      const relative = file.slice("apps/api/".length);
      const gated = Object.entries(apiManifest.ciGateTestRunners).filter(
        ([, config]) => source.includes(config.gate),
      );
      const gate = gated.at(0);
      if (gated.length > 1 || (gate && gate[0] !== "test:postgres")) {
        skipped.push({ file, reason: "needs a dedicated service runner" });
        continue;
      }
      if (!hasDb && (gate || isDbTest(relative, source))) {
        skipped.push({ file, reason: "not gated (needs DB)" });
        continue;
      }
      if (gate) {
        env = {
          [gate[1].gate]: gate[1].gateValue,
          CI_POSTGRES_TEST_SELECTION_ENCODED: encodePostgresTestSelection({
            mode: "selected",
            files: [relative],
          }),
          CI_POSTGRES_TEST_SHARD: "",
        };
      } else {
        env = {
          API_TEST_FILES_ENCODED: encodePlanFileList([relative]),
          API_TEST_SHARD: "",
        };
      }
      // CI generates prerequisites once; the API entry retains its own preloads,
      // batching, service setup, and exact selection instead of parsing shell scripts.
      targets.push({
        file,
        cwd,
        command: [
          process.execPath,
          gate ? gate[1].runner : "scripts/run-tests.ts",
          `./${relative}`,
        ],
        env,
        runner: "api",
      });
      continue;
    }
    if (cwd === path.join(repo, "apps/web")) {
      targets.push({
        file,
        cwd,
        command: [
          process.execPath,
          "scripts/run-tests.ts",
          `./${repoRelativePath(cwd, absolute)}`,
        ],
        env,
        runner: "web",
      });
      continue;
    }
    const parsed =
      cwd === repo
        ? { type: "supported" as const, flags: [] }
        : parseBunTestScript(manifest.scripts[script] ?? "");
    if (parsed.type === "unsupported") {
      skipped.push({
        file,
        reason: `not gated (unsupported test script: ${parsed.reason})`,
      });
      continue;
    }
    if (packageTestIgnores(parsed.flags, repoRelativePath(cwd, absolute))) {
      skipped.push({
        file,
        reason: "not gated (excluded by package test script)",
      });
      continue;
    }
    targets.push({
      file,
      cwd,
      command: [
        process.execPath,
        "test",
        ...parsed.flags,
        `./${repoRelativePath(cwd, absolute)}`,
      ],
      env,
      runner: "bun",
    });
  }
  const rust = selectRustTargets(repo, changed);
  for (const target of rust.targets) {
    targets.push({
      file: target.file,
      cwd: target.cwd,
      crate: target.crate,
      module: target.module,
      env: {},
      runner: "rust",
    });
  }
  skipped.push(...rust.unsupported);
  return { targets, skipped };
};

type Measured = { file: string; durationMs: number };
/** Probe cost is already spent. Allocate remaining work fastest first; slow files lose repeats first. */
export const planRepeats = (
  measured: readonly Measured[],
  remainingMs: number,
) => {
  const repeats = new Map(measured.map(({ file }) => [file, 1]));
  let remaining = Math.max(0, remainingMs);
  for (const { file, durationMs } of measured.toSorted(
    (a, b) => a.durationMs - b.durationMs,
  )) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      panic("Expected positive finite duration");
    }
    const extra = Math.min(REPEATS - 1, Math.floor(remaining / durationMs));
    repeats.set(file, 1 + extra);
    remaining -= extra * durationMs;
  }
  return repeats;
};

export type Measurement = {
  file: string;
  runs: number;
  failures: number;
  failedIterations: number[];
  // Trials each Bun test failed in, by full test name: a test that failed in
  // some trials and passed in others is a same-head flake for the quarantine
  // history (scripts/flaky-test-history.ts).
  failedTests: Record<string, number>;
  // The first assertion or error line each failing test printed, and the
  // exit status of a failing trial that named no test, so a red gate says
  // what failed without the trial output.
  failureDetails?: Record<string, string>;
  unnamedFailureStatus?: number;
  durationMs: number;
  planned: number;
};
export type Report = {
  cleanup: FlakeCleanup;
  results: Measurement[];
  skipped: Skipped[];
  errors: string[];
  elapsedMs: number;
};
const markdown = (value: string) =>
  value
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/gu, " ")
    .replaceAll("`", "\\`");
const coverage = ({
  runs,
  failedIterations,
}: Pick<Measurement, "runs" | "failedIterations">) => {
  const reduced = runs < REPEATS ? "reduced repeats (cost cap)" : "";
  if (failedIterations.length === 0) {
    return reduced || "full";
  }
  const failures = `failed iterations ${failedIterations.join(", ")}`;
  return reduced ? `${failures}; ${reduced}` : failures;
};
export const renderReport = (report: Report) =>
  [
    "## Changed-test flake gate (report only by default)",
    "",
    `Target: ${REPEATS} runs (Bun: seeded shuffle; Rust: serial order). Budget: ${BUDGET_MS / 60_000} test-minutes, including probes. Used: ${(report.elapsedMs / 60_000).toFixed(2)} minutes.`,
    "Failures include persistent failures and runner errors; they require investigation before being called flakes.",
    report.cleanup.note,
    "",
    "| Test | Runs | Failures | Coverage |",
    "| --- | ---: | ---: | --- |",
    ...report.results.map(
      ({ file, runs, failures, failedIterations }) =>
        `| ${markdown(file)} | ${runs} | ${failures} | ${coverage({ runs, failedIterations })} |`,
    ),
    ...report.skipped.map(
      ({ file, reason }) =>
        `| ${markdown(file)} | 0 | 0 | ${markdown(reason)} |`,
    ),
    ...report.results.flatMap(
      ({ file, failures, failureDetails = {}, unnamedFailureStatus }) => {
        if (failures === 0) {
          return [];
        }
        const named = Object.entries(failureDetails).map(
          ([name, detail]) =>
            `- \`${markdown(file)}\` › ${markdown(name)}: ${markdown(detail || "no assertion line printed")}`,
        );
        return unnamedFailureStatus === undefined
          ? named
          : [
              ...named,
              `- \`${markdown(file)}\`: a trial failed with exit status ${String(unnamedFailureStatus)} and named no test; rerun the file to see its output`,
            ];
      },
    ),
    ...report.errors.map((error) => `\nRunner error: ${markdown(error)}`),
    "",
  ].join("\n");
export const reportExitCode = (report: Report, blocking: boolean) =>
  blocking &&
  (report.errors.length > 0 ||
    report.results.some(({ failures }) => failures > 0))
    ? 1
    : 0;
export const annotationData = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
export const annotationProperty = (value: string) =>
  annotationData(value).replaceAll(",", "%2C").replaceAll(":", "%3A");

/** One workflow error annotation per failed file; the file name is escaped in both the property and the message. */
export const failureAnnotation = ({
  file,
  failedIterations,
}: {
  file: string;
  failedIterations: readonly number[];
}) =>
  `::error file=${annotationProperty(file)}::${annotationData(
    `${file} failed iteration${failedIterations.length === 1 ? "" : "s"} ${failedIterations.join(", ")}`,
  )}`;

type RunOptions = {
  target: Target;
  seed: number;
  timeoutMs: number;
  onFailureOutput?: ((output: string) => void) | undefined;
};
export type RunOutcome =
  | {
      type: "executed";
      passed: boolean;
      status: number;
      ranTests: boolean;
      failedTests: readonly string[];
      failureDetails?: readonly { name: string; detail: string }[];
    }
  | { type: "no-tests"; reason: string };

type BunTarget = Extract<Target, { runner: "bun" | "api" | "web" }>;

export const trialCommand = (target: BunTarget, seed: number) => [
  ...target.command,
  "--rerun-each=1",
  "--randomize",
  `--seed=${seed}`,
];

type ExecutionOutcomeOptions = {
  runner: Target["runner"];
  outcome: FlakeProcessOutcome;
  onFailureOutput?: ((output: string) => void) | undefined;
};

const executionOutcome = ({
  runner,
  outcome,
  onFailureOutput,
}: ExecutionOutcomeOptions): Extract<RunOutcome, { type: "executed" }> => {
  if (outcome.type === "timeout") {
    onFailureOutput?.(
      "Trial deadline expired; no completed output is available.",
    );
    return {
      type: "executed",
      passed: false,
      status: 124,
      ranTests: false,
      failedTests: [],
    };
  }
  const output = `${outcome.stdout}\n${outcome.stderr}`;
  let ranTests: boolean;
  let failedTests: readonly string[];
  let failureDetails: { name: string; detail: string }[] = [];
  switch (runner) {
    case "bun":
    case "api":
    case "web": {
      ranTests = /\b[1-9]\d* (?:pass|fail)\b/u.test(output);
      const failures = testFailures(output.split("\n"));
      failedTests = [...new Set(failures.map(({ name }) => name))];
      failureDetails = failures.map(({ name, detail }) => ({
        name,
        detail:
          detail.find((line) => /\berror\b|Expected|Received/u.test(line)) ??
          detail.at(0) ??
          "",
      }));
      break;
    }
    case "rust":
      ranTests = /test result:.*\b[1-9]\d* (?:passed|failed)/u.test(output);
      failedTests = [];
      break;
    default:
      runner satisfies never;
      return panic("Unknown flake trial output");
  }
  const passed = outcome.status === 0 && ranTests;
  if (!passed) {
    onFailureOutput?.(output);
  }
  return {
    type: "executed",
    passed,
    status: outcome.status,
    ranTests,
    failedTests,
    ...(runner === "rust" ? {} : { failureDetails }),
  };
};

// Records what a failing trial reported: the first line per failing test,
// or the exit status when it named none.
const recordFailure = (
  result: Measurement,
  outcome: Extract<RunOutcome, { type: "executed" }>,
) => {
  if (outcome.passed) {
    return;
  }
  // Names without details (a runner that reports no detail lines) still
  // name the failure.
  const details =
    outcome.failureDetails ??
    outcome.failedTests.map((name) => ({ name, detail: "" }));
  if (details.length === 0) {
    result.unnamedFailureStatus = outcome.status;
    return;
  }
  // The first trial's line wins: later trials repeat the same failure.
  result.failureDetails = {
    ...Object.fromEntries(details.map(({ name, detail }) => [name, detail])),
    ...result.failureDetails,
  };
};

export const runOnce = async ({
  target,
  seed,
  timeoutMs,
  onFailureOutput,
}: RunOptions): Promise<RunOutcome> => {
  const deadline = performance.now() + timeoutMs;
  switch (target.runner) {
    case "bun":
    case "api":
    case "web":
      // Fresh invocations reset setup and shuffle the entire file for each trial.
      return executionOutcome({
        runner: target.runner,
        outcome: await runFlakeProcess({
          command: trialCommand(target, seed),
          cwd: target.cwd,
          env: target.env,
          deadline,
        }),
        onFailureOutput,
      });
    case "rust": {
      const listing = createRustTestListing(target.module);
      const discovery = await runFlakeProcess({
        command: rustListCommand(target),
        cwd: target.cwd,
        env: target.env,
        deadline,
        onStdoutLine: listing.acceptLine,
      });
      if (discovery.type === "timeout" || discovery.status !== 0) {
        return executionOutcome({
          runner: "rust",
          outcome: discovery,
          onFailureOutput,
        });
      }
      const batches = listing.batches();
      if (batches.length === 0) {
        return {
          type: "no-tests",
          reason: `not gated (no tests in module ${target.module || "<crate>"})`,
        };
      }
      let ranTests = false;
      for (const names of batches) {
        const completed = await runFlakeProcess({
          command: rustExactCommand({ crate: target.crate, names }),
          cwd: target.cwd,
          env: target.env,
          deadline,
        });
        if (completed.type === "completed" && completed.status === 0) {
          const ignored =
            /^test result: ok\. 0 passed; 0 failed; (?<count>[1-9]\d*) ignored;/mu.exec(
              `${completed.stdout}\n${completed.stderr}`,
            );
          // Only a positive ignored count covering this entire exact batch proves a skip.
          if (Number(ignored?.groups?.["count"]) === names.length) {
            continue;
          }
        }
        const execution = executionOutcome({
          runner: "rust",
          outcome: completed,
          onFailureOutput,
        });
        // Once listing selected names, zero execution without ignored evidence is a failure.
        if (!execution.passed) {
          return execution;
        }
        ranTests = true;
      }
      return ranTests
        ? {
            type: "executed",
            passed: true,
            status: 0,
            ranTests: true,
            failedTests: [],
          }
        : {
            type: "no-tests",
            reason: `not gated (all tests in module ${target.module || "<crate>"} are ignored)`,
          };
    }
    default:
      target satisfies never;
      return panic("Unknown flake trial runner");
  }
};

type ExecuteOptions = {
  targets: readonly Target[];
  skipped: Skipped[];
  run?: typeof runOnce;
  now?: () => number;
  budgetMs?: number;
  reportFailureOutput?: ((output: string) => void) | undefined;
};
export const executeGate = async ({
  targets,
  skipped,
  run = runOnce,
  now = () => performance.now(),
  budgetMs = BUDGET_MS,
  reportFailureOutput = (output) => {
    process.stderr.write(output);
  },
}: ExecuteOptions): Promise<Report> => {
  const start = now();
  const report: Report = {
    cleanup: cleanupCapability(),
    results: [],
    skipped: [...skipped],
    errors: [],
    elapsedMs: 0,
  };
  const measured: Measured[] = [];
  const reportedFailures = new Set<string>();
  const failureOutputLimit = 16_384;
  const remaining = () => Math.max(0, budgetMs - (now() - start));
  const attempt = async (options: RunOptions): Promise<RunOutcome> => {
    const outcome = await Result.tryPromise(async () =>
      run({
        ...options,
        onFailureOutput: (output) => {
          if (reportedFailures.has(options.target.file)) {
            return;
          }
          reportedFailures.add(options.target.file);
          reportFailureOutput(
            `Flake trial failed: ${options.target.file}, seed ${options.seed}\n${output.slice(-failureOutputLimit)}\n`,
          );
        },
      }),
    );
    if (outcome.isOk()) {
      return outcome.value;
    }
    report.errors.push(`${options.target.file}: ${outcome.error.message}`);
    return {
      type: "executed",
      passed: false,
      status: 1,
      ranTests: false,
      failedTests: [],
    };
  };
  for (const target of targets) {
    if (remaining() <= 0) {
      report.skipped.push({
        file: target.file,
        reason: "not gated (cost cap)",
      });
      continue;
    }
    const before = now();
    const outcome = await attempt({ target, seed: 1, timeoutMs: remaining() });
    const durationMs = Math.max(1, now() - before);
    if (outcome.type === "no-tests") {
      report.skipped.push({
        file: target.file,
        reason: outcome.reason,
      });
      continue;
    }
    measured.push({ file: target.file, durationMs });
    const first: Measurement = {
      file: target.file,
      runs: 1,
      failures: Number(!outcome.passed),
      failedIterations: outcome.passed ? [] : [1],
      failedTests: Object.fromEntries(
        outcome.failedTests.map((name) => [name, 1]),
      ),
      durationMs,
      planned: 1,
    };
    recordFailure(first, outcome);
    report.results.push(first);
  }
  const plan = planRepeats(measured, remaining());
  // The plan spends the remaining budget as one serial pool, and one test
  // process may already run several lanes, so files repeat one at a time:
  // overlapping runs would contend for the shard runner and could push a
  // stable test past its deadline.
  for (const result of report.results) {
    const target = targets.find(({ file }) => file === result.file);
    if (!target) {
      return panic(`Missing target: ${result.file}`);
    }
    const planned = plan.get(result.file);
    if (planned === undefined) {
      return panic(`Missing repeat plan: ${result.file}`);
    }
    result.planned = planned;
    for (
      let index = 1;
      index < result.planned && remaining() >= result.durationMs;
      index += 1
    ) {
      const outcome = await attempt({
        target,
        seed: index + 1,
        timeoutMs: remaining(),
      });
      result.runs += 1;
      if (outcome.type === "no-tests" || !outcome.passed) {
        result.failures += 1;
        result.failedIterations.push(index + 1);
      }
      if (outcome.type === "executed") {
        recordFailure(result, outcome);
      }
      for (const name of outcome.type === "executed"
        ? outcome.failedTests
        : []) {
        result.failedTests[name] = (result.failedTests[name] ?? 0) + 1;
      }
    }
  }
  report.elapsedMs = now() - start;
  return report;
};

if (import.meta.main) {
  const report: Report = {
    cleanup: cleanupCapability(),
    results: [],
    skipped: [],
    errors: [],
    elapsedMs: 0,
  };
  const outcome = await Result.tryPromise(async () => {
    const base = process.env["BASE_SHA"] || "origin/main";
    // Match ci-plan: NUL-delimited paths, no rename inference, merge-base diff.
    // CI hands ci-plan's list over as a file: a large diff exceeds the size
    // limit of a single environment variable.
    const suppliedPath = process.env["CHANGED_FILES_PATH"];
    const suppliedChanged = suppliedPath
      ? (await Bun.file(suppliedPath).text()).trim()
      : "";
    let changed: string[];
    if (suppliedChanged) {
      changed = v.parse(v.array(v.string()), JSON.parse(suppliedChanged));
    } else {
      const diff = Bun.spawn(
        ["git", "diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`],
        { cwd: root, stdout: "pipe", stderr: "inherit" },
      );
      changed = (await new Response(diff.stdout).text())
        .split("\0")
        .filter(Boolean);
      if ((await diff.exited) !== 0) {
        throw new FlakeGateError({ message: "Cannot read PR diff" });
      }
    }
    const selection = selectTargets({
      root,
      changed,
      hasDb: Boolean(process.env["DATABASE_URL"]),
    });
    if (selection.targets.length > MAX_CHANGED_TEST_FILES) {
      return {
        cleanup: cleanupCapability(),
        results: [],
        skipped: selection.targets.map(({ file }) => ({
          file,
          reason: `not gated (more than ${MAX_CHANGED_TEST_FILES} changed test files)`,
        })),
        errors: [],
        elapsedMs: 0,
      } satisfies Report;
    }
    return executeGate(selection);
  });
  if (outcome.isErr()) {
    report.errors.push(outcome.error.message);
  }
  const finalReport = outcome.isOk() ? outcome.value : report;
  writeFileSync("flake-gate-report.json", JSON.stringify(finalReport, null, 2));
  const summary = renderReport(finalReport);
  console.log(summary);
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], summary);
  }
  for (const result of finalReport.results.filter(
    ({ failures }) => failures > 0,
  )) {
    console.log(failureAnnotation(result));
  }
  for (const error of finalReport.errors) {
    console.log(`::error::${annotationData(error)}`);
  }
  process.exitCode = reportExitCode(
    finalReport,
    process.argv.includes("--blocking"),
  );
}
