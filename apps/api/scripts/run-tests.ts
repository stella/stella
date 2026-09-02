import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  type ModuleMockTest,
} from "../src/tests/module-mock-batching";
import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { maxRssBytesToMb } from "./resource-usage";
import {
  classifyTestBatch,
  composeTestBatches,
  dbTestBatchSize,
  hasModuleScopeProcessEnvMutation,
  isDbTest,
  TEST_BATCH_KIND,
} from "./test-batch-plan";
import { partitionRunnerArguments, selectTestPaths } from "./test-path-filters";

const PROPERTY_FLAG = "--property";
// `evals/` carries only its own colocated unit tests (e.g.
// `evals/lib/model-turn.test.ts`), never the eval scripts themselves, which
// call paid models and run on demand.
const TEST_FILE_GLOB = "{src,evals}/**/*.test.{ts,tsx}";
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
].sort();

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
  }
}

// Mirrors PGLITE_TEST_SNAPSHOT_ENV in src/tests/pglite-test-db.ts; a
// literal here keeps the runner from importing the whole API schema graph.
const PGLITE_TEST_SNAPSHOT_ENV = "PGLITE_TEST_SNAPSHOT";

const buildTestDbSnapshot = async (): Promise<string> => {
  const snapshotPath = path.join(
    tmpdir(),
    `stella-pglite-test-snapshot-${process.pid}.tar`,
  );
  console.log("Building the PGlite test-database snapshot ...");
  // Registered before the build so a failed build's partial file is also
  // removed; `exit` does not fire on signals, so cover those explicitly.
  const cleanupSnapshot = () => {
    rmSync(snapshotPath, { force: true });
  };
  process.on("exit", cleanupSnapshot);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanupSnapshot();
      process.exit(1);
    });
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
  const builderExitCode = await builder.exited;
  if (builderExitCode !== 0) {
    console.error("PGlite snapshot build failed; aborting the test run.");
    process.exit(builderExitCode);
  }
  return snapshotPath;
};

const testProcessEnv: Record<string, string | undefined> = {
  ...process.env,
  [PROPERTY_TEST_TIMEOUT_BASE_MS_ENV]: String(API_TEST_TIMEOUT_MS),
};
if (dbTests.length > 0 || moduleMockTests.length > 0) {
  testProcessEnv[PGLITE_TEST_SNAPSHOT_ENV] = await buildTestDbSnapshot();
}

type RunTestsOptions = {
  isolate: boolean;
  maxPeakRssMb: number;
  testFiles: string[];
};

const runTests = async ({
  isolate,
  maxPeakRssMb,
  testFiles,
}: RunTestsOptions) => {
  if (testFiles.length === 0) {
    return 0;
  }

  const executionMode = isolate ? "isolated" : "shared-process";
  console.log(`Running ${testFiles.length} ${executionMode} API test files`);

  // Each batch loads many graph-heavy API modules. Prefer more frequent garbage
  // collection so it stays within the hosted runner's memory budget.
  const command = [
    process.execPath,
    "--smol",
    "test",
    "--preload",
    preloadPath,
  ];
  if (isolate) {
    command.push("--isolate");
  }
  command.push(...bunArguments, ...testFiles);

  const child = Bun.spawn({
    cmd: command,
    cwd: apiRoot,
    env: testProcessEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  const usage = child.resourceUsage();
  if (usage) {
    // Bun exposes Subprocess.resourceUsage().maxRSS in bytes on every
    // platform. Normalizing it as Linux getrusage kibibytes turns a 394 MB
    // process into an impossible 403,796 MB reading under Bun 1.4.
    const peakMb = maxRssBytesToMb(usage.maxRSS);
    console.log(
      `${executionMode} batch (${testFiles.length} files) peak RSS: ` +
        `${peakMb} MB (budget ${maxPeakRssMb} MB)`,
    );
    if (exitCode === 0 && peakMb > maxPeakRssMb) {
      console.error(
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

type RunTestBatchesOptions = {
  batchSize: number;
  isolate: boolean;
  maxPeakRssMb: number;
  testFiles: string[];
};

const runTestBatches = async ({
  batchSize,
  isolate,
  maxPeakRssMb,
  testFiles,
}: RunTestBatchesOptions): Promise<number> =>
  await runPreparedTestBatches({
    batchStart: 0,
    isolate,
    maxPeakRssMb,
    testBatches: composeTestBatches(testFiles, batchSize),
  });

type RunPreparedTestBatchesOptions = {
  batchStart: number;
  isolate: boolean;
  maxPeakRssMb: number;
  testBatches: readonly string[][];
};

const runPreparedTestBatches = async ({
  batchStart,
  isolate,
  maxPeakRssMb,
  testBatches,
}: RunPreparedTestBatchesOptions): Promise<number> => {
  if (batchStart >= testBatches.length) {
    return 0;
  }

  const batch = testBatches.at(batchStart);
  if (batch === undefined) {
    return 0;
  }
  const exitCode = await runTests({
    isolate,
    maxPeakRssMb,
    testFiles: selectWithinBatch(batch),
  });
  if (exitCode !== 0) {
    return exitCode;
  }

  return runPreparedTestBatches({
    batchStart: batchStart + 1,
    isolate,
    maxPeakRssMb,
    testBatches,
  });
};

// A fresh process per test batch makes module memory reclaimable. One
// process for the full suite grows until the hosted runner terminates it.
const regularExitCode = await runTestBatches({
  batchSize: REGULAR_TEST_BATCH_SIZE,
  isolate: false,
  maxPeakRssMb: MAX_LOGIC_BATCH_PEAK_RSS_MB,
  testFiles: regularTests,
});
if (regularExitCode !== 0) {
  process.exit(regularExitCode);
}

const heavyLogicExitCode = await runTestBatches({
  batchSize: HEAVY_LOGIC_TEST_BATCH_SIZE,
  isolate: false,
  maxPeakRssMb: MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB,
  testFiles: heavyLogicTests,
});
if (heavyLogicExitCode !== 0) {
  process.exit(heavyLogicExitCode);
}

const dbExitCode = await runTestBatches({
  batchSize: dbTestBatchSize(propertyOnly),
  isolate: false,
  maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
  testFiles: dbTests,
});
if (dbExitCode !== 0) {
  process.exit(dbExitCode);
}

process.exit(
  await runPreparedTestBatches({
    batchStart: 0,
    isolate: true,
    maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
    testBatches: batchModuleMockTests(
      moduleMockTests,
      MODULE_MOCK_TEST_BATCH_SIZE,
    ),
  }),
);
