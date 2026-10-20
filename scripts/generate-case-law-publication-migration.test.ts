import { expect, test } from "bun:test";

import { bunExecutable } from "../packages/scripts/src/bun-executable";

test("the recorded publication policy follows its owner", () => {
  const result = Bun.spawnSync(
    [
      bunExecutable(),
      "scripts/generate-case-law-publication-migration.ts",
      "--check",
    ],
    { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
