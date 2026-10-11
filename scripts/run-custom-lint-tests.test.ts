import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { customLintRunnerViolations } from "./check-custom-lint-test-runners";
import { customLintTestCommand } from "./run-custom-lint-tests";

for (const args of [
  [],
  ["--parallel"],
  ["-t", "case"],
  ["./.oxlint-plugins/__tests__/fixture.test.ts"],
]) {
  test(`the runner retains its budget for ${JSON.stringify(args)}`, () => {
    const command = customLintTestCommand(args);
    expect(command.slice(0, 4)).toEqual([
      process.execPath,
      "test",
      "--timeout",
      "30000",
    ]);
    expect(command.slice(4)).toEqual(
      args.some((arg) => arg.endsWith(".test.ts"))
        ? args
        : [...args, "./.oxlint-plugins/__tests__"],
    );
  });
}

test("caller flags cannot replace the shared budget", () => {
  for (const args of [["--timeout", "5000"], ["--timeout=5000"]]) {
    expect(() => customLintTestCommand(args)).toThrow(
      "owned by the shared runner",
    );
  }
});

const TARGET = "./.oxlint-plugins/__tests__/fixture.test.ts";
for (const [filename, source] of [
  ["package.json", JSON.stringify({ scripts: { test: `bun test ${TARGET}` } })],
  ["scripts/check.sh", `bun test --parallel ${TARGET}`],
  [
    "scripts/check.sh",
    `find .oxlint-plugins/__tests__ -name '*.test.ts' | xargs bun test`,
  ],
  ["scripts/check.sh", `bun --bun test .oxlint-plugins/__tests__/*.test.ts`],
  ["ci.yml", `jobs:\n  check:\n    steps:\n      - run: bun test ${TARGET}`],
  [
    "scripts/check.ts",
    `Bun.spawnSync([process.execPath, "test", "${TARGET}"]);`,
  ],
  [
    "scripts/check.ts",
    `const args = ["test", "${TARGET}"]; execFileSync("bun", args);`,
  ],
  [
    "scripts/check.ts",
    `const target = "${TARGET}"; Bun.spawnSync([process.execPath, "test", target]);`,
  ],
  [
    "scripts/check.ts",
    `Bun.spawn({ cmd: [process.execPath, "test", "${TARGET}"] });`,
  ],
] as const) {
  test(`${filename} rejects a planted runner bypass`, () => {
    expect(customLintRunnerViolations(filename, source)).toEqual([
      `${filename}: run custom lint tests through scripts/run-custom-lint-tests.ts`,
    ]);
  });
}

test("shared commands and inert text are accepted", () => {
  expect(
    customLintRunnerViolations(
      "scripts/check.sh",
      `bun scripts/run-custom-lint-tests.ts ${TARGET}`,
    ),
  ).toEqual([]);
  expect(
    customLintRunnerViolations("scripts/check.sh", `# bun test ${TARGET}`),
  ).toEqual([]);
  expect(
    customLintRunnerViolations(
      "scripts/check.ts",
      `const text = 'bun test ${TARGET}';`,
    ),
  ).toEqual([]);
});

// Both files must outlive Bun's 5s default; a preload-only budget protects one file.
test("the CLI budget reaches every sequential file and its removal fails", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "custom-lint-budget-"));
  try {
    const files = ["first", "second"].map((name) => {
      const filename = path.join(directory, `${name}.test.ts`);
      writeFileSync(
        filename,
        `import { test, expect } from "bun:test"; test("${name}", async () => { await Bun.sleep(5100); expect(true).toBe(true); });`,
      );
      return filename;
    });
    const command = customLintTestCommand(files);
    const passing = Bun.spawnSync(command);
    expect(passing.exitCode).toBe(0);
    expect(passing.stderr.toString()).toContain("2 pass");
    const mutation = Bun.spawnSync([process.execPath, "test", ...files]);
    expect(mutation.exitCode).toBe(1);
    expect(mutation.stderr.toString()).toContain("timed out after 5000ms");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
