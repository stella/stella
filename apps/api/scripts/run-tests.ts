import { panic, TaggedError } from "better-result";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import path from "node:path";

import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";

import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { buildApiTestCommand } from "./api-test-command";
import {
  listApiTestPaths,
  MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB,
  planApiTestBatches,
  TEST_ROOTS,
  type ComposedTestBatches,
} from "./api-test-plan";
import {
  BATCH_MEMORY,
  batchMemoryVerdict,
  maxRssBytesToMb,
} from "./resource-usage";
import {
  measuredTestRssTable,
  parseRssMeasurementArguments,
  staleTestRssTableAnnotation,
  testRssArtifact,
  TEST_BATCH_KIND,
  type TestBatchKind,
  type TestRssMeasurement,
} from "./test-batch-plan";
import {
  acquireCurrentSnapshot,
  snapshotCacheDir,
  snapshotDigest,
  snapshotKey,
  SnapshotBuildError,
} from "./test-db-snapshot-cache";
import {
  API_TEST_SHARD_ENV,
  restrictApiTestFiles,
  selectApiTestFiles,
} from "./test-file-shards";
import {
  deriveTestLaneCount,
  laneRunExitCode,
  orderBatchesForLanes,
  runInLanes,
} from "./test-lanes";
import { partitionRunnerArguments, selectTestPaths } from "./test-path-filters";
import {
  TestProcessSupervisor,
  testProcessBudgets,
} from "./test-process-supervisor";
import {
  API_TEST_DURATIONS_FILE_ENV,
  loadTestDurationWeights,
  testFileDurationWeights,
} from "./test-timings";

const PROPERTY_FLAG = "--property";
const TEST_ROOT_SET = new Set<string>(TEST_ROOTS);
const STRAY_TEST_FILE_GLOB = "**/*.test.{ts,tsx}";

const apiRoot = path.resolve(import.meta.dir, "..");

const preloadPath = path.join(apiRoot, "src/tests/setup-env.ts");
const rssMode = parseRssMeasurementArguments(Bun.argv.slice(2));
const runnerArguments = rssMode.arguments;
const measurements: TestRssMeasurement[] = [];
const propertyOnly = runnerArguments.includes(PROPERTY_FLAG);
const forwardedArguments = runnerArguments.filter(
  (argument) => argument !== PROPERTY_FLAG,
);

const allTestPaths = restrictApiTestFiles(
  listApiTestPaths(apiRoot),
  process.env["API_TEST_FILES"],
);
const durationWeights = loadTestDurationWeights({
  files: allTestPaths,
  path: process.env[API_TEST_DURATIONS_FILE_ENV],
});
const { testPaths, shard } = selectApiTestFiles({
  files: allTestPaths,
  durations: durationWeights,
  shardValue: process.env[API_TEST_SHARD_ENV],
});
if (shard !== null) {
  console.log(
    `API test shard ${shard.index}/${shard.count}: ${testPaths.length}/${allTestPaths.length} files`,
  );
}
// One annotation per run: the first shard speaks for all of them.
if (rssMode.mode === "batched" && (shard === null || shard.index === 1)) {
  const staleTable = staleTestRssTableAnnotation(
    measuredTestRssTable().measuredAt,
    new Date(),
  );
  if (staleTable !== undefined) {
    console.log(staleTable);
  }
}

