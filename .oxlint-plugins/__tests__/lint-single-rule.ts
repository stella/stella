import { panic, Result } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OxlintConfig } from "oxlint";

import { repoRelativePath } from "@stll/portable-path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

/** The oxlint JSON report fields this helper reads, at any nesting level. */
type OxlintJsonNode = {
  readonly code?: unknown;
  readonly labels?: unknown;
  readonly span?: unknown;
  readonly line?: unknown;
  readonly diagnostics?: unknown;
  readonly number_of_files?: unknown;
  readonly number_of_rules?: unknown;
  readonly filename?: unknown;
};

const isRecord = (value: unknown): value is OxlintJsonNode =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/** The line one diagnostic with `code` reports, or null for any other. */
const reportedLine = (diagnostic: unknown, code: string): number | null => {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "string") {
    return null;
  }
  if (!diagnostic.code.startsWith(code)) {
    return null;
  }
  const label = isUnknownArray(diagnostic.labels)
    ? diagnostic.labels.at(0)
    : undefined;
  const span = isRecord(label) ? label.span : undefined;
  const line = isRecord(span) ? span.line : undefined;
  return typeof line === "number" ? line : null;
};

type LintSingleRuleOptions = {
  /** Test-only wrapper for a plugin factory; production config is unchanged. */
  pluginPath?: string;
  /** Repository overrides projected onto the rule being exercised. */
  overrides?: OxlintConfig["overrides"];
  /** Use an oxlint built-in plugin instead of a local JavaScript plugin. */
  builtin?: boolean;
  /** The plugin that carries the rule, when it is not named after it. */
  plugin?: string;
  settings?: Record<string, unknown>;
  fix?: boolean;
  /** The rule's options object, for a rule configured by data. */
  ruleOptions?: unknown;
  /** Options that name paths under the scratch root the source is written to. */
  ruleOptionsForRoot?: (root: string) => unknown;
  /** Where the source is written, relative to a scratch root. */
  sourcePath?: string;
  /** Resolve source paths relative to the scratch checkout. */
  cwd?: "repository" | "scratch";
  /** Test-only scheduler control for awaits before a shared request is ready. */
  delayBeforeSharedAwaitForTest?: (
    point:
      "mkdtemp" | "realpath" | "config-write" | "source-write" | "shared-ready",
  ) => Promise<void>;
  /** Test-only notification after the request cohort is atomically taken. */
  onSharedBatchTakenForTest?: () => void;
};

type OxlintRun = { stdout: string; stderr: string; exitCode: number };

type LintRunner = (args: readonly string[], cwd: string) => Promise<OxlintRun>;

type LintRunTrace = {
  readonly id: number;
  readonly code: string;
  readonly queuedAt: number;
};

let nextLintRunId = 0;
let activeLintRun: LintRunTrace | undefined;

type LintRunEvent =
  | { stage: "queued" | "acquired" | "released" }
  | { stage: "isolated-run" | "batch"; cases: number }
  | { stage: "spawned" | "stdout-eof" | "stderr-eof"; pid: number }
  | { stage: "exited"; pid: number; exitCode: number };

const traceLintRun = (run: LintRunTrace | undefined, event: LintRunEvent) => {
  const { CI: ci } = process.env;
  if (ci !== "true" || run === undefined) {
    return;
  }
  process.stderr.write(
    `[lint-single-rule] ${JSON.stringify({
      worker: process.pid,
      run: run.id,
      rule: run.code,
      elapsedMs: performance.now() - run.queuedAt,
      ...event,
    })}\n`,
  );
};

const spawnOxlint = async (
  args: readonly string[],
  cwd: string,
): Promise<OxlintRun> => {
  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      path.join(REPOSITORY_ROOT, "node_modules/.bin/oxlint"),
      ...args,
    ],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  const run = activeLintRun;
  traceLintRun(run, { stage: "spawned", pid: spawned.pid });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).text().then((output) => {
      traceLintRun(run, { stage: "stdout-eof", pid: spawned.pid });
      return output;
    }),
    new Response(spawned.stderr).text().then((output) => {
      traceLintRun(run, { stage: "stderr-eof", pid: spawned.pid });
      return output;
    }),
    spawned.exited.then((status) => {
      traceLintRun(run, {
        stage: "exited",
        pid: spawned.pid,
        exitCode: status,
      });
      return status;
    }),
  ]);
  return { stdout, stderr, exitCode };
};

