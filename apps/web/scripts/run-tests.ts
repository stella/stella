import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { planTestRuns } from "./test-run-plan";
import type { PathKind } from "./test-run-plan";

const WEB_ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const TEST_FILE_GLOB = new Bun.Glob("**/*.test.{ts,tsx}");

const pathKind = (arg: string): PathKind => {
  try {
    const stats = statSync(path.resolve(WEB_ROOT_PATH, arg));
    return stats.isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
};

const testFilesIn = (directory: string): readonly string[] =>
  [
    ...TEST_FILE_GLOB.scanSync({
      cwd: path.resolve(WEB_ROOT_PATH, directory),
    }),
  ]
    .filter((file) => !file.split(path.sep).includes("node_modules"))
    .map((file) => path.join(directory, file))
    .toSorted();

const { runs, missingPaths } = planTestRuns({
  argv: Bun.argv.slice(2),
  pathKind,
  testFilesIn,
});
if (missingPaths.length > 0) {
  console.error(`No such test path: ${missingPaths.join(", ")}`);
  process.exit(1);
}
if (runs.length === 0) {
  console.error("No test files matched the given paths.");
  process.exit(1);
}

for (const run of runs) {
  const child = Bun.spawnSync(["bun", "test", ...run.args], {
    cwd: WEB_ROOT_PATH,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!child.success) {
    console.error(`The ${run.label} tests failed.`);
    process.exit(childExitStatus(child));
  }
}
