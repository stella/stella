import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import path from "node:path";

import { printError } from "@stll/errors";
import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";
import { runOwnedTestProcess } from "@stll/scripts/src/run-owned-test-process";

import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { buildApiTestCommand } from "./api-test-command";
import { hasPropertyTest, listApiTestPaths, TEST_ROOTS } from "./api-test-plan";
import { isDbTest } from "./test-batch-plan";
import {
  acquireCurrentSnapshot,
  exitAfterSnapshotFailure,
  SnapshotBuildError,
  snapshotCacheDir,
  snapshotDigest,
  snapshotKey,
} from "./test-db-snapshot-cache";
import {
  API_TEST_SHARD_ENV,
  restrictApiTestFiles,
  selectApiTestFiles,
} from "./test-file-shards";
import { partitionRunnerArguments, selectTestPaths } from "./test-path-filters";
import {
  API_TEST_DURATIONS_FILE_ENV,
  API_TEST_DURATIONS_HASH_ENV,
  assertTestDurationsIdentity,
  loadTestDurationWeights,
} from "./test-timings";
import { deriveApiTestWorkerCount } from "./test-worker-count";

// Bun runs the suite: `--parallel` workers give every file a fresh global and
// module registry, and `--update-timings` records each file's duration for the
// next plan (scripts/refresh-test-durations.ts keeps a median per file).

const PROPERTY_FLAG = "--property";
const TEST_ROOT_SET = new Set<string>(TEST_ROOTS);
const STRAY_TEST_FILE_GLOB = "**/*.test.{ts,tsx}";
// Mirrors PGLITE_TEST_SNAPSHOT_ENV in src/tests/pglite-test-db.ts; a
// literal here keeps the runner from importing the whole API schema graph.
const PGLITE_TEST_SNAPSHOT_ENV = "PGLITE_TEST_SNAPSHOT";

const apiRoot = path.resolve(import.meta.dir, "..");
const preloadPath = path.join(apiRoot, "src/tests/setup-env.ts");
const runnerArguments = Bun.argv.slice(2);
const propertyOnly = runnerArguments.includes(PROPERTY_FLAG);

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
    `Test files outside the runner roots (${TEST_ROOTS.join(", ")}) never run:\n  ${strayTestPaths.join("\n  ")}\nMove the file under a root, or add its directory to TEST_ROOTS in apps/api/scripts/api-test-plan.ts.`,
  );
  process.exit(1);
}

const allTestPaths = restrictApiTestFiles(
  listApiTestPaths(apiRoot),
  process.env["API_TEST_FILES"],
);
const durations = loadTestDurationWeights({
  files: allTestPaths,
  path: process.env[API_TEST_DURATIONS_FILE_ENV],
});
// Every shard partitions the same list by the same planned durations; the
// longest-first bins keep each shard non-empty and balanced.
const { testPaths: shardPaths, shard } = selectApiTestFiles({
  files: allTestPaths,
  durations,
  shardValue: process.env[API_TEST_SHARD_ENV],
});
if (shard !== null) {
  assertTestDurationsIdentity({
    path: process.env[API_TEST_DURATIONS_FILE_ENV],
    hash: process.env[API_TEST_DURATIONS_HASH_ENV],
  });
  console.log(
    `API test shard ${shard.index}/${shard.count}: ${shardPaths.length}/${allTestPaths.length} files`,
  );
}

// A positional pattern narrows the file list rather than joining it: Bun ORs
// positional filters, so passing a pattern beside the explicit file list
// would run the whole list again.
const { bunArguments, patterns } = partitionRunnerArguments(
  runnerArguments.filter((argument) => argument !== PROPERTY_FLAG),
);
const selectedPaths = selectTestPaths(shardPaths, patterns);
const sources = new Map(
  shardPaths
    .filter((testPath) => selectedPaths?.has(testPath) ?? true)
    .map((testPath) => [
      testPath,
      readFileSync(path.join(apiRoot, testPath), "utf-8"),
    ]),
);
if (sources.size === 0) {
  console.error(`No test files match: ${patterns.join(", ")}`);
  process.exit(1);
}
const testPaths = [...sources.keys()].filter(
  (testPath) => !propertyOnly || hasPropertyTest(sources.get(testPath) ?? ""),
);
if (testPaths.length === 0) {
  console.log("No property tests in this selection.");
  process.exit(0);
}