const lintRunnersForTest = new Map<string, LintRunner>();

/** Replace one rule's process runner for a test, then restore it afterward. */
export const setLintRunnerForTest = (code: string, runner: LintRunner) => {
  const previous = lintRunnersForTest.get(code);
  lintRunnersForTest.set(code, runner);
  return () => {
    if (previous === undefined) {
      lintRunnersForTest.delete(code);
    } else {
      lintRunnersForTest.set(code, previous);
    }
  };
};

const lintRunner = (code: string): LintRunner =>
  lintRunnersForTest.get(code) ?? spawnOxlint;

// A test process owns at most one oxlint subprocess at a time; concurrent
// tests queue here, and cases that share a configuration join one run.
let oxlintSlot: Promise<unknown> = Promise.resolve();

const withOxlintSlot = async <T>(
  run: () => Promise<T>,
  code: string,
): Promise<T> => {
  const trace = { id: nextLintRunId++, code, queuedAt: performance.now() };
  traceLintRun(trace, { stage: "queued" });
  const next = oxlintSlot.then(async () => {
    activeLintRun = trace;
    traceLintRun(trace, { stage: "acquired" });
    try {
      return await run();
    } finally {
      traceLintRun(trace, { stage: "released" });
      activeLintRun = undefined;
    }
  });
  oxlintSlot = next.catch(() => undefined);
  return next;
};

const testRunnerSlots = new Map<string, Promise<unknown>>();

const withLintSlot = async <T>(
  code: string,
  run: () => Promise<T>,
): Promise<T> => {
  if (!lintRunnersForTest.has(code)) {
    return await withOxlintSlot(run, code);
  }
  const next = (testRunnerSlots.get(code) ?? Promise.resolve()).then(run);
  testRunnerSlots.set(
    code,
    next.catch(() => undefined),
  );
  return await next;
};

/** One case's files, written to its own scratch root as for a lone run. */
type LintCase = {
  readonly configPath: string;
  readonly sourceFile: string;
  readonly fix: boolean;
  /** The scratch root a scratch-relative case runs from. */
  readonly directory: string | undefined;
  readonly sourcePath: string;
};

type AloneRun = OxlintRun & { source: string };

/** Lint one case in a run of its own, exactly as a lone rule test always did. */
const lintAlone = async (
  { configPath, sourceFile, fix, directory, sourcePath }: LintCase,
  code: string,
): Promise<AloneRun> => {
  if (activeLintRun?.code === code && !lintRunnersForTest.has(code)) {
    traceLintRun(activeLintRun, { stage: "isolated-run", cases: 1 });
  }
  const run = await lintRunner(code)(
    [
      "-c",
      configPath,
      "-f",
      "json",
      ...(fix ? ["--fix"] : []),
      directory === undefined ? sourceFile : sourcePath,
    ],
    directory ?? REPOSITORY_ROOT,
  );
  return { ...run, source: readFileSync(sourceFile, "utf-8") };
};

type SharedOutcome =
  | { readonly shared: { lines: number[]; source: string } }
  | { readonly alone: AloneRun };

type SharedRequest = {
  readonly preparation: Promise<CasePreparation>;
  readonly onBatchTakenForTest: (() => void) | undefined;
  readonly resolve: (outcome: SharedOutcome) => void;
  readonly reject: (reason: unknown) => void;
};

type CasePreparation =
  | { readonly status: "ready"; readonly lintCase: LintCase }
  | { readonly status: "failed"; readonly error: unknown };

const settlePreparation = async (
  prepare: () => Promise<LintCase>,
): Promise<CasePreparation> => {
  const result = await Result.tryPromise(prepare);
  return Result.isError(result)
    ? { status: "failed", error: result.error }
    : { status: "ready", lintCase: result.value };
};

