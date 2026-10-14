import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";

import { isPathInside } from "@stll/portable-path";

import { createTestMutantDirectory } from "./test-mutants";

test("test mutant directories stay outside the API source tree", () => {
  const directory = createTestMutantDirectory("source-boundary-");
  try {
    const sourceRoot = path.resolve(import.meta.dir, "../..");
    expect(isPathInside(sourceRoot, directory)).toBe(false);
    expect(path.dirname(directory)).toBe(
      path.resolve(sourceRoot, "../.test-mutants"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