// The planned durations become Bun's timings input, so each `--parallel`
// worker starts with its slowest file.
const workDirectory = mkdtempSync(path.join(tmpdir(), "stella-api-tests-"));
process.on("exit", () => {
  rmSync(workDirectory, { recursive: true, force: true });
});
const plannedTimingsPath = path.join(workDirectory, "planned-timings.json");
writeFileSync(
  plannedTimingsPath,
  JSON.stringify({
    version: 1,
    files: Object.fromEntries(
      testPaths.map((file) => [
        file,
        Math.round((durations[file] ?? 0) * 1000),
      ]),
    ),
  }),
);

const runSnapshotBuilder = async (snapshotPath: string): Promise<void> => {
  console.log("Building the PGlite test-database snapshot ...");
  const exitCode = await runOwnedTestProcess({
    command: [
      process.execPath,
      path.join(apiRoot, "scripts/build-pglite-snapshot.ts"),
      snapshotPath,
    ],
    cwd: apiRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (exitCode !== 0) {
    throw new SnapshotBuildError({
      message: "PGlite snapshot build failed; aborting the test run.",
      exitCode,
    });
  }
};

const buildPrivateSnapshot = async (): Promise<string> => {
  const snapshotPath = path.join(workDirectory, "pglite-test-snapshot.tar");
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
  const exitCode = await runOwnedTestProcess({
    command: ["tar", "-tf", snapshotPath],
    stdout: "ignore",
    stderr: "ignore",
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
      signal: new AbortController().signal,
    });
    if (result.status === "hit") {
      process.on("exit", result.snapshot.release);
      return result.snapshot.path;
    }
    console.error(
      `PGlite snapshot cache unavailable (${result.reason}); building privately.`,
    );
  } catch (error) {
    if (error instanceof SnapshotBuildError) {
      throw error;
    }
    printError("PGlite snapshot cache unavailable; building privately.", error);
  }
  return await buildPrivateSnapshot();
};

const testProcessEnv: Record<string, string | undefined> = {
  ...process.env,
  [PROPERTY_TEST_TIMEOUT_BASE_MS_ENV]: String(API_TEST_TIMEOUT_MS),
};
// Only a selection with a DB-backed file boots PGlite, so a run of logic
// test files skips the snapshot build.
if (
  testPaths.some((testPath) => isDbTest(testPath, sources.get(testPath) ?? ""))
) {
  try {
    testProcessEnv[PGLITE_TEST_SNAPSHOT_ENV] = await buildTestDbSnapshot();
  } catch (error) {
    exitAfterSnapshotFailure(error);
  }
}

const artifactDirectory = process.env["API_TEST_ARTIFACT_DIR"];
const reportArguments =
  artifactDirectory === undefined || artifactDirectory === ""
    ? []
    : [
        "--reporter=junit",
        `--reporter-outfile=${path.join(artifactDirectory, "junit.xml")}`,
      ];
process.exitCode = await runOwnedTestProcess({
  command: buildApiTestCommand({
    bunExecutable: process.execPath,
    // `--no-orphans` takes the workers down when this runner is stopped.
    bunRuntimeArguments: ["--smol", "--no-orphans"],
    testArguments: [
      "--preload",
      preloadPath,
      // One core stays free for the coordinator. The memory bound also keeps
      // concurrently scheduled heavy PGlite suites within physical memory.
      `--parallel=${deriveApiTestWorkerCount({
        availableParallelism: availableParallelism(),
        totalMemoryBytes: totalmem(),
      })}`,
      `--timings=${plannedTimingsPath}`,
      ...reportArguments,
      ...bunArguments,
    ],
    testFiles: testPaths,
  }),
  cwd: apiRoot,
  env: testProcessEnv,
  stdout: "inherit",
  stderr: "inherit",
});