/**
 * The lines `code` reports per file of a shared run, or null when the report
 * is anything but a clean, fully attributed run of every file; each case then
 * reruns alone so its own report decides the outcome.
 */
export const sharedLines = (
  { stdout, stderr, exitCode }: OxlintRun,
  sourceFiles: readonly string[],
  code: string,
): number[][] | null => {
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (
    stderr !== "" ||
    Result.isError(report) ||
    !isRecord(report.value) ||
    !isUnknownArray(report.value.diagnostics) ||
    report.value.number_of_files !== sourceFiles.length ||
    report.value.number_of_rules !== 1
  ) {
    return null;
  }
  const linesByFile = new Map(
    sourceFiles.map((sourceFile): [string, number[]] => [sourceFile, []]),
  );
  for (const diagnostic of report.value.diagnostics) {
    const line = reportedLine(diagnostic, code);
    const lines =
      isRecord(diagnostic) && typeof diagnostic.filename === "string"
        ? linesByFile.get(path.resolve(REPOSITORY_ROOT, diagnostic.filename))
        : undefined;
    if (line === null || lines === undefined) {
      return null;
    }
    lines.push(line);
  }
  // An error-level rule exits 1 exactly when it reports something and 0 when
  // it reports nothing; any other exit is a failed run, never clean coverage.
  if (exitCode !== (report.value.diagnostics.length > 0 ? 1 : 0)) {
    return null;
  }
  return sourceFiles.map((sourceFile) =>
    (linesByFile.get(sourceFile) ?? []).toSorted((left, right) => left - right),
  );
};

/** Every accepted shared run in this process, so tests can prove sharing. */
export const sharedRuns: { readonly code: string; readonly cases: number }[] =
  [];

/**
 * Every batch claimed for a configuration, accepted or not, so tests can prove
 * that each case was linted exactly once whatever the grouping.
 */
export const claimedBatches: {
  readonly code: string;
  readonly cases: number;
}[] = [];

type PendingGate = {
  readonly cases: number;
  readonly ready: Promise<undefined>;
  readonly resolve: (value: undefined) => void;
  configKey?: string;
};

const pendingGates = new Map<string, PendingGate>();

/** Hold one rule's next batch until this many cases have registered. */
export const holdSharedRunUntilPendingForTest = (
  code: string,
  cases: number,
) => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  pendingGates.set(code, { cases, ready: promise, resolve });
};

const lintTogether = async (
  lintCases: readonly LintCase[],
  code: string,
): Promise<SharedOutcome[]> => {
  const [first] = lintCases;
  if (first === undefined) {
    return [];
  }
  claimedBatches.push({ code, cases: lintCases.length });
  if (lintCases.length > 1) {
    const sourceFiles = lintCases.map(({ sourceFile }) => sourceFile);
    const lines = sharedLines(
      await lintRunner(code)(
        ["-c", first.configPath, "-f", "json", ...sourceFiles],
        REPOSITORY_ROOT,
      ),
      sourceFiles,
      code,
    );
    if (lines !== null) {
      sharedRuns.push({ code, cases: lintCases.length });
      return lintCases.map((lintCase, index) => ({
        shared: {
          lines: lines[index] ?? [],
          source: readFileSync(lintCase.sourceFile, "utf-8"),
        },
      }));
    }
  }
  const outcomes: SharedOutcome[] = [];
  for (const lintCase of lintCases) {
    outcomes.push({ alone: await lintAlone(lintCase, code) });
  }
  return outcomes;
};

const pendingByConfig = new Map<string, SharedRequest[]>();

/**
 * Whether a case must lint in a run of its own. Scratch-relative paths and
 * override globs depend on the case's own root, and a fix rewrites the file:
 * rerunning a rejected shared --fix run would apply the fixer twice.
 */
export const lintsAlone = ({
  cwd,
  overrides,
  fix,
}: Pick<LintSingleRuleOptions, "cwd" | "overrides" | "fix">): boolean =>
  cwd === "scratch" || overrides !== undefined || fix === true;

/**
 * Lint one case together with every concurrent case of the same rule
 * configuration. Each case keeps its own scratch root and file name, so a
 * shared run sees the same paths and source as the lone runs it replaces.
 */
