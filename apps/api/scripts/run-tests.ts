import { panic } from "better-result";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import path from "node:path";

import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  type ModuleMockTest,
} from "../src/tests/module-mock-batching";
import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { buildApiTestCommand } from "./api-test-command";
import { maxRssBytesToMb } from "./resource-usage";
import {
  classifyTestBatch,
  composeTestBatches,
  dbTestBatchSize,
  hasModuleScopeProcessEnvMutation,
  isDbTest,
  TEST_BATCH_KIND,
  type TestBatchKind,
} from "./test-batch-plan";
import {
  deriveTestLaneCount,
  laneRunExitCode,
  orderBatchesForLanes,
  runInLanes,
} from "./test-lanes";
import { partitionRunnerArguments, selectTestPaths } from "./test-path-filters";

const PROPERTY_FLAG = "--property";
// Every directory of this package that holds test files. `evals/` carries
// only its own colocated unit tests (e.g. `evals/lib/model-turn.test.ts`),
// never the eval scripts themselves, which call paid models and run on
// demand. A test file outside these roots never runs and nothing notices
// (the canary suites sat under `scripts/` unrun until the root was added), so
// the run fails when a visible directory outside them holds one.
const TEST_ROOTS = ["src", "evals", "scripts"] as const;
const TEST_ROOT_SET = new Set<string>(TEST_ROOTS);
const TEST_FILE_GLOB = `{${TEST_ROOTS.join(",")}}/**/*.test.{ts,tsx}`;
const STRAY_TEST_FILE_GLOB = "**/*.test.{ts,tsx}";
// Non-test helper modules live here; some install a module mock at import.
const TEST_HELPER_GLOB = "src/tests/**/*.ts";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/u;
const PROPERTY_TEST_MARKER = "fc.assert";
// Keep headroom as the legal-list suite grows: larger batches cross the 2 GiB
// guard once the additional handler and schema modules share one process.
const REGULAR_TEST_BATCH_SIZE = 10;
// Isolated (--isolate) runs accumulate a per-file module registry in one
// process; on the Linux runners four DB-backed mock files exceeded the DB
// batch budget, while three stayed below it. Keep these batches small.
const MODULE_MOCK_TEST_BATCH_SIZE = 3;
// The test database is embedded PGlite. The schema is built once per run
// (scripts/build-pglite-snapshot.ts, spawned below) and every DB-touching
// test process boots from that dumpDataDir snapshot, skipping the ~2.2 GB
// drizzle-kit push peak that used to dominate each process (measured
// per-file solo sweep, 2026-07-20). Each further DB file in a shared
// process still retains its PGlite WASM memory (never shrinks), so
// DB-touching tests keep running in small dedicated batches; pure-logic
// tests keep the larger batch size (they stay in the hundreds of MB).
//
// A test connects iff it VALUE-imports one of the connection entry modules
// (type-only imports are erased and connect nothing; handlers receive their
// db via context, and module-level singletons are lazy per the side-effect
// conventions). The path fallback catches integration suites that reach the
// db through their own local setup.
// Some protocol conformance tests intentionally load an independent client
// implementation alongside the API server graph, while sandbox tests exercise
// hard memory limits. Keep both classes in fresh processes so their retained
// graphs/allocations cannot inflate an ordinary 50-file logic batch.
const HEAVY_LOGIC_TEST_BATCH_SIZE = 1;
const HEAVY_LOGIC_SOURCE_MARKERS = ["@modelcontextprotocol/client"] as const;
const HEAVY_LOGIC_PATH_MARKERS = [
  "handlers/chat/tools/execute/sandbox/",
] as const;
// Hard per-batch peak-RSS budgets. A batch that outgrows its budget fails
// the run even when every test passes, so memory growth surfaces here as a
// readable error instead of an opaque exit-137 kill when the hosted
// runner's memory runs out. Raising one is a reviewed product decision
// (like the typecheck and network baselines), not a mechanical way to make
// CI green. Two budgets, because the batch kinds have different floors:
// DB-touching batches boot PGlite from the prebuilt snapshot (see below),
// logic batches never connect at all. Measured on a full macOS run,
// 2026-08-05: worst DB batch 2072 MB (3 snapshot-booted files; each file
// boots its own PGlite instance and WASM memory is retained for the
// process lifetime), worst logic batch 1520 MB (50 files; chat stream
// suites carry the largest module graphs). Linux RSS accounting runs
// hotter than macOS, so both budgets carry headroom above those figures;
// recalibrate from the peak-RSS lines the runner prints on CI.
const MAX_DB_BATCH_PEAK_RSS_MB = 2560;
const MAX_LOGIC_BATCH_PEAK_RSS_MB = 2048;
// The sandbox's deliberate exponential-allocation test expands QuickJS/WASM
// before the 1 MB guest limit aborts it. Its dedicated process may peak above
// the ordinary logic ceiling, but remains bounded below the hosted 4 GB limit.
const MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB = 3072;

