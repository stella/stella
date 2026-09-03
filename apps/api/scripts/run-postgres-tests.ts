import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { buildApiTestCommand } from "./api-test-command";

const POSTGRES_TEST_RUNNER = packageJson.ciGateTestRunners["test:postgres"];
const POSTGRES_TEST_MARKER = POSTGRES_TEST_RUNNER.gate;

const apiRoot = path.resolve(import.meta.dir, "..");

if (!process.env["DATABASE_URL"]) {
  console.error("DATABASE_URL is required for Postgres-gated tests.");
  process.exit(1);
}

const discoveredTests = [
  ...new Bun.Glob(POSTGRES_TEST_RUNNER.testFileGlob).scanSync({
    cwd: apiRoot,
    onlyFiles: true,
  }),
];
const testFiles = (
  await Promise.all(
    discoveredTests.map(async (testFile) => ({
      isPostgresTest: (
        await Bun.file(path.join(apiRoot, testFile)).text()
      ).includes(POSTGRES_TEST_MARKER),
      testFile,
    })),
  )
)
  .filter(({ isPostgresTest }) => isPostgresTest)
  .map(({ testFile }) => testFile)
  .sort();

if (testFiles.length === 0) {
  console.error(
    `No test files declaring ${POSTGRES_TEST_MARKER} were discovered.`,
  );
  process.exit(1);
}

console.log(`Running ${String(testFiles.length)} Postgres-gated test files.`);
const testProcess = Bun.spawn({
  cmd: buildApiTestCommand({
    bunExecutable: process.execPath,
    bunRuntimeArguments: [],
    testArguments: [
      // Keep suites isolated from one another's connection pools. Tests that
      // exercise concurrency still do so internally, without runner-load races.
      "--max-concurrency=1",
      "--preload",
      "./src/tests/setup-env.ts",
    ],
    testFiles,
  }),
  cwd: apiRoot,
  env: {
    ...process.env,
    [POSTGRES_TEST_MARKER]: POSTGRES_TEST_RUNNER.gateValue,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await testProcess.exited;
