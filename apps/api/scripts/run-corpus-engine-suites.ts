import { panic, Result, TaggedError } from "better-result";
import { mkdirSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { printError } from "@stll/errors";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import packageJson from "../package.json" with { type: "json" };
import { buildApiTestCommand } from "./api-test-command";
import {
  dockerContainerName,
  dockerImageRef,
  dockerVolumeName,
} from "./lib/docker-volume-name";
import { discoverGatedTestFiles } from "./run-gated-tests";
import { TEST_BATCH_KIND } from "./test-batch-plan";
import { runInLanes } from "./test-lanes";

const corpusRunner = packageJson.ciGateTestRunners["test:corpus"];
export const CORPUS_ENGINE_GATE = corpusRunner.gate;
const TEMPLATE_CONTAINER = "corpus-engine";
// Two PGlite schema builders can overlap with the longest engine-only suite.
const ENGINE_TEST_LANES = 3;
const COMMAND_TIMEOUT_MS = 90_000;
const SUITE_TIMEOUT_MS = 40 * 60_000;

// Longest suite first; every file owns its engine, index storage and process.
export const CORPUS_ENGINE_TEST_FILES = [
  "src/lib/legal-search/corpus-index-delete-survivor.contract.test.ts",
  "src/handlers/legislation/search-relaxed.contract.test.ts",
  "src/handlers/legislation/statute-recall.contract.test.ts",
  "src/lib/legal-search/corpus-index-scored-scan.contract.test.ts",
  "src/lib/legal-search/corpus-index-query-features.contract.test.ts",
] as const;

export const assertCorpusEngineTestCoverage = async (apiRoot: string) => {
  const discovered = await discoverGatedTestFiles({
    apiRoot,
    gate: CORPUS_ENGINE_GATE,
    testFileGlob: corpusRunner.testFileGlob,
  });
  const listed = new Set<string>(CORPUS_ENGINE_TEST_FILES);
  const missing = discovered.filter((file) => !listed.has(file));
  const stale = CORPUS_ENGINE_TEST_FILES.filter(
    (file) => !discovered.includes(file),
  );
  if (missing.length > 0 || stale.length > 0) {
    panic(
      `Corpus engine suite coverage drift: unlisted=${missing.join(", ")}; stale=${stale.join(", ")}`,
    );
  }
};

type PlanCorpusEngineSuitesOptions = {
  outputRoot: string;
  runId: string;
};

export const planCorpusEngineSuites = ({
  outputRoot,
  runId,
}: PlanCorpusEngineSuitesOptions) =>
  CORPUS_ENGINE_TEST_FILES.map((file, index) => {
    const containerName = `corpus-suite-${runId}-${index}`;
    const outputDir = path.join(outputRoot, containerName);
    return {
      file,
      kind: TEST_BATCH_KIND.regular,
      containerName,
      outputDir,
      dataVolume: `${containerName}-data`,
      junitPath: path.join(outputDir, "tests.xml"),
    };
  });

type CorpusEngineSuite = ReturnType<typeof planCorpusEngineSuites>[number];

type SuiteTermination = {
  exitCode: number | null;
  signalCode?: string | number | null;
};

type RunCorpusEngineSuitesOptions = {
  suites: readonly CorpusEngineSuite[];
  execute: (suite: CorpusEngineSuite) => Promise<SuiteTermination>;
  signal: AbortSignal;
  report: (message: string) => void;
};

export const runCorpusEngineSuites = async ({
  suites,
  execute,
  signal,
  report,
}: RunCorpusEngineSuitesOptions) => {
  const outcomes = await runInLanes({
    batches: suites,
    lanes: ENGINE_TEST_LANES,
    failurePolicy: "complete",
    signal,
    runBatch: async (suite) => {
      const started = performance.now();
      const result = await Result.tryPromise(async () => await execute(suite));
      const exitCode = result.isErr() ? 1 : childExitStatus(result.value);
      const detail = result.isErr()
        ? result.error.message
        : `exit=${String(result.value.exitCode)}, signal=${String(result.value.signalCode ?? "none")}`;
      report(
        `${exitCode === 0 ? "PASS" : "FAIL"} ${suite.file}: ${((performance.now() - started) / 1000).toFixed(1)}s (${detail})`,
      );
      return exitCode;
    },
  });
  const failed = outcomes.filter(({ exitCode }) => exitCode !== 0);
  for (const { batch, exitCode } of failed) {
    report(
      `Failed corpus engine suite: ${batch.file}${exitCode === null ? " (interrupted before starting)" : ""}`,
    );
  }
  return { outcomes, exitCode: signal.aborted || failed.length > 0 ? 1 : 0 };
};

// Preserve the workflow's execution guard, including malformed/missing reports.
export const CORPUS_ENGINE_REPORT_CHECK = `import sys, xml.etree.ElementTree as E
r = E.parse(sys.argv[1]).getroot()
n = len(list(r.iter("testcase")))
assert n > 0 and not any(list(r.iter(t)) for t in ("skipped", "failure", "error")) and not any(int(e.get(k, "0")) for e in r.iter() for k in ("skipped", "disabled", "failures", "errors")), "Engine tests must execute without skips or failures"
print(f"Executed {n} engine tests")`;

class CorpusSuiteCommandError extends TaggedError("CorpusSuiteCommandError")<{
  message: string;
}> {}

type CommandOptions = {
  command: string[];
  cwd: string;
  signal?: AbortSignal;
  output?: number;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const runCommand = async ({
  command,
  cwd,
  signal,
  output,
  environment = process.env,
  timeoutMs = COMMAND_TIMEOUT_MS,
}: CommandOptions) => {
  signal?.throwIfAborted();
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: environment,
    ...(signal === undefined ? {} : { signal }),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdin: "ignore",
    stdout: output ?? "pipe",
    stderr: output ?? "inherit",
  });
  const [stdout] = await Promise.all([
    typeof child.stdout === "number" ? "" : new Response(child.stdout).text(),
    child.exited,
  ]);
  if (childExitStatus(child) !== 0) {
    throw new CorpusSuiteCommandError({
      message: `${String(command.at(0))} failed: exit=${String(child.exitCode)}, signal=${String(child.signalCode)}`,
    });
  }
  return stdout.trim();
};

