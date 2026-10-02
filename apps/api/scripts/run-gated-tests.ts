import { panic } from "better-result";
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

type SelectGatedTestFilesOptions = {
  discoveredGatedFiles: readonly string[];
  requestedFiles: readonly string[];
  root?: string;
};

type SelectGatedTestFilesResult =
  | { type: "selected"; files: string[] }
  | { type: "invalid_file"; file: string };

export const selectGatedTestFiles = ({
  discoveredGatedFiles,
  requestedFiles,
  root = apiRoot,
}: SelectGatedTestFilesOptions): SelectGatedTestFilesResult => {
  if (requestedFiles.length === 0) {
    return { type: "selected", files: [...discoveredGatedFiles].toSorted() };
  }

  const discoveredByPath = new Map(
    discoveredGatedFiles.map((file) => [path.resolve(root, file), file]),
  );
  const selected = new Set<string>();
  for (const requestedFile of requestedFiles) {
    const absolutePath = path.resolve(root, requestedFile);
    const discoveredFile = discoveredByPath.get(absolutePath);
    if (!discoveredFile) {
      return { type: "invalid_file", file: requestedFile };
    }
    selected.add(discoveredFile);
  }

  return { type: "selected", files: [...selected].toSorted() };
};

/**
 * Runs discovered test files that declare the script's gate, with the gate set.
 * Discovery reads the same `ciGateTestRunners` declaration the CI coverage
 * guard reads, so a gated suite cannot be left out of the default run.
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
  const discoveredGatedFiles = (
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

  const selection = selectGatedTestFiles({
    discoveredGatedFiles,
    requestedFiles: process.argv.slice(2),
  });
  switch (selection.type) {
    case "invalid_file":
      console.error(`Not a discovered gated test file: ${selection.file}`);
      return 1;
    case "selected":
      break;
    default: {
      selection satisfies never;
      return panic("Unhandled gated test selection");
    }
  }
  const testFiles = selection.files;

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
