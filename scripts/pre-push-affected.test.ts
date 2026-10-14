import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parsePrePushArgs,
  PRE_PUSH_EXIT,
  prePushCommands,
  rootScriptTests,
  TOTAL_TIME_CAP_MS,
} from "./pre-push-affected";

const script = path.join(import.meta.dirname, "pre-push-affected.ts");

describe("pre-push affected checks", () => {
  test("selects changed root script tests and the tests beside changed scripts", () => {
    const present = new Set([
      "scripts/ratchet.test.ts",
      "scripts/ci-plan.test.ts",
    ]);
    expect(
      rootScriptTests(
        [
          "scripts/ratchet.ts",
          "scripts/ci-plan.test.ts",
          "scripts/no-test-here.ts",
          "scripts/nested/tool.ts",
          "apps/api/src/index.ts",
          "scripts/ratchet.test.ts",
        ],
        (file) => present.has(file),
      ),
    ).toEqual(["scripts/ci-plan.test.ts", "scripts/ratchet.test.ts"]);
  });

  test("generates first, then runs the affected code check, then script tests", () => {
    expect(
      prePushCommands({
        base: "origin/main",
        scriptTests: ["scripts/a.test.ts"],
      }),
    ).toEqual([
      ["bun", "run", "generate"],
      [
        "bun",
        "scripts/code-check-affected.ts",
        "--base",
        "origin/main",
        "--skip-full-fallback",
      ],
      ["bun", "test", "--timeout", "35000", "scripts/a.test.ts"],
    ]);
  });

  test("runs no test command when no root script test is affected", () => {
    expect(
      prePushCommands({ base: "origin/main", scriptTests: [] }),
    ).toHaveLength(2);
  });

  test("a missing base ref means the checks could not run, not that they failed", () => {
    const result = Bun.spawnSync(
      ["bun", script, "--base", "refs/missing/pre-push-base", "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(PRE_PUSH_EXIT.unavailable);
    expect(result.stderr.toString()).toContain("git merge-base");
  });

  test("a push with no changes against its base passes without running checks", () => {
    const result = Bun.spawnSync(["bun", script, "--base", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(PRE_PUSH_EXIT.passed);
    expect(result.stdout.toString()).toBe(
      "pre-push affected: no changes against the base\n",
    );
  });

  test("the total time cap is ten minutes", () => {
    expect(TOTAL_TIME_CAP_MS).toBe(600_000);
  });

  test("parses the base and dry-run flags and rejects anything else", () => {
    expect(parsePrePushArgs([])).toEqual({
      base: "origin/main",
      dryRun: false,
    });
    expect(parsePrePushArgs(["--base", "main", "--dry-run"])).toEqual({
      base: "main",
      dryRun: true,
    });
    expect(() => parsePrePushArgs(["--base"])).toThrow(
      "--base requires a git ref",
    );
    expect(() => parsePrePushArgs(["--fast"])).toThrow(
      "Unknown argument: --fast",
    );
  });
});
