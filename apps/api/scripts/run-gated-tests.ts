import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { buildApiTestCommand } from "./api-test-command";

type GatedTestScript = keyof typeof packageJson.ciGateTestRunners;

type RunGatedTestsOptions = {
  // Service connection variables the suites read; the run fails fast without
  // them instead of skipping every suite.
  requiredEnv: readonly string[];
  script: GatedTestScript;
};

const apiRoot = path.resolve(import.meta.dir, "..");

/**
 * Runs every test file that declares the script's gate, with the gate set.
 * Discovery reads the same `ciGateTestRunners` declaration the CI coverage
 * guard reads, so a gated suite cannot be left out of its runner.
 */
export const runGatedTests = async ({
  requiredEnv,
  script,
}: RunGatedTestsOptions): Promise<number> => {
  const runner = packageJson.ciGateTestRunners[script];
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`${missing.join(", ")} required for ${script}.`);
    return 1;
  }

  const discoveredTests = [
    ...new Bun.Glob(runner.testFileGlob).scanSync({
      cwd: apiRoot,
      onlyFiles: true,
    }),
  ];
  const testFiles = (
    await Promise.all(
      discoveredTests.map(async (testFile) => ({
        isGated: (await Bun.file(path.join(apiRoot, testFile)).text()).includes(
          runner.gate,
        ),
        testFile,
      })),
    )
  )
    .filter(({ isGated }) => isGated)
    .map(({ testFile }) => testFile)
    .toSorted();

  if (testFiles.length === 0) {
    console.error(`No test files declaring ${runner.gate} were discovered.`);
    return 1;
  }

  console.log(`Running ${String(testFiles.length)} ${runner.gate} test files.`);
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

  return await testProcess.exited;
};