// Hidden directories are tool caches; `node_modules` is third-party code. A
// test file colocated with a package-root module (`drizzle.config.test.ts`
// beside `drizzle.config.ts`) is outside every root too, so files are scanned
// alongside directories.
const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const strayTestPaths = readdirSync(apiRoot, { withFileTypes: true })
  .filter(
    (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
  )
  .flatMap((entry) => {
    if (entry.isFile()) {
      return TEST_FILE_PATTERN.test(entry.name) ? [entry.name] : [];
    }
    if (!entry.isDirectory() || TEST_ROOT_SET.has(entry.name)) {
      return [];
    }
    return [
      ...new Bun.Glob(STRAY_TEST_FILE_GLOB).scanSync({
        cwd: path.join(apiRoot, entry.name),
        onlyFiles: true,
      }),
    ].map((testPath) => `${entry.name}/${testPath}`);
  })
  .toSorted();
if (strayTestPaths.length > 0) {
  console.error(
    `Test files outside the runner roots (${TEST_ROOTS.join(", ")}) never run:\n  ${strayTestPaths.join("\n  ")}\nMove the file under a root, or add its directory to TEST_ROOTS in apps/api/scripts/run-tests.ts.`,
  );
  process.exit(1);
}

// A positional pattern narrows each batch rather than joining it; see
// scripts/test-path-filters.ts for why appending would defeat the batcher.
const { bunArguments, patterns } = partitionRunnerArguments(forwardedArguments);
const selectedTestPaths = selectTestPaths(testPaths, patterns);

if (selectedTestPaths?.size === 0) {
  console.error(`No test files match: ${patterns.join(", ")}`);
  process.exit(1);
}

/** Keep a batch's composition, run only the selection inside it. */
const selectWithinBatch = (batch: string[]): string[] =>
  selectedTestPaths === null
    ? batch
    : batch.filter((testPath) => selectedTestPaths.has(testPath));

// Mirrors PGLITE_TEST_SNAPSHOT_ENV in src/tests/pglite-test-db.ts; a
// literal here keeps the runner from importing the whole API schema graph.
const PGLITE_TEST_SNAPSHOT_ENV = "PGLITE_TEST_SNAPSHOT";

// Once batches run, runner output goes through the stdout/stderr streams, not
// console: a stream queues what a full pipe cannot take yet and the process
// stays alive until the queue is written, while a direct console write to a
// full pipe can be cut short. The batch phase never calls process.exit(),
// which would drop the queue.
const print = (text: string) => {
  process.stdout.write(`${text}\n`);
};
const printError = (text: string) => {
  process.stderr.write(`${text}\n`);
};

const processSupervisor = new TestProcessSupervisor({
  // The dedicated memory workflow allows two hours for a serial per-file
  // sweep; nightly jobs declare budgets explicitly, while PR defaults stay bounded.
  ...testProcessBudgets(
    process.env,
    rssMode.mode === "measure-rss" ? 110 * 60_000 : undefined,
  ),
  directory:
    process.env["API_TEST_ARTIFACT_DIR"] ??
    mkdtempSync(path.join(tmpdir(), "stella-api-test-diagnostics-")),
  onProgress: print,
  onDiagnostic: printError,
  onStdout: (text) => {
    process.stdout.write(text);
  },
  onStderr: (text) => {
    process.stderr.write(text);
  },
});
process.on("exit", () => {
  processSupervisor.dispose();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (processSupervisor.signal.aborted) {
      processSupervisor.kill();
      return;
    }
    processSupervisor.stop(
      `${signal} received; stopping API test processes before cleanup`,
    );
  });
}

const runSnapshotBuilder = async (snapshotPath: string): Promise<void> => {
  console.log("Building the PGlite test-database snapshot ...");
  if (processSupervisor.signal.aborted) {
    throw new SnapshotBuildError({
      message: "PGlite snapshot build interrupted.",
      exitCode: 1,
    });
  }
  const { exitCode: builderExitCode } = await processSupervisor.run({
    command: () => [
      process.execPath,
      path.join(apiRoot, "scripts/build-pglite-snapshot.ts"),
      snapshotPath,
    ],
    cwd: apiRoot,
    env: process.env,
    identity: {
      kind: "snapshot",
      label: "PGlite snapshot build",
      files: ["scripts/build-pglite-snapshot.ts"],
      lane: 0,
    },
    mode: "stream",
  });
  if (builderExitCode !== 0) {
    throw new SnapshotBuildError({
      message: "PGlite snapshot build failed; aborting the test run.",
      exitCode: builderExitCode,
    });
  }
};

const buildPrivateSnapshot = async (): Promise<string> => {
  const snapshotPath = path.join(
    tmpdir(),
    `stella-pglite-test-snapshot-${process.pid}.tar`,
  );
  process.on("exit", () => {
    rmSync(snapshotPath, { force: true });
  });
  await runSnapshotBuilder(snapshotPath);
  return snapshotPath;
};