const lintShared = (
  configKey: string,
  code: string,
  prepare: () => Promise<LintCase>,
  onBatchTakenForTest?: () => void,
): {
  readonly outcome: Promise<SharedOutcome>;
} => {
  const outcome = new Promise<SharedOutcome>((resolve, reject) => {
    let claimedRequests: readonly SharedRequest[] = [];
    const request = {
      preparation: settlePreparation(prepare),
      onBatchTakenForTest,
      resolve,
      reject,
    };
    const gate = pendingGates.get(code);
    if (gate !== undefined && gate.configKey === undefined) {
      gate.configKey = configKey;
    }
    const pending = pendingByConfig.get(configKey);
    if (pending !== undefined) {
      pending.push(request);
      if (gate?.configKey === configKey && pending.length >= gate.cases) {
        gate.resolve(undefined);
      }
      return;
    }
    pendingByConfig.set(configKey, [request]);
    withLintSlot(code, async () => {
      const activeGate = pendingGates.get(code);
      if (activeGate?.configKey === configKey) {
        if (activeGate.cases <= 1) {
          activeGate.resolve(undefined);
        }
        await activeGate.ready;
        pendingGates.delete(code);
      }
      const requests = pendingByConfig.get(configKey) ?? [];
      claimedRequests = requests;
      pendingByConfig.delete(configKey);
      if (activeLintRun?.code === code && !lintRunnersForTest.has(code)) {
        traceLintRun(activeLintRun, { stage: "batch", cases: requests.length });
      }
      requests.at(0)?.onBatchTakenForTest?.();
      const preparations = await Promise.all(
        requests.map(async ({ preparation }) => await preparation),
      );
      const readyRequests: SharedRequest[] = [];
      const lintCases: LintCase[] = [];
      for (const [index, preparation] of preparations.entries()) {
        const queuedRequest = requests[index];
        if (queuedRequest === undefined) {
          continue;
        }
        if (preparation.status === "failed") {
          queuedRequest.reject(preparation.error);
        } else {
          readyRequests.push(queuedRequest);
          lintCases.push(preparation.lintCase);
        }
      }
      const outcomes = await Result.tryPromise(async () =>
        lintTogether(lintCases, code),
      );
      for (const [index, queuedRequest] of readyRequests.entries()) {
        if (Result.isError(outcomes)) {
          queuedRequest.reject(outcomes.error);
        } else {
          const requestOutcome = outcomes.value[index];
          if (requestOutcome === undefined) {
            queuedRequest.reject(new Error("Missing shared oxlint outcome"));
          } else {
            queuedRequest.resolve(requestOutcome);
          }
        }
      }
    }).catch((error: unknown) => {
      const reason =
        error instanceof Error
          ? error
          : new Error("Shared oxlint run failed", { cause: error });
      if (claimedRequests.length === 0) {
        reject(reason);
        return;
      }
      for (const claimedRequest of claimedRequests) {
        claimedRequest.reject(reason);
      }
    });
  });
  return { outcome };
};

const recordCoverage = (ruleId: string, lines: readonly number[]) => {
  const { OXLINT_RULE_COVERAGE_PATH: coveragePath } = process.env;
  if (coveragePath !== undefined) {
    appendFileSync(
      coveragePath,
      `${JSON.stringify({ ruleId, outcome: lines.length === 0 ? "clean" : "report" })}\n`,
    );
  }
};

/**
 * The lines one rule reports on `source`, in order, run through the
 * real oxlint CLI with only that rule enabled. Read from the JSON report, not
 * the rendered output, which varies with terminal and environment.
 */
