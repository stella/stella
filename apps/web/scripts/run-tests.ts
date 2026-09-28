import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const runs = planTestRuns({ argv: Bun.argv.slice(2), pathKind, testFilesIn });
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
    // A run killed by a signal has no positive exit code of its own.
    process.exit(child.exitCode > 0 ? child.exitCode : 1);
  }
}