const validateSnapshot = async (snapshotPath: string): Promise<boolean> => {
  const digestPath = snapshotPath.replace(/\.tar$/u, ".sha256");
  if (
    readFileSync(digestPath, "utf-8") !== (await snapshotDigest(snapshotPath))
  ) {
    return false;
  }
  const { exitCode } = await processSupervisor.run({
    command: () => ["tar", "-tf", snapshotPath],
    cwd: apiRoot,
    env: process.env,
    identity: {
      kind: "snapshot-validation",
      label: "PGlite snapshot archive validation",
      files: [snapshotPath],
      lane: 0,
    },
    mode: "discard",
  });
  return exitCode === 0;
};

const buildTestDbSnapshot = async (): Promise<string> => {
  if (
    process.env["CI"] !== undefined &&
    !process.env["STELLA_PGLITE_SNAPSHOT_CACHE_DIR"]
  ) {
    return await buildPrivateSnapshot();
  }
  try {
    const repositoryRoot = path.resolve(apiRoot, "../..");
    const entryPoint = path.join(apiRoot, "scripts/build-pglite-snapshot.ts");
    const result = await acquireCurrentSnapshot({
      cacheDir: snapshotCacheDir(process.env),
      key: () => snapshotKey(repositoryRoot, entryPoint),
      build: runSnapshotBuilder,
      validate: validateSnapshot,
      signal: processSupervisor.signal,
    });
    if (result.status === "hit") {
      process.on("exit", result.snapshot.release);
      return result.snapshot.path;
    }
    printError(
      `PGlite snapshot cache unavailable (${result.reason}); building privately.`,
    );
  } catch (error) {
    if (error instanceof SnapshotBuildError) {
      throw error;
    }
    printError(
      `PGlite snapshot cache unavailable (${String(error)}); building privately.`,
    );
  }
  return await buildPrivateSnapshot();
};

type PlannedTestBatch = {
  isolate: boolean;
  kind: TestBatchKind;
  label: string;
  maxPeakRssMb: number;
  testFiles: string[];
};

/** Label every composed batch, then keep only the selection inside each. */
const planBatches = ({
  isolate,
  kind,
  maxPeakRssMb,
  testBatches,
}: ComposedTestBatches): PlannedTestBatch[] =>
  testBatches
    .map((batch, index) => ({
      isolate,
      kind,
      label: `${kind} batch ${index + 1}/${testBatches.length}`,
      maxPeakRssMb,
      testFiles: selectWithinBatch(batch),
    }))
    .filter(({ testFiles }) => testFiles.length > 0);

const composedBatches = await planApiTestBatches({
  executionMode: rssMode.mode,
  apiRoot,
  propertyOnly,
  testPaths,
});
const plannedBatches = orderBatchesForLanes(
  composedBatches.flatMap((group) => planBatches(group)),
  testFileDurationWeights(allTestPaths, durationWeights),
);

const testProcessEnv: Record<string, string | undefined> = {
  ...process.env,
  [PROPERTY_TEST_TIMEOUT_BASE_MS_ENV]: String(API_TEST_TIMEOUT_MS),
};
// Only a run that selected a DB-backed or module-mock batch boots PGlite, so
// a run of logic test files skips the snapshot build.
if (
  plannedBatches.some(
    ({ kind }) =>
      kind === TEST_BATCH_KIND.db || kind === TEST_BATCH_KIND.moduleMock,
  )
) {
  try {
    testProcessEnv[PGLITE_TEST_SNAPSHOT_ENV] = await buildTestDbSnapshot();
  } catch (error) {
    if (error instanceof SnapshotBuildError) {
      printError(error.message);
      process.exitCode = error.exitCode;
      throw error;
    }
    throw error;
  }
}

const testLanes =
  rssMode.mode === "measure-rss"
    ? 1
    : deriveTestLaneCount({
        availableParallelism: availableParallelism(),
        env: process.env,
        // At most one heavy batch runs at a time, so sizing every lane for the
        // heavy budget over-reserves; that slack covers the runner's own processes.
        laneMemoryBudgetMb: MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB,
        totalMemoryBytes: totalmem(),
      });
