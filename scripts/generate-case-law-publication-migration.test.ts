import { expect, test } from "bun:test";

test("the recorded publication policy follows its owner", () => {
  const result = Bun.spawnSync(
    ["bun", "scripts/generate-case-law-publication-migration.ts", "--check"],
    { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