export const runSingleRule = async (
  ruleName: string,
  source: string,
  {
    builtin = false,
    plugin = ruleName,
    pluginPath,
    overrides,
    settings,
    fix = false,
    ruleOptions,
    ruleOptionsForRoot,
    sourcePath = "source.ts",
    cwd = "repository",
    delayBeforeSharedAwaitForTest,
    onSharedBatchTakenForTest,
  }: LintSingleRuleOptions = {},
) => {
  const code = `${plugin}(${ruleName})`;
  const makeConfig = (options: unknown) =>
    `${JSON.stringify({
      categories: { correctness: "off" },
      settings,
      overrides,
      ...(builtin
        ? { plugins: [plugin] }
        : {
            jsPlugins: [
              pluginPath ??
                path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
            ],
          }),
      rules: {
        [`${plugin}/${ruleName}`]:
          options === undefined ? "error" : ["error", options],
      },
    })}\n`;
  const alone = lintsAlone({ cwd, overrides, fix });
  const fixedConfig =
    ruleOptionsForRoot === undefined ? makeConfig(ruleOptions) : undefined;
  const delay = async (
    point:
      "mkdtemp" | "realpath" | "config-write" | "source-write" | "shared-ready",
  ) => {
    if (!alone) {
      await delayBeforeSharedAwaitForTest?.(point);
    }
  };
  let directory: string | undefined;
  let preparedConfig: string | undefined;
  const prepare = async (): Promise<LintCase> => {
    // Override globs must use the real cwd when the temporary root is a symlink.
    await delay("mkdtemp");
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), `stella-${ruleName}-`),
    );
    directory = temporaryDirectory;
    await delay("realpath");
    directory = await realpath(temporaryDirectory);
    const options = ruleOptionsForRoot?.(directory) ?? ruleOptions;
    const config = fixedConfig ?? makeConfig(options);
    preparedConfig = config;
    const configPath = path.join(directory, "oxlint.json");
    await delay("config-write");
    await Bun.write(configPath, config);
    const sourceFile = path.join(directory, sourcePath);
    await delay("source-write");
    await Bun.write(sourceFile, source);
    const lintCase: LintCase = {
      configPath,
      sourceFile,
      fix,
      directory: cwd === "scratch" ? directory : undefined,
      sourcePath,
    };
    await delay("shared-ready");
    return lintCase;
  };
  // Register before preparation starts. The slot takes one atomic snapshot of
  // requests; readiness and failure affect execution, never batch membership.
  const sharedRequest =
    !alone && fixedConfig !== undefined
      ? lintShared(fixedConfig, code, prepare, onSharedBatchTakenForTest)
      : undefined;
  const lintResult = await Result.tryPromise(async () => {
    if (sharedRequest !== undefined) {
      return await sharedRequest.outcome;
    }
    const lintCase = await prepare();
    if (alone) {
      return {
        alone: await withLintSlot(code, async () => lintAlone(lintCase, code)),
      };
    }
    if (preparedConfig === undefined) {
      return panic("lint case completed without a prepared configuration");
    }
    const lateRequest = lintShared(
      preparedConfig,
      code,
      async () => lintCase,
      onSharedBatchTakenForTest,
    );
    return await lateRequest.outcome;
  });
  if (directory !== undefined) {
    await rm(directory, { force: true, recursive: true });
  }
  if (Result.isError(lintResult)) {
    return panic(`oxlint run failed: ${lintResult.error.message}`);
  }
  if ("shared" in lintResult.value) {
    const { lines, source: linted } = lintResult.value.shared;
    recordCoverage(`${plugin}/${ruleName}`, lines);
    return { lines, source: linted };
  }
  const { stdout, stderr, exitCode } = lintResult.value.alone;
  const output = ["stdout:", stdout, "stderr:", stderr].join("\n");
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (Result.isError(report)) {
    return panic(`oxlint did not produce valid JSON:\n${output}`);
  }
  const diagnostics = isRecord(report.value)
    ? report.value.diagnostics
    : undefined;
  if (!isUnknownArray(diagnostics)) {
    return panic(`oxlint reported no diagnostics array:\n${output}`);
  }
  if (
    !isRecord(report.value) ||
    report.value.number_of_files !== 1 ||
    report.value.number_of_rules !== 1
  ) {
    return panic(
      `oxlint must execute exactly one file and one rule:\n${output}`,
    );
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return panic(`oxlint failed with exit ${exitCode}:\n${output}`);
  }
  if (
    diagnostics.some(
      (diagnostic) => isRecord(diagnostic) && diagnostic.code === undefined,
    )
  ) {
    return panic(`oxlint reported a parser or configuration error:\n${output}`);
  }
  const lines = diagnostics
    .map((diagnostic) => reportedLine(diagnostic, `${plugin}(${ruleName})`))
    .filter((line): line is number => line !== null)
    .toSorted((left, right) => left - right);
  if (lines.length !== diagnostics.length) {
    return panic(
      `oxlint reported diagnostics outside the requested rule:\n${output}`,
    );
  }
  if (exitCode === 1 && lines.length === 0) {
    return panic(
      `oxlint failed without reporting the requested rule:\n${output}`,
    );
  }
  recordCoverage(`${plugin}/${ruleName}`, lines);
  return { lines, source: lintResult.value.alone.source };
};

