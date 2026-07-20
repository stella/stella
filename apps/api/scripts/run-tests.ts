import { readFileSync } from "node:fs";
import path from "node:path";

const PROPERTY_FLAG = "--property";
const TEST_FILE_GLOB = "src/**/*.test.{ts,tsx}";
// Non-test helper modules live here; some install a module mock at import.
const TEST_HELPER_GLOB = "src/tests/**/*.ts";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/u;
const PROPERTY_TEST_MARKER = "fc.assert";
const REGULAR_TEST_BATCH_SIZE = 50;
// Isolated (--isolate) runs accumulate a per-file module registry in one
// process; on the Linux runners 20 mock files measured 6.3 GB. Keep these
// batches small.
const MODULE_MOCK_TEST_BATCH_SIZE = 4;
// The test database is embedded PGlite. Measured behavior (per-file solo
// sweep, 2026-07-20): ANY process that connects pays a ~2.2 GB peak during
// the per-suite drizzle schema push, and each further DB file in the same
// process adds ~0.2-0.3 GB (WASM memory never shrinks). DB-touching tests
// therefore run in small dedicated batches so a process stays near the
// floor; pure-logic tests keep the larger batch size (they stay in the
// hundreds of MB). Follow-up that would collapse the floor itself: build
// the schema once and boot each process from a PGlite dumpDataDir
// snapshot instead of re-pushing.
//
// A test connects iff it VALUE-imports one of the connection entry modules
// (type-only imports are erased and connect nothing; handlers receive their
// db via context, and module-level singletons are lazy per the side-effect
// conventions). The path fallback catches integration suites that reach the
// db through their own local setup.
const DB_TEST_BATCH_SIZE = 4;
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
  /^\s*import\s+type\b[\s\S]*?from\s+["'][^"']+["']/gmu;
// Hard per-batch peak-RSS budget. A batch that outgrows it fails the run
// even when every test passes, so memory growth surfaces here as a readable
// error instead of an opaque exit-137 kill when the hosted runner's memory
// runs out. Raising it is a reviewed product decision (like the typecheck
// and network baselines), not a mechanical way to make CI green.
// Calibrated from the Linux runners' first measured full run (worst batch
// 3670 MB; Linux RSS accounting runs hotter than macOS): high enough to
// absorb near-threshold variance, low enough to leave ~3 GB for a
// concurrent turbo task on the 7 GB runner.
const MAX_BATCH_PEAK_RSS_MB = 4096;
const BYTES_PER_MB = 1024 * 1024;

const apiRoot = path.resolve(import.meta.dir, "..");

// A `mock.module(...)` call runs at import time and, because bun's module-mock
// registry is process-wide, leaks to every other file sharing that process. The
// runner isolates such tests — but only sees `mock.module` when it is written
// in the test's OWN source. A helper module (e.g. tests/helpers/mock-root-db)
// that calls `mock.module` at import hides the call from that text scan, so a
// test importing it would otherwise land in the shared-process batch and clobber
// a module (e.g. rootDb) that concurrent tests depend on. Detect those helpers
// by their import path so any importer is isolated too. Keyed by the path
// suffix as it appears in an import specifier (`@/api/<suffix>` or a relative
// path ending in `<suffix>`).
const moduleMockHelperSuffixes = [
  ...new Bun.Glob(TEST_HELPER_GLOB).scanSync({ cwd: apiRoot, onlyFiles: true }),
]
  .filter((helperPath) => !/\.test\.tsx?$/u.test(helperPath))
  .filter((helperPath) =>
    MODULE_MOCK_PATTERN.test(
      readFileSync(path.join(apiRoot, helperPath), "utf-8"),
    ),
  )
  .map((helperPath) =>
    helperPath.replace(/^src\//u, "").replace(/\.tsx?$/u, ""),
  );

const installsModuleMock = (source: string): boolean =>
  MODULE_MOCK_PATTERN.test(source) ||
  moduleMockHelperSuffixes.some((suffix) => source.includes(suffix));
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
const moduleMockTests: string[] = [];
for (const { source, testPath } of classifiedTests) {
  if (propertyOnly && !source.includes(PROPERTY_TEST_MARKER)) {
    continue;
  }

  if (installsModuleMock(source)) {
    moduleMockTests.push(testPath);
    continue;
  }

  if (isDbTest(testPath, source)) {
    dbTests.push(testPath);
    continue;
  }

  regularTests.push(testPath);
}

const runTests = async (testFiles: string[], isolate: boolean) => {
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
    env: process.env,
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
        `${peakMb} MB (budget ${MAX_BATCH_PEAK_RSS_MB} MB)`,
    );
    if (exitCode === 0 && peakMb > MAX_BATCH_PEAK_RSS_MB) {
      console.error(
        `Test batch exceeded the ${MAX_BATCH_PEAK_RSS_MB} MB peak-RSS ` +
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
  testFiles: string[];
};

const runTestBatches = async ({
  batchSize,
  batchStart,
  isolate,
  testFiles,
}: RunTestBatchesOptions): Promise<number> => {
  if (batchStart >= testFiles.length) {
    return 0;
  }

  const batch = testFiles.slice(batchStart, batchStart + batchSize);
  const exitCode = await runTests(batch, isolate);
  if (exitCode !== 0) {
    return exitCode;
  }

  return runTestBatches({
    batchSize,
    batchStart: batchStart + batchSize,
    isolate,
    testFiles,
  });
};

// A fresh process per test batch makes module memory reclaimable. One
// process for the full suite grows until the hosted runner terminates it.
const regularExitCode = await runTestBatches({
  batchSize: REGULAR_TEST_BATCH_SIZE,
  batchStart: 0,
  isolate: false,
  testFiles: regularTests,
});
if (regularExitCode !== 0) {
  process.exit(regularExitCode);
}

const dbExitCode = await runTestBatches({
  batchSize: DB_TEST_BATCH_SIZE,
  batchStart: 0,
  isolate: false,
  testFiles: dbTests,
});
if (dbExitCode !== 0) {
  process.exit(dbExitCode);
}

process.exit(
  await runTestBatches({
    batchSize: MODULE_MOCK_TEST_BATCH_SIZE,
    batchStart: 0,
    isolate: true,
    testFiles: moduleMockTests,
  }),
);
