import assert from "node:assert";
import { readdirSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

export const E2E_SHARD_COUNT = 2;
const SPEC_ROOT = "apps/web/e2e/specs";

// Playwright's default `testMatch`: every `.spec` and `.test` script file.
export const isPlaywrightTestFile = (file: string) =>
  /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file);

export const compareCodeUnit = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const walk = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(child));
    } else if (entry.isFile() && isPlaywrightTestFile(child)) {
      files.push(child);
    }
  }
  return files;
};

export const listE2eSpecs = (root = process.cwd()): string[] =>
  walk(path.join(root, SPEC_ROOT))
    .map((file) => repoRelativePath(root, file))
    .toSorted(compareCodeUnit);

export const allE2eShards = (): number[] =>
  Array.from({ length: E2E_SHARD_COUNT }, (_, index) => index + 1);

export const allE2eMatrix = (): { shard: (number | string)[] } => ({
  shard: [...allE2eShards(), "network-baseline"],
});

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command === "all") {
    process.stdout.write(JSON.stringify(allE2eMatrix()));
  } else {
    assert.fail(`Unknown e2e shard command: ${command ?? "missing"}`);
  }
}