export const lintSingleRule = async (
  ruleName: string,
  source: string,
  options: LintSingleRuleOptions = {},
): Promise<number[]> => (await runSingleRule(ruleName, source, options)).lines;

/**
 * The lines one rule reports in each of several files linted by ONE oxlint
 * run, keyed by file name. Proves per-file state: `createOnce` closures
 * outlive a file, so a rule that forgets to reset leaks into the next one.
 */
export const lintRuleAcrossFiles = async (
  ruleName: string,
  files: Readonly<Record<string, string>>,
  {
    plugin = ruleName,
    ruleOptions,
    ruleOptionsForRoot,
  }: Pick<
    LintSingleRuleOptions,
    "plugin" | "ruleOptions" | "ruleOptionsForRoot"
  > = {},
): Promise<Record<string, number[]>> => {
  const directory = await mkdtemp(path.join(tmpdir(), `stella-${ruleName}-`));
  const names = Object.keys(files).toSorted();
  const configuredRuleOptions = ruleOptionsForRoot?.(directory) ?? ruleOptions;
  const lintResult = await Result.tryPromise(async () => {
    const configPath = path.join(directory, "oxlint.json");
    await Bun.write(
      configPath,
      `${JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [
          path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${plugin}.ts`),
        ],
        rules: {
          [`${plugin}/${ruleName}`]:
            configuredRuleOptions === undefined
              ? "error"
              : ["error", configuredRuleOptions],
        },
      })}\n`,
    );
    for (const name of names) {
      await Bun.write(path.join(directory, name), files[name] ?? "");
    }
    const { stdout, exitCode } = await withOxlintSlot(
      async () =>
        spawnOxlint(
          [
            "-c",
            configPath,
            "-f",
            "json",
            // One worker walks every file, so state a rule keeps between files
            // is visible instead of split across threads.
            "--threads=1",
            ...names,
          ],
          directory,
        ),
      `${plugin}(${ruleName})`,
    );
    return { stdout, exitCode };
  });
  await rm(directory, { force: true, recursive: true });
  if (Result.isError(lintResult)) {
    return panic(`oxlint run failed: ${lintResult.error.message}`);
  }
  const { stdout, exitCode } = lintResult.value;
  const report = Result.try((): unknown => JSON.parse(stdout));
  if (
    Result.isError(report) ||
    !isRecord(report.value) ||
    !isUnknownArray(report.value.diagnostics) ||
    report.value.number_of_files !== names.length ||
    (exitCode !== 0 && exitCode !== 1)
  ) {
    return panic(`oxlint must lint every file once:\n${stdout}`);
  }
  const linesByFile: Record<string, number[]> = Object.fromEntries(
    names.map((name) => [name, []]),
  );
  for (const diagnostic of report.value.diagnostics) {
    const line = reportedLine(diagnostic, `${plugin}(${ruleName})`);
    const filename =
      isRecord(diagnostic) && typeof diagnostic.filename === "string"
        ? path.isAbsolute(diagnostic.filename)
          ? repoRelativePath(directory, diagnostic.filename)
          : diagnostic.filename
        : undefined;
    const lines = filename === undefined ? undefined : linesByFile[filename];
    if (line === null || lines === undefined) {
      return panic(`oxlint reported an unexpected diagnostic:\n${stdout}`);
    }
    lines.push(line);
  }
  for (const lines of Object.values(linesByFile)) {
    recordCoverage(`${plugin}/${ruleName}`, lines);
  }
  return linesByFile;
};