type ExecuteCorpusSuiteOptions = {
  apiRoot: string;
  image: string;
  signal: AbortSignal;
  suite: CorpusEngineSuite;
  run?: (options: CommandOptions) => Promise<string>;
};

export const executeCorpusSuite = async ({
  apiRoot,
  image,
  signal,
  suite,
  run = runCommand,
}: ExecuteCorpusSuiteOptions): Promise<SuiteTermination> => {
  mkdirSync(suite.outputDir, { recursive: true });
  const temporaryDir = path.join(suite.outputDir, "tmp");
  mkdirSync(temporaryDir);
  const logPath = path.join(suite.outputDir, "suite.log");
  const log = openSync(logPath, "w");
  const command = async (args: string[]) =>
    await run({ command: args, cwd: apiRoot, signal });
  const result = await Result.tryPromise(async () => {
    await command([
      "docker",
      "volume",
      "create",
      dockerVolumeName(suite.dataVolume),
    ]);
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      dockerContainerName(suite.containerName),
      "--publish",
      "127.0.0.1::7280",
      "--mount",
      `type=volume,source=${dockerVolumeName(suite.dataVolume)},target=/quickwit/qwdata`,
      dockerImageRef(image),
      "run",
    ]);
    const binding = await command([
      "docker",
      "port",
      suite.containerName,
      "7280/tcp",
    ]);
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(binding);
    if (match === null) {
      panic(`Unexpected corpus engine port binding: ${binding}`);
    }
    const endpoint = `http://${binding}`;
    await command([
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "30",
      "--retry-connrefused",
      "--retry-all-errors",
      "--retry-delay",
      "1",
      "--retry-max-time",
      "60",
      "--max-time",
      "2",
      `${endpoint}/health/readyz`,
    ]);
    const environment = {
      ...process.env,
      [CORPUS_ENGINE_GATE]: corpusRunner.gateValue,
      STELLA_RUN_POSTGRES_TESTS: undefined,
      STELLA_CORPUS_ENGINE_TEST_ENDPOINT: endpoint,
      PGLITE_TEST_SNAPSHOT: undefined,
      TMPDIR: temporaryDir,
    };
    await run({
      command: buildApiTestCommand({
        bunExecutable: process.execPath,
        bunRuntimeArguments: [],
        testArguments: [
          "--preload",
          "./src/tests/setup-env.ts",
          "--preload",
          "./scripts/corpus-engine-test-env.ts",
          "--reporter=junit",
          `--reporter-outfile=${suite.junitPath}`,
        ],
        testFiles: [suite.file],
      }),
      cwd: apiRoot,
      environment,
      signal,
      output: log,
      timeoutMs: SUITE_TIMEOUT_MS,
    });
    await run({
      command: ["python3", "-c", CORPUS_ENGINE_REPORT_CHECK, suite.junitPath],
      cwd: apiRoot,
      signal,
      output: log,
    });
  });
  // Cleanup is not tied to the cancelled signal: every owned container is reaped.
  const diagnostics = await Result.tryPromise(
    async () =>
      await run({
        command: ["docker", "logs", suite.containerName],
        cwd: apiRoot,
        output: log,
      }),
  );
  const cleanup = await Result.tryPromise(
    async () =>
      await run({
        command: ["docker", "rm", "--force", "--volumes", suite.containerName],
        cwd: apiRoot,
        output: log,
      }),
  );
  const volumeCleanup = await Result.tryPromise(
    async () =>
      await run({
        command: ["docker", "volume", "rm", suite.dataVolume],
        cwd: apiRoot,
        output: log,
      }),
  );
  closeSync(log);
  process.stdout.write(
    `\n##[group]${suite.file}\n${readFileSync(logPath, "utf-8")}\n##[endgroup]\n`,
  );
  // Retain reports/logs, but do not accumulate engine indexes after teardown.
  if (cleanup.isOk()) {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
  const errors = [
    result.match({ ok: () => [], err: ({ message }) => [message] }),
    diagnostics.match({ ok: () => [], err: ({ message }) => [message] }),
    cleanup.match({ ok: () => [], err: ({ message }) => [message] }),
    volumeCleanup.match({ ok: () => [], err: ({ message }) => [message] }),
  ].flat();
  if (errors.length > 0) {
    throw new CorpusSuiteCommandError({ message: errors.join("; ") });
  }
  return { exitCode: 0 };
};

if (import.meta.main) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const apiRoot = path.resolve(import.meta.dir, "..");
    await assertCorpusEngineTestCoverage(apiRoot);
    // The workflow owns the pinned image; inspect its immutable local ID.
    const image = await runCommand({
      command: [
        "docker",
        "inspect",
        "--format",
        "{{.Image}}",
        TEMPLATE_CONTAINER,
      ],
      cwd: apiRoot,
      signal: abort.signal,
    });
    const suites = planCorpusEngineSuites({
      outputRoot: path.join(apiRoot, ".cache/corpus-engine-suites"),
      runId: Bun.randomUUIDv7(),
    });
    const result = await runCorpusEngineSuites({
      suites,
      signal: abort.signal,
      report: (message) => {
        process.stdout.write(`${message}\n`);
      },
      execute: async (suite) =>
        await executeCorpusSuite({
          apiRoot,
          image,
          signal: abort.signal,
          suite,
        }),
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    printError(error);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
