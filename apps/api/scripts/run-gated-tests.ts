import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import packageJson from "../package.json" with { type: "json" };
import { buildApiTestCommand } from "./api-test-command";
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
  // An explicitly selected slice may also include ungated database suites.
  testFiles?: readonly string[];
  runnerArguments?: readonly string[];
};

const apiRoot = path.resolve(import.meta.dir, "..");

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
  testFiles: scopedTestFiles,
  runnerArguments = Bun.argv.slice(2),
}: RunGatedTestsOptions): Promise<number> => {
  const runner = packageJson.ciGateTestRunners[script];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`${missing.join(", ")} required for ${script}.`);
    return 1;
  }

  const discoveredGatedFiles =
    scopedTestFiles ??
    (await discoverGatedTestFiles({
      apiRoot,
      gate: runner.gate,
      testFileGlob: runner.testFileGlob,
    }));

  const { bunArguments, patterns } = partitionRunnerArguments(
    runnerArguments.filter((argument) => argument !== "--list-files"),
  );
  const selectedPaths = selectTestPaths(
    discoveredGatedFiles,
    normalizeAbsoluteTestPatterns(patterns, apiRoot),
  );
  const testFiles = discoveredGatedFiles.filter(
    (testFile) => selectedPaths === null || selectedPaths.has(testFile),
  );

  if (testFiles.length === 0) {
    console.error(`No test files matched the ${script} selection.`);
    return 1;
  }

  // Inspect the exact selection without generators or service connections.
  if (runnerArguments.includes("--list-files")) {
    console.log(testFiles.join("\n"));
    return 0;
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

  console.log(`Running ${String(testFiles.length)} ${script} test files.`);
  const testProcess = Bun.spawn({
    cmd: buildApiTestCommand({
      bunExecutable: process.execPath,
      bunRuntimeArguments: [],
      testArguments: [
        // Keep suites isolated from one another's connection pools. Tests that
        // exercise concurrency still do so internally, without runner-load
        // races.
        "--max-concurrency=1",
        "--preload",
        "./src/tests/setup-env.ts",
        ...bunArguments,
      ],
      testFiles,
    }),
    cwd: apiRoot,
    env: {
      ...process.env,
      [runner.gate]: runner.gateValue,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  await testProcess.exited;
  return childExitStatus(testProcess);
};
