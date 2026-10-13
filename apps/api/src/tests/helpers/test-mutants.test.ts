import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";

import { createTestMutantDirectory } from "./test-mutants";

test("test mutant directories stay outside the API source tree", () => {
  const directory = createTestMutantDirectory("source-boundary-");
  try {
    const sourceRoot = path.resolve(import.meta.dir, "../..");
    expect(path.relative(sourceRoot, directory).split(path.sep).at(0)).toBe(
      "..",
    );
    expect(path.dirname(directory)).toBe(
      path.resolve(sourceRoot, "../.test-mutants"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
