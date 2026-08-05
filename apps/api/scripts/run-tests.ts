import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  type ModuleMockTest,
} from "../src/tests/module-mock-batching";

const PROPERTY_FLAG = "--property";
const TEST_FILE_GLOB = "src/**/*.test.{ts,tsx}";
// Non-test helper modules live here; some install a module mock at import.
const TEST_HELPER_GLOB = "src/tests/**/*.ts";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/u;
const PROPERTY_TEST_MARKER = "fc.assert";
const REGULAR_TEST_BATCH_SIZE = 50;
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
const DB_TEST_BATCH_SIZE = 3;
const DB_TEST_MARKERS = [
  "tests/security/rls-helpers",
  "tests/security/rls-fixture",
  "tests/security/test-utils",
  "tests/pglite-schema",
  "@/api/db/root",
  "@/api/db/scoped",
  "pglite",
] as const;
const DB_TEST_PATH_RE = /\.(?:integration|db)\.test\.tsx?$/u;
// Spans multi-line type imports (formatters wrap long ones), up to and
// including the module specifier so it cannot leak into marker matching.
const TYPE_ONLY_IMPORT_RE =
  /^[ \t]*import\s+type\b[\s\S]*?from\s+["'][^"']+["']/gmu;
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
const BYTES_PER_MB = 1024 * 1024;

const apiRoot = path.resolve(import.meta.dir, "..");

// A `mock.module(...)` call runs at import time and, because bun's module-mock
// registry is process-wide, leaks to every other file sharing that process,
// even with `--isolate`. The batcher therefore keeps tests that mock the same
// target apart. It only sees `mock.module` when written in the test's OWN
// source, though. A helper module (e.g. tests/helpers/mock-root-db)
// that calls `mock.module` at import hides the call from that text scan, so a
// test importing it would otherwise land in the shared-process batch and clobber
// a module (e.g. rootDb) that concurrent tests depend on. Detect those helpers
// by their import path so any importer is isolated too. Keyed by the path
// suffix as it appears in an import specifier (`@/api/<suffix>` or a relative
// path ending in `<suffix>`).
const moduleMockHelpers = [
  ...new Bun.Glob(TEST_HELPER_GLOB).scanSync({ cwd: apiRoot, onlyFiles: true }),
]
  .filter((helperPath) => !/\.test\.tsx?$/u.test(helperPath))
  .map((helperPath) => ({
    source: readFileSync(path.join(apiRoot, helperPath), "utf-8"),
    suffix: helperPath.replace(/^src\//u, "").replace(/\.tsx?$/u, ""),
  }))
  .filter(({ source }) => MODULE_MOCK_PATTERN.test(source))
  .map(({ source, suffix }) => {
    const metadata = readModuleMockMetadata(source);
    return {
      hasUnknownMock: metadata.hasUnknownMock,
      mockedModules: metadata.mockedModules,
      suffix,
    };
  });

const installsModuleMock = (source: string): boolean =>
  MODULE_MOCK_PATTERN.test(source) ||
  moduleMockHelpers.some(({ suffix }) => source.includes(suffix));
const readTestModuleMockMetadata = (source: string) => {
  const directMetadata = readModuleMockMetadata(source);
  const metadata = {
    hasUnknownMock: directMetadata.hasUnknownMock,
    mockedModules: new Set(directMetadata.mockedModules),
  };
  for (const helper of moduleMockHelpers) {
    if (!source.includes(helper.suffix)) {
      continue;
    }
    metadata.hasUnknownMock ||= helper.hasUnknownMock;
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

const classifiedTests = await Promise.all(
  testPaths.map(async (testPath) => ({
    source: await Bun.file(path.join(apiRoot, testPath)).text(),
    testPath,
  })),
);

const isDbTest = (testPath: string, source: string): boolean => {
  if (DB_TEST_PATH_RE.test(testPath)) {
    return true;
  }
  const valueImportsOnly = source.replace(TYPE_ONLY_IMPORT_RE, "");
  return DB_TEST_MARKERS.some((marker) => valueImportsOnly.includes(marker));
};

const regularTests: string[] = [];
const dbTests: string[] = [];
const moduleMockTests: ModuleMockTest[] = [];
for (const { source, testPath } of classifiedTests) {
  if (propertyOnly && !source.includes(PROPERTY_TEST_MARKER)) {
    continue;
  }

  if (installsModuleMock(source)) {
    moduleMockTests.push({
      ...readTestModuleMockMetadata(source),
      testPath,
    });
    continue;
  }

  if (isDbTest(testPath, source)) {
    dbTests.push(testPath);
    continue;
  }

  regularTests.push(testPath);
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
  command.push(...forwardedArguments, ...testFiles);

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
    // getrusage semantics pass straight through Bun: ru_maxrss is bytes on
    // macOS but kibibytes on Linux. Normalize before comparing, or the
    // budget can never trip on the hosted runners.
    const peakMb =
      process.platform === "darwin"
        ? Math.round(usage.maxRSS / BYTES_PER_MB)
        : Math.round(usage.maxRSS / 1024);
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
  batchStart: number;
  isolate: boolean;
  maxPeakRssMb: number;
  testFiles: string[];
};

const runTestBatches = async ({
  batchSize,
  batchStart,
  isolate,
  maxPeakRssMb,
  testFiles,
}: RunTestBatchesOptions): Promise<number> => {
  if (batchStart >= testFiles.length) {
    return 0;
  }

  const batch = testFiles.slice(batchStart, batchStart + batchSize);
  const exitCode = await runTests({ isolate, maxPeakRssMb, testFiles: batch });
  if (exitCode !== 0) {
    return exitCode;
  }

  return runTestBatches({
    batchSize,
    batchStart: batchStart + batchSize,
    isolate,
    maxPeakRssMb,
    testFiles,
  });
};

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
  const exitCode = await runTests({ isolate, maxPeakRssMb, testFiles: batch });
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
  batchStart: 0,
  isolate: false,
  maxPeakRssMb: MAX_LOGIC_BATCH_PEAK_RSS_MB,
  testFiles: regularTests,
});
if (regularExitCode !== 0) {
  process.exit(regularExitCode);
}

const dbExitCode = await runTestBatches({
  batchSize: DB_TEST_BATCH_SIZE,
  batchStart: 0,
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
