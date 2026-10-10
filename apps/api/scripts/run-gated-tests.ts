import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import packageJson from "../package.json" with { type: "json" };
import { buildApiTestCommand } from "./api-test-command";
import { parseGatedTestSelection } from "./gated-test-selection";
import {
  mergeJunitReports,
  planBatchReporterArguments,
} from "./junit-batch-report";
import { isolateSharedTableDdlTests } from "./postgres-test-plan";
import {
  normalizeAbsoluteTestPatterns,
  partitionRunnerArguments,
  selectTestPaths,
} from "./test-path-filters";

type GatedTestScript = keyof typeof packageJson.ciGateTestRunners;

type RunGatedTestsOptions = {
  // Service connection variables the suites read; the run fails fast without
  // them instead of skipping every suite.
  requiredEnv: readonly string[];
  script: GatedTestScript;
  selection?: string | undefined;
  exclusiveTestPaths?: ReadonlySet<string> | undefined;
  validateTestPlan?:
    | ((apiRoot: string, testPaths: readonly string[]) => Promise<void>)
    | undefined;
};

const apiRoot = path.resolve(import.meta.dir, "..");

type RunTestBatchesOptions = {
  batches: readonly (readonly string[])[];
  bunArguments: readonly string[];
  cwd: string;
  gate: string;
  gateValue: string;
  spawn?: (options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  }) => {
    exited: Promise<number>;
    exitCode: number | null;
    signalCode: string | number | null;
  };
};

export const runTestBatches = async ({
  batches,
  bunArguments,
  cwd,
  gate,
  gateValue,
  spawn = (options) => Bun.spawn(options),
}: RunTestBatchesOptions): Promise<number> => {
  const hasReporterOutfile = bunArguments.some(
    (argument) =>
      argument === "--reporter-outfile" ||
      argument.startsWith("--reporter-outfile="),
  );
  const temporaryDirectory = hasReporterOutfile
    ? await mkdtemp(path.join(os.tmpdir(), "stella-junit-"))
    : "";
  const reporterPlan = planBatchReporterArguments(
    bunArguments,
    batches.length,
    temporaryDirectory,
  );
  let firstFailure = 0;

  try {
    for (const [index, testBatch] of batches.entries()) {
      const testProcess = spawn({
        cmd: buildApiTestCommand({
          bunExecutable: process.execPath,
          bunRuntimeArguments: [],
          testArguments: [
            // Keep suites isolated from one another's connection pools. Tests
            // that exercise concurrency still do so internally, without
            // runner-load races.
            "--max-concurrency=1",
            "--preload",
            "./src/tests/setup-env.ts",
            ...(reporterPlan.argumentsByBatch.at(index) ?? []),
          ],
          testFiles: testBatch,
        }),
        cwd,
        env: { ...process.env, [gate]: gateValue },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await testProcess.exited;
      const status = childExitStatus(testProcess);
      if (firstFailure === 0 && status !== 0) {
        firstFailure = status;
      }
    }

    if (reporterPlan.type === "file") {
      const reports = await Promise.all(
        reporterPlan.batchOutfiles.map(async (batchOutfile) => ({
          source: batchOutfile,
          xml: await Bun.file(batchOutfile).text(),
        })),
      );
      // The test processes resolved a relative outfile against their cwd.
      await Bun.write(
        path.resolve(cwd, reporterPlan.requestedOutfile),
        mergeJunitReports(reports),
      );
    }
    return firstFailure;
  } finally {
    if (temporaryDirectory !== "") {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
};

type DiscoverGatedTestFilesOptions = {
  apiRoot: string;
  testFileGlob: string;
  gate: string;
};

export const discoverGatedTestFiles = async ({
  apiRoot: testRoot,
  testFileGlob,
  gate,
}: DiscoverGatedTestFilesOptions) => {
  const files = [
    ...new Bun.Glob(testFileGlob).scanSync({ cwd: testRoot, onlyFiles: true }),
  ];
  const sources = await Promise.all(
    files.map(async (testFile) => ({
      testFile,
      isGated: (await Bun.file(path.join(testRoot, testFile)).text()).includes(
        gate,
      ),
    })),
  );
  return sources
    .filter(({ isGated }) => isGated)
    .map(({ testFile }) => testFile)
    .toSorted();
};

/**
 * Runs every test file that declares the script's gate, with the gate set.
 * Discovery reads the same `ciGateTestRunners` declaration the CI coverage
 * guard reads, so a gated suite cannot be left out of its runner.
 */
export const runGatedTests = async ({
  requiredEnv,
  script,
  selection,
  exclusiveTestPaths = new Set(),
  validateTestPlan,
}: RunGatedTestsOptions): Promise<number> => {
  const runner = packageJson.ciGateTestRunners[script];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`${missing.join(", ")} required for ${script}.`);
    return 1;
  }

  const discoveredGatedFiles = await discoverGatedTestFiles({
    apiRoot,
    gate: runner.gate,
    testFileGlob: runner.testFileGlob,
  });

  const plan = parseGatedTestSelection(selection, discoveredGatedFiles);
  if (plan.mode === "none") {
    console.log(`No affected ${runner.gate} test files.`);
    return 0;
  }
  const plannedFiles =
    plan.mode === "selected" ? plan.files : discoveredGatedFiles;
  await validateTestPlan?.(apiRoot, discoveredGatedFiles);

  const { bunArguments, patterns } = partitionRunnerArguments(
    Bun.argv.slice(2),
  );
  const selectedPaths = selectTestPaths(
    plannedFiles,
    normalizeAbsoluteTestPatterns(patterns, apiRoot),
  );
  const testFiles = plannedFiles.filter(
    (testFile) => selectedPaths === null || selectedPaths.has(testFile),
  );

  if (testFiles.length === 0) {
    console.error(
      `No test files declaring ${runner.gate} matched the selection.`,
    );
    return 1;
  }

  // The same derived sources the package `test` script generates first: the
  // suites import the capability runtime, which is never committed.
  for (const { generator, cwd } of [
    {
      generator: "codegen:runtime",
      cwd: path.resolve(apiRoot, "../../packages/cli"),
    },
    { generator: "generate:capability-runtime", cwd: apiRoot },
  ]) {
    const generationProcess = Bun.spawn({
      cmd: [process.execPath, "run", generator],
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await generationProcess.exited;
    const generationStatus = childExitStatus(generationProcess);
    if (generationStatus !== 0) {
      return generationStatus;
    }
  }

  const batches = isolateSharedTableDdlTests(testFiles, exclusiveTestPaths);
  console.log(
    `Running ${String(testFiles.length)} ${runner.gate} test files in ${String(batches.length)} process batches.`,
  );
  return runTestBatches({
    batches,
    bunArguments,
    cwd: apiRoot,
    gate: runner.gate,
    gateValue: runner.gateValue,
  });
};
