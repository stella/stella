import path from "node:path";

const PROPERTY_FLAG = "--property";
const TEST_FILE_GLOB = "src/**/*.test.{ts,tsx}";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/;
const PROPERTY_TEST_MARKER = "fc.assert";

const apiRoot = path.resolve(import.meta.dir, "..");
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

const regularTests: string[] = [];
const moduleMockTests: string[] = [];
for (const { source, testPath } of classifiedTests) {
  if (propertyOnly && !source.includes(PROPERTY_TEST_MARKER)) {
    continue;
  }

  if (MODULE_MOCK_PATTERN.test(source)) {
    moduleMockTests.push(testPath);
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

  const command = [process.execPath, "test", "--preload", preloadPath];
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
  return child.exited;
};

const regularExitCode = await runTests(regularTests, false);
if (regularExitCode !== 0) {
  process.exit(regularExitCode);
}

process.exit(await runTests(moduleMockTests, true));
