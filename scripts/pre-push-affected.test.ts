import { describe, expect, test } from "bun:test";

import {
  parsePrePushArgs,
  prePushCommands,
  rootScriptTests,
} from "./pre-push-affected";

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