const apiRoot = path.resolve(import.meta.dir, "..");

// A `mock.module(...)` call runs at import time and, because bun's module-mock
// registry is process-wide, leaks to every other file sharing that process,
// even with `--isolate`. The batcher therefore keeps a mocked module away from
// both the other files that mock it and the other files that merely import it
// (see src/tests/module-mock-batching.ts). It only sees `mock.module` when
// written in the test's OWN source, though. A helper module (e.g.
// tests/helpers/mock-root-db) that calls `mock.module` at import hides the call
// from that text scan, so a test importing it would otherwise land in the
// shared-process batch and clobber a module (e.g. rootDb) that concurrent tests
// depend on. Detect those helpers by their import path so any importer is
// isolated too, and fold the helper's own mock targets and imports into every
// importing test. Keyed by the path suffix as it appears in an import specifier
// (`@/api/<suffix>` or a relative path ending in `<suffix>`).
const moduleMockHelpers = [
  ...new Bun.Glob(TEST_HELPER_GLOB).scanSync({ cwd: apiRoot, onlyFiles: true }),
]
  .filter((helperPath) => !/\.test\.tsx?$/u.test(helperPath))
  .map((helperPath) => ({
    helperPath,
    source: readFileSync(path.join(apiRoot, helperPath), "utf-8"),
    suffix: helperPath.replace(/^src\//u, "").replace(/\.tsx?$/u, ""),
  }))
  .filter(({ source }) => MODULE_MOCK_PATTERN.test(source))
  .map(({ helperPath, source, suffix }) => {
    const metadata = readModuleMockMetadata(source, helperPath);
    return {
      hasUnknownImport: metadata.hasUnknownImport,
      hasUnknownMock: metadata.hasUnknownMock,
      importedModules: metadata.importedModules,
      mockedModules: metadata.mockedModules,
      suffix,
    };
  });

const installsModuleMock = (source: string): boolean =>
  MODULE_MOCK_PATTERN.test(source) ||
  moduleMockHelpers.some(({ suffix }) => source.includes(suffix));
const readTestModuleMockMetadata = (source: string, testPath: string) => {
  const directMetadata = readModuleMockMetadata(source, testPath);
  const metadata = {
    hasUnknownImport: directMetadata.hasUnknownImport,
    hasUnknownMock: directMetadata.hasUnknownMock,
    importedModules: new Set(directMetadata.importedModules),
    mockedModules: new Set(directMetadata.mockedModules),
  };
  for (const helper of moduleMockHelpers) {
    if (!source.includes(helper.suffix)) {
      continue;
    }
    metadata.hasUnknownImport ||= helper.hasUnknownImport;
    metadata.hasUnknownMock ||= helper.hasUnknownMock;
    // The helper's own imports arrive in the process along with it, so they
    // are exposed to the batch's mocks exactly like the test file's imports.
    for (const importedModule of helper.importedModules) {
      metadata.importedModules.add(importedModule);
    }
    for (const mockedModule of helper.mockedModules) {
      metadata.mockedModules.add(mockedModule);
    }
  }
  return metadata;
};
const preloadPath = path.join(apiRoot, "src/tests/setup-env.ts");
const runnerArguments = Bun.argv.slice(2);
const propertyOnly = runnerArguments.includes(PROPERTY_FLAG);
const forwardedArguments = runnerArguments.filter(
  (argument) => argument !== PROPERTY_FLAG,
);

const testPaths = [
  ...new Bun.Glob(TEST_FILE_GLOB).scanSync({
    cwd: apiRoot,
    onlyFiles: true,
  }),
].toSorted();

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

const classifiedTests = await Promise.all(
  testPaths.map(async (testPath) => ({
    source: await Bun.file(path.join(apiRoot, testPath)).text(),
    testPath,
  })),
);

const regularTests: string[] = [];
const heavyLogicTests: string[] = [];
const dbTests: string[] = [];
const moduleMockTests: ModuleMockTest[] = [];
for (const { source, testPath } of classifiedTests) {
  if (propertyOnly && !source.includes(PROPERTY_TEST_MARKER)) {
    continue;
  }

  const batchKind = classifyTestBatch({
    dbBacked: isDbTest(testPath, source),
    heavyLogic:
      HEAVY_LOGIC_SOURCE_MARKERS.some((marker) => source.includes(marker)) ||
      HEAVY_LOGIC_PATH_MARKERS.some((marker) => testPath.includes(marker)) ||
      hasModuleScopeProcessEnvMutation(testPath, source),
    installsModuleMock: installsModuleMock(source),
    propertyOnly,
  });
  switch (batchKind) {
    case TEST_BATCH_KIND.moduleMock:
      moduleMockTests.push({
        ...readTestModuleMockMetadata(source, testPath),
        testPath,
      });
      break;
    case TEST_BATCH_KIND.db:
      dbTests.push(testPath);
      break;
    case TEST_BATCH_KIND.heavyLogic:
      heavyLogicTests.push(testPath);
      break;
    case TEST_BATCH_KIND.regular:
      regularTests.push(testPath);
      break;
    default:
      batchKind satisfies never;
      panic(`Unhandled batch kind: ${String(batchKind)}`);
  }
}

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

// Every child process the runner started and has not reaped yet. An interrupt
// stops them and waits for them before the run ends, because the `exit` hook
// below then deletes the snapshot file they may still be reading.
const liveChildren = new Set<Bun.Subprocess>();
const runnerShutdown = new AbortController();
const CHILD_STOP_GRACE_MS = 10_000;

const awaitChild = async (child: Bun.Subprocess): Promise<number> => {
  liveChildren.add(child);
  try {
    return await child.exited;
  } finally {
    liveChildren.delete(child);
  }
};

const stopLiveChildren = async (signal: NodeJS.Signals): Promise<void> => {
  const children = [...liveChildren];
  for (const child of children) {
    child.kill(signal);
  }
  const escalation = setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
  }, CHILD_STOP_GRACE_MS);
  try {
    await Promise.all(children.map(async (child) => await child.exited));
  } finally {
    clearTimeout(escalation);
  }
};

