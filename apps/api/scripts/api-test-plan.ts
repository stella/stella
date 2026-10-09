import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  batchModuleMockTests,
  readModuleMockMetadata,
  type ModuleMockTest,
} from "../src/tests/module-mock-batching";
import {
  classifyTestBatch,
  composeTestBatches,
  dbTestBatchSize,
  hasModuleScopeProcessEnvMutation,
  isDbTest,
  SOLO_TEST_PATHS,
  splitMemoryBoundedBatches,
  splitSoloTests,
  TEST_BATCH_KIND,
  type TestBatchKind,
} from "./test-batch-plan";

// Every directory of this package that holds test files. `evals/` carries
// only its own colocated unit tests (e.g. `evals/lib/model-turn.test.ts`),
// never the eval scripts themselves, which call paid models and run on
// demand. A test file outside these roots never runs and nothing notices
// (the canary suites sat under `scripts/` unrun until the root was added), so
// the run fails when a visible directory outside them holds one.
export const TEST_ROOTS = ["src", "evals", "scripts"] as const;
const TEST_FILE_GLOB = `{${TEST_ROOTS.join(",")}}/**/*.test.{ts,tsx}`;
// Non-test helper modules live here; some install a module mock at import.
const TEST_HELPER_GLOB = "src/tests/**/*.ts";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/u;
const PROPERTY_TEST_MARKERS = ["fc.assert", "assertProperty"];
// Keep headroom as the legal-list suite grows: larger batches cross the 2 GiB
// guard once the additional handler and schema modules share one process.
const REGULAR_TEST_BATCH_SIZE = 10;
// Isolated (--isolate) runs accumulate a per-file module registry in one
// process; on the Linux runners four DB-backed mock files exceeded the DB
// batch budget, while three stayed below it. Keep these batches small.
const MODULE_MOCK_TEST_BATCH_SIZE = 3;
// The test database is embedded PGlite. The schema snapshot is built once
// per cache key (scripts/build-pglite-snapshot.ts, spawned below). Every
// DB-touching test process boots from that dumpDataDir snapshot, skipping
// the ~2.2 GB drizzle-kit push peak that used to dominate each process (measured
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
// Declare this comment in DB tests that retain a full-size corpus. Keeping the
// decision beside the fixture avoids a second, path-based inventory.
const HEAVY_DB_TEST_BATCH_SIZE = 1;
const HEAVY_DB_SOURCE_MARKERS = [/^\s*\/\/ @api-test-heavy-db\b/mu];
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
// CI green. The ordinary batch kinds have different floors:
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
// Full-size corpus tests retain both PGlite WASM and the corpus/index graphs.
// The Linux API runner's peak-RSS measurement reported 2583 MB when the
// 20,000-entry refresh-event-loop suite shared a process with monitoring-drain.
// Run corpus files alone with headroom above that observed peak, while keeping
// this explicit ceiling below the hosted 4 GB limit and ordinary DBs at 2560 MB.
const MAX_HEAVY_DB_BATCH_PEAK_RSS_MB = 3072;

/** Every test file the runner executes, in its stable order. */
export const listApiTestPaths = (apiRoot: string): string[] =>
  [
    ...new Bun.Glob(TEST_FILE_GLOB).scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
  ].toSorted();

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
const readModuleMockHelpers = (apiRoot: string) =>
  [
    ...new Bun.Glob(TEST_HELPER_GLOB).scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
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

/** One execution class's batches, before labelling and path selection. */
export type ComposedTestBatches = {
  isolate: boolean;
  kind: TestBatchKind;
  maxPeakRssMb: number;
  testBatches: string[][];
};

type PlanApiTestBatchesOptions = {
  executionMode?: "batched" | "measure-rss";
  apiRoot: string;
  propertyOnly: boolean;
  testPaths: readonly string[];
};

/** Classify every test file and compose the batches the runner executes. */
export const planApiTestBatches = async ({
  executionMode = "batched",
  apiRoot,
  propertyOnly,
  testPaths,
}: PlanApiTestBatchesOptions): Promise<ComposedTestBatches[]> => {
  const moduleMockHelpers = readModuleMockHelpers(apiRoot);
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

  const classifiedTests = await Promise.all(
    testPaths.map(async (testPath) => ({
      source: await Bun.file(path.join(apiRoot, testPath)).text(),
      testPath,
    })),
  );

  const regularTests: string[] = [];
  const heavyLogicTests: string[] = [];
  const dbTests: string[] = [];
  const heavyDbTests: string[] = [];
  const moduleMockTests: ModuleMockTest[] = [];
  for (const { source, testPath } of classifiedTests) {
    if (
      propertyOnly &&
      !PROPERTY_TEST_MARKERS.some((marker) => source.includes(marker))
    ) {
      continue;
    }

    const batchKind = classifyTestBatch({
      dbBacked: isDbTest(testPath, source),
      heavyDb: HEAVY_DB_SOURCE_MARKERS.some((marker) => marker.test(source)),
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
      case TEST_BATCH_KIND.heavyDb:
        heavyDbTests.push(testPath);
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
  const composed: ComposedTestBatches[] = [
    {
      isolate: false,
      kind: TEST_BATCH_KIND.regular,
      maxPeakRssMb: MAX_LOGIC_BATCH_PEAK_RSS_MB,
      testBatches: [
        ...composeTestBatches(regularSrcTests, REGULAR_TEST_BATCH_SIZE),
        ...composeTestBatches(regularEvalTests, REGULAR_TEST_BATCH_SIZE),
      ],
    },
    {
      isolate: false,
      kind: TEST_BATCH_KIND.heavyLogic,
      maxPeakRssMb: MAX_HEAVY_LOGIC_BATCH_PEAK_RSS_MB,
      testBatches: composeTestBatches(
        heavyLogicTests,
        HEAVY_LOGIC_TEST_BATCH_SIZE,
      ),
    },
    {
      isolate: false,
      kind: TEST_BATCH_KIND.heavyDb,
      maxPeakRssMb: MAX_HEAVY_DB_BATCH_PEAK_RSS_MB,
      testBatches: composeTestBatches(heavyDbTests, HEAVY_DB_TEST_BATCH_SIZE),
    },
    {
      isolate: false,
      kind: TEST_BATCH_KIND.db,
      maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
      testBatches: composeTestBatches(dbTests, dbTestBatchSize(propertyOnly)),
    },
    {
      isolate: true,
      kind: TEST_BATCH_KIND.moduleMock,
      maxPeakRssMb: MAX_DB_BATCH_PEAK_RSS_MB,
      testBatches: batchModuleMockTests(
        moduleMockTests,
        MODULE_MOCK_TEST_BATCH_SIZE,
      ),
    },
  ];
  // A solo path runs alone whatever class it lands in (a solo file that starts
  // mocking a module must not rejoin a shared batch). Splitting after
  // composition preserves mock compatibility; memory splitting only removes
  // neighbours whose combined estimates exceed the composition budget.
  for (const group of composed) {
    group.testBatches =
      executionMode === "measure-rss"
        ? group.testBatches.flat().map((file) => [file])
        : splitMemoryBoundedBatches({
            batches: splitSoloTests(group.testBatches, SOLO_TEST_PATHS),
            budgetMb: group.maxPeakRssMb,
          });
  }
  return composed;
};