// Concurrent children writing to the inherited terminal would interleave
// line by line. With more than one lane each batch's output is collected and
// printed as one block when the batch ends; a serial run streams live.
const bufferBatchOutput = testLanes > 1;

/** Collects one batch's output, or passes it straight through when serial. */
type BatchLog = {
  err: (line: string) => void;
  out: (line: string) => void;
};

const streamingLog: BatchLog = {
  err: (line) => {
    printError(line);
  },
  out: (line) => {
    print(line);
  },
};

class TestRssMeasurementError extends TaggedError("TestRssMeasurementError")<{
  message: string;
}> {}

/** Measure the preload once with the same Bun flags and snapshot as file children. */
const measurePreloadBaseline = async () => {
  const directory = mkdtempSync(path.join(apiRoot, ".rss-baseline-"));
  const file = path.join(directory, "baseline.test.ts");
  writeFileSync(
    file,
    'import { test } from "bun:test"; test("preload memory baseline", () => {});\n',
  );
  try {
    const child = await processSupervisor.run({
      command: (junitPath) =>
        buildApiTestCommand({
          bunExecutable: process.execPath,
          bunRuntimeArguments: ["--smol"],
          testArguments: [
            "--preload",
            preloadPath,
            "--reporter=junit",
            `--reporter-outfile=${junitPath}`,
          ],
          testFiles: [file],
        }),
      cwd: apiRoot,
      env: testProcessEnv,
      identity: {
        kind: "baseline",
        label: "preload memory baseline",
        files: [file],
        lane: 0,
      },
      mode: "stream",
    });
    const peakMb =
      child.usage === undefined ? 0 : maxRssBytesToMb(child.usage.maxRSS);
    if (child.exitCode !== 0 || !Number.isFinite(peakMb) || peakMb <= 0) {
      throw new TestRssMeasurementError({
        message: "Could not measure API preload peak RSS",
      });
    }
    return peakMb;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const baselineMb =
  rssMode.mode === "measure-rss" ? await measurePreloadBaseline() : 0;

type RunTestsOptions = {
  batch: PlannedTestBatch;
  log: BatchLog;
  lane: number;
};

const runTests = async ({
  batch: { isolate, label, maxPeakRssMb, testFiles },
  log,
  lane,
}: RunTestsOptions): Promise<number> => {
  const executionMode = isolate ? "isolated" : "shared-process";
  log.out(
    `Running ${testFiles.length} ${executionMode} API test files (${label})`,
  );

  // Each batch loads many graph-heavy API modules. Prefer more frequent garbage
  // collection so it stays within the hosted runner's memory budget.
  const testArguments = ["--preload", preloadPath];
  if (isolate) {
    testArguments.push("--isolate");
  }
  testArguments.push(...bunArguments);
  const startedAt = performance.now();
  const { exitCode, usage, output } = await processSupervisor.run({
    command: (junitPath) =>
      buildApiTestCommand({
        bunExecutable: process.execPath,
        bunRuntimeArguments: ["--smol"],
        testArguments: [
          ...testArguments,
          "--reporter=junit",
          `--reporter-outfile=${junitPath}`,
        ],
        testFiles,
      }),
    cwd: apiRoot,
    env: testProcessEnv,
    identity: { kind: "batch", label, files: testFiles, lane },
    mode: bufferBatchOutput ? "buffered" : "stream",
  });
  if (bufferBatchOutput) {
    log.out(output);
  }
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  log.out(`${label} finished in ${elapsedSeconds}s with exit code ${exitCode}`);

  if (usage) {
    // Bun exposes Subprocess.resourceUsage().maxRSS in bytes on every
    // platform. Normalizing it as Linux getrusage kibibytes turns a 394 MB
    // process into an impossible 403,796 MB reading under Bun 1.4.
    const peakMb = maxRssBytesToMb(usage.maxRSS);
    if (rssMode.mode === "measure-rss") {
      const file = testFiles.at(0);
      if (
        testFiles.length !== 1 ||
        file === undefined ||
        !Number.isFinite(peakMb) ||
        peakMb <= 0
      ) {
        log.err(`Cannot measure peak RSS for ${testFiles.join(", ")}`);
        return 1;
      }
      measurements.push({ file, peakMb, exitCode });
    }
    log.out(
      `${executionMode} batch (${testFiles.length} files) peak RSS: ` +
        `${peakMb} MB (budget ${maxPeakRssMb} MB)`,
    );
    if (exitCode === 0) {
      const verdict = batchMemoryVerdict({
        label,
        peakMb,
        budgetMb: maxPeakRssMb,
        testFiles,
      });
      switch (verdict.type) {
        case BATCH_MEMORY.within:
          break;
        case BATCH_MEMORY.planDrift:
        case BATCH_MEMORY.nearCap:
          log.out(verdict.annotation);
          break;
        case BATCH_MEMORY.over:
          log.err(verdict.message);
          return 1;
        default:
          verdict satisfies never;
          panic("Unhandled batch memory verdict");
      }
    }
  }

  if (rssMode.mode === "measure-rss" && !usage) {
    log.err(`No subprocess peak RSS reported for ${testFiles.join(", ")}`);
    return 1;
  }
  return exitCode;
};

/**
 * Buffered output goes to stdout as one write: separate stdout and stderr
 * writes can reach a shared log out of order, splitting a batch's block.
 */
const runBufferedTests = async (
  batch: PlannedTestBatch,
  lane: number,
): Promise<number> => {
  const lines: string[] = [];
  const bufferedLog: BatchLog = {
    err: (line) => {
      lines.push(line);
    },
    out: (line) => {
      lines.push(line);
    },
  };
  try {
    return await runTests({ batch, log: bufferedLog, lane });
  } catch (error) {
    bufferedLog.err(`${batch.label} could not run: ${String(error)}`);
    return 1;
  } finally {
    print(lines.join("\n"));
  }
};

print(
  `Running ${plannedBatches.length} API test batches in ${testLanes} ` +
    `lane${testLanes === 1 ? "" : "s"}`,
);
const runStartedAt = performance.now();
const outcomes = await runInLanes({
  batches: plannedBatches,
  lanes: testLanes,
  runBatch: async (batch, lane) =>
    bufferBatchOutput
      ? await runBufferedTests(batch, lane)
      : await runTests({ batch, log: streamingLog, lane }),
  signal: processSupervisor.signal,
  failurePolicy: rssMode.mode === "measure-rss" ? "complete" : "serial-fast",
});
const runSeconds = ((performance.now() - runStartedAt) / 1000).toFixed(1);
const failedOutcomes = outcomes.filter(
  ({ exitCode }) => exitCode !== null && exitCode !== 0,
);
const unstartedCount = outcomes.filter(
  ({ exitCode }) => exitCode === null,
).length;
print(
  `Ran ${outcomes.length - unstartedCount} of ${outcomes.length} API test ` +
    `batches in ${runSeconds}s (${testLanes} lane${testLanes === 1 ? "" : "s"}); ${failedOutcomes.length} failed${unstartedCount > 0 ? `, ${unstartedCount} not started` : ""}`,
);
// On stdout with the batch blocks, so it cannot overtake one that is still
// queued for a slow reader.
if (failedOutcomes.length > 0) {
  print(
    [
      "Failed API test batches:",
      ...failedOutcomes.map(
        ({ batch, exitCode }) =>
          `  ${batch.label} (exit ${String(exitCode)}):\n    ${batch.testFiles.join("\n    ")}`,
      ),
    ].join("\n"),
  );
}
if (rssMode.mode === "measure-rss") {
  writeFileSync(
    rssMode.outputPath,
    testRssArtifact({
      measurements,
      measuredAt: new Date().toISOString(),
      baselineMb,
      environment: rssMode.environment,
      source: rssMode.source,
      shard: shard ?? { index: 1, count: 1 },
      plannedFiles: testPaths.length,
    }),
  );
  print(
    `Wrote ${measurements.length} per-file peak RSS measurements to ${rssMode.outputPath}`,
  );
}
processSupervisor.dispose();
process.exitCode = laneRunExitCode(outcomes);