// The handler never exits by itself: aborting stops new batches, the running
// ones end once signalled, and the run then finishes through its normal path,
// which prints the summary and removes the snapshot in the `exit` hook. A
// second signal skips the grace period.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (runnerShutdown.signal.aborted) {
      for (const child of liveChildren) {
        child.kill("SIGKILL");
      }
      return;
    }
    printError(
      `${signal} received; stopping ${liveChildren.size} running test ` +
        "process(es) before cleanup ...",
    );
    runnerShutdown.abort();
    stopLiveChildren(signal).catch((error: unknown) => {
      printError(`Stopping the test processes failed: ${String(error)}`);
    });
  });
}

const buildTestDbSnapshot = async (): Promise<string> => {
  const snapshotPath = path.join(
    tmpdir(),
    `stella-pglite-test-snapshot-${process.pid}.tar`,
  );
  console.log("Building the PGlite test-database snapshot ...");
  // Registered before the build so a failed build's partial file is also
  // removed.
  process.on("exit", () => {
    rmSync(snapshotPath, { force: true });
  });
  if (runnerShutdown.signal.aborted) {
    process.exit(1);
  }
  const builder = Bun.spawn({
    cmd: [
      process.execPath,
      path.join(apiRoot, "scripts/build-pglite-snapshot.ts"),
      snapshotPath,
    ],
    cwd: apiRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const builderExitCode = await awaitChild(builder);
  if (builderExitCode !== 0) {
    console.error("PGlite snapshot build failed; aborting the test run.");
    process.exit(builderExitCode);
  }
  return snapshotPath;
};

type PlannedTestBatch = {
  isolate: boolean;
  kind: TestBatchKind;
  label: string;
  maxPeakRssMb: number;
  testFiles: string[];
};

type PlanBatchesOptions = {
  isolate: boolean;
  kind: TestBatchKind;
  maxPeakRssMb: number;
  testBatches: readonly string[][];
};

/** Label every composed batch, then keep only the selection inside each. */
const planBatches = ({
  isolate,
  kind,
  maxPeakRssMb,
  testBatches,
}: PlanBatchesOptions): PlannedTestBatch[] =>
  testBatches
    .map((batch, index) => ({
      isolate,
      kind,
      label: `${kind} batch ${index + 1}/${testBatches.length}`,
      maxPeakRssMb,
      testFiles: selectWithinBatch(batch),
    }))
    .filter(({ testFiles }) => testFiles.length > 0);

// A fresh process per test batch makes module memory reclaimable. One
// process for the full suite grows until the hosted runner terminates it.
// `evals/` unit tests get their own batches after the `src/` ones so adding
// one never shifts the composition of a `src/` batch (a shift changes which
// files share a process, and that has surfaced order-dependent failures).
// Lanes change only which batches run at the same time, never which files
// share a process.
const EVALS_TEST_PREFIX = "evals/";
const regularSrcTests = regularTests.filter(
  (testPath) => !testPath.startsWith(EVALS_TEST_PREFIX),
);
const regularEvalTests = regularTests.filter((testPath) =>
  testPath.startsWith(EVALS_TEST_PREFIX),
);
const plannedBatches = orderBatchesForLanes([
  ...planBatches({
    isolate: false,
    kind: TEST_BATCH_KIND.regular,
    maxPeakRssMb: MAX_LOGIC_BATCH_PEAK_RSS_MB,
    testBatches: [
      ...composeTestBatches(regularSrcTests, REGULAR_TEST_BATCH_SIZE),
      ...composeTestBatches(regularEvalTests, REGULAR_TEST_BATCH_SIZE),
    ],
  }),
  ...planBatches({
    isolate: false,
    kind: TEST_BATCH_KIND.heavyLogic,
    maxPeakRssMb: MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB,
    testBatches: composeTestBatches(
      heavyLogicTests,
      HEAVY_LOGIC_TEST_BATCH_SIZE,
    ),
  }),
  ...planBatches({
    isolate: false,
    kind: TEST_BATCH_KIND.db,
    maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
    testBatches: composeTestBatches(dbTests, dbTestBatchSize(propertyOnly)),
  }),
  ...planBatches({
    isolate: true,
    kind: TEST_BATCH_KIND.moduleMock,
    maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
    testBatches: batchModuleMockTests(
      moduleMockTests,
      MODULE_MOCK_TEST_BATCH_SIZE,
    ),
  }),
]);

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
  testProcessEnv[PGLITE_TEST_SNAPSHOT_ENV] = await buildTestDbSnapshot();
}

const testLanes = deriveTestLaneCount({
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

const collectStream = async (
  stream: ReadableStream<Uint8Array>,
  parts: string[],
): Promise<void> => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
};

type ChildResult = {
  exitCode: number;
  usage: ReturnType<Bun.Subprocess["resourceUsage"]>;
};

const spawnStreaming = async (command: string[]): Promise<ChildResult> => {
  const child = Bun.spawn({
    cmd: command,
    cwd: apiRoot,
    env: testProcessEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await awaitChild(child);
  return { exitCode, usage: child.resourceUsage() };
};

const spawnCollected = async (
  command: string[],
  log: BatchLog,
): Promise<ChildResult> => {
  const child = Bun.spawn({
    cmd: command,
    cwd: apiRoot,
    env: testProcessEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both streams feed one list in arrival order, so a test's own stdout lines
  // stay next to the reporter's stderr lines around them.
  const parts: string[] = [];
  const [exitCode] = await Promise.all([
    awaitChild(child),
    collectStream(child.stdout, parts),
    collectStream(child.stderr, parts),
  ]);
  log.out(parts.join("").trimEnd());
  return { exitCode, usage: child.resourceUsage() };
};

const runTests = async (
  { isolate, label, maxPeakRssMb, testFiles }: PlannedTestBatch,
  log: BatchLog,
): Promise<number> => {
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
  const command = buildApiTestCommand({
    bunExecutable: process.execPath,
    bunRuntimeArguments: ["--smol"],
    testArguments,
    testFiles,
  });

  const startedAt = performance.now();
  const { exitCode, usage } = bufferBatchOutput
    ? await spawnCollected(command, log)
    : await spawnStreaming(command);
  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  log.out(`${label} finished in ${elapsedSeconds}s with exit code ${exitCode}`);

  if (usage) {
    // Bun exposes Subprocess.resourceUsage().maxRSS in bytes on every
    // platform. Normalizing it as Linux getrusage kibibytes turns a 394 MB
    // process into an impossible 403,796 MB reading under Bun 1.4.
    const peakMb = maxRssBytesToMb(usage.maxRSS);
    log.out(
      `${executionMode} batch (${testFiles.length} files) peak RSS: ` +
        `${peakMb} MB (budget ${maxPeakRssMb} MB)`,
    );
    if (exitCode === 0 && peakMb > maxPeakRssMb) {
      log.err(
        `Test batch exceeded the ${maxPeakRssMb} MB peak-RSS ` +
          "budget. Find what grew (new fixtures held across files, " +
          "unclosed pools/servers, oversized in-memory corpora) or split " +
          "the offending files; raising the budget requires justification " +
          "in the PR description.",
      );
      return 1;
    }
  }

  return exitCode;
};

/**
 * Buffered output goes to stdout as one write: separate stdout and stderr
 * writes can reach a shared log out of order, splitting a batch's block.
 */
const runBufferedTests = async (batch: PlannedTestBatch): Promise<number> => {
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
    return await runTests(batch, bufferedLog);
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
  runBatch: async (batch) =>
    bufferBatchOutput
      ? await runBufferedTests(batch)
      : await runTests(batch, streamingLog),
  signal: runnerShutdown.signal,
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
process.exitCode = laneRunExitCode(outcomes);
