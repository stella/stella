import { readFileSync } from "node:fs";
import path from "node:path";

const PROPERTY_FLAG = "--property";
const TEST_FILE_GLOB = "src/**/*.test.{ts,tsx}";
// Non-test helper modules live here; some install a module mock at import.
const TEST_HELPER_GLOB = "src/tests/**/*.ts";
const MODULE_MOCK_PATTERN = /\bmock\.module\s*\(/u;
const PROPERTY_TEST_MARKER = "fc.assert";

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

const regularTests: string[] = [];
const moduleMockTests: string[] = [];
for (const { source, testPath } of classifiedTests) {
  if (propertyOnly && !source.includes(PROPERTY_TEST_MARKER)) {
    continue;
  }

  if (installsModuleMock(source)) {
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
  return await child.exited;
};

const regularExitCode = await runTests(regularTests, false);
if (regularExitCode !== 0) {
  process.exit(regularExitCode);
}

process.exit(await runTests(moduleMockTests, true));
