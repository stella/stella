import { describe, expect, test } from "bun:test";

import {
  balanceTestFiles,
  parseScriptTestArguments,
  selectScriptTests,
  unlistedTestCommands,
  unlistedTests,
} from "./run-unlisted-script-tests";

describe("balanceTestFiles", () => {
  const weights: Record<string, number> = {
    "scripts/a.test.ts": 9,
    "scripts/b.test.ts": 5,
    "scripts/c.test.ts": 4,
    "scripts/d.test.ts": 3,
    "scripts/e.test.ts": 3,
  };
  const weightOf = (file: string) => weights[file] ?? 0;

  test("places every file exactly once, heaviest first onto the lightest group", () => {
    const groups = balanceTestFiles(Object.keys(weights), 2, weightOf);
    expect(groups).toEqual([
      ["scripts/a.test.ts", "scripts/d.test.ts"],
      ["scripts/b.test.ts", "scripts/c.test.ts", "scripts/e.test.ts"],
    ]);
    expect(groups.flat().toSorted()).toEqual(Object.keys(weights).toSorted());
  });

  test("is independent of input order", () => {
    const files = Object.keys(weights);
    expect(balanceTestFiles(files.toReversed(), 2, weightOf)).toEqual(
      balanceTestFiles(files, 2, weightOf),
    );
  });

  test("never makes empty groups", () => {
    expect(balanceTestFiles(["scripts/a.test.ts"], 3, weightOf)).toEqual([
      ["scripts/a.test.ts"],
    ]);
    expect(balanceTestFiles([], 2, weightOf)).toEqual([]);
  });

  test("splits Bun tests into one command per group with the timeout on each", () => {
    expect(
      unlistedTestCommands({
        files: ["scripts/a.test.ts", "scripts/b.test.ts", "scripts/check.sh"],
        timeout: 35_000,
        groups: 2,
        weightOf,
      }),
    ).toEqual([
      ["bun", "test", "--timeout", "35000", "scripts/a.test.ts"],
      ["bun", "test", "--timeout", "35000", "scripts/b.test.ts"],
      ["bash", "scripts/check.sh"],
    ]);
  });
});

describe("unlistedTests", () => {
  test("nested parallel commands remain listed without losing the remainder", () => {
    expect(
      unlistedTests(
        ["scripts/nested.test.ts", "scripts/unlisted.test.ts"],
        "jobs:\n  checks:\n    steps:\n      - parallel:\n          - parallel:\n              - name: Nested check\n                run: bun test scripts/nested.test.ts\n",
      ),
    ).toEqual(["scripts/unlisted.test.ts"]);
  });

  test("keeps only the tests no workflow names", () => {
    const workflowText = [
      "run: bun test scripts/listed.test.ts",
      "run: bash scripts/listed-shell.test.sh",
    ].join("\n");

    expect(
      unlistedTests(
        [
          "scripts/orphan.test.ts",
          "scripts/listed.test.ts",
          "scripts/listed-shell.test.sh",
          "scripts/orphan-shell.test.sh",
        ],
        workflowText,
      ),
    ).toEqual(["scripts/orphan-shell.test.sh", "scripts/orphan.test.ts"]);
  });

  test("does not count a test as listed because a longer name contains it", () => {
    expect(
      unlistedTests(
        ["scripts/plan.test.ts"],
        "run: bun test scripts/ci-plan.test.ts",
      ),
    ).toEqual(["scripts/plan.test.ts"]);
  });

  test("does not count a test named only in a comment as listed", () => {
    expect(
      unlistedTests(
        ["scripts/commented.test.ts"],
        "      # see scripts/commented.test.ts\n      run: bun test other",
      ),
    ).toEqual(["scripts/commented.test.ts"]);
  });
});

describe("selectScriptTests", () => {
  test("partitions depth tests away from the default runner", () => {
    const discovered = ["scripts/fast.test.ts", "scripts/depth.test.ts"];
    const depth = ["scripts/depth.test.ts"];
    expect(selectScriptTests(discovered, depth, false)).toEqual([
      "scripts/fast.test.ts",
    ]);
    expect(selectScriptTests(discovered, depth, true)).toEqual([
      "scripts/depth.test.ts",
    ]);
  });
});

describe("parseScriptTestArguments", () => {
  test("accepts the default and a positive integer timeout", () => {
    expect(parseScriptTestArguments([])).toEqual({
      type: "valid",
      timeout: undefined,
      depth: false,
    });
    expect(parseScriptTestArguments(["--timeout", "35000"])).toEqual({
      type: "valid",
      timeout: 35_000,
      depth: false,
    });
  });

  test("accepts depth mode in either position", () => {
    expect(
      parseScriptTestArguments(["--depth", "--timeout", "120000"]),
    ).toEqual({
      type: "valid",
      timeout: 120_000,
      depth: true,
    });
    expect(
      parseScriptTestArguments(["--timeout", "120000", "--depth"]),
    ).toEqual({
      type: "valid",
      timeout: 120_000,
      depth: true,
    });
  });

  test.each([
    [["--depth", "--depth"], "--depth may be supplied once"],
    [["--unknown"], "unknown argument"],
    [["--timeout"], "requires a positive integer"],
    [["--timeout", "0"], "requires a positive integer"],
    [["--timeout", "-1"], "requires a positive integer"],
    [["--timeout", "1.5"], "requires a positive integer"],
    [["--timeout", "9007199254740992"], "requires a positive integer"],
    [["--timeout", "1", "--timeout", "2"], "may be supplied once"],
  ] as const)("rejects %j", (args, message) => {
    expect(parseScriptTestArguments(args)).toEqual({
      type: "invalid",
      message: expect.stringContaining(message),
    });
  });
});

describe("unlistedTestCommands", () => {
  test("forwards the timeout to all Bun tests and preserves shell invocations", () => {
    expect(
      unlistedTestCommands({
        files: [
          "scripts/first.test.ts",
          "scripts/second.test.ts",
          "scripts/check.sh",
        ],
        timeout: 35_000,
      }),
    ).toEqual([
      [
        "bun",
        "test",
        "--timeout",
        "35000",
        "scripts/first.test.ts",
        "scripts/second.test.ts",
      ],
      ["bash", "scripts/check.sh"],
    ]);
  });

  test("preserves the default Bun invocation when timeout is absent", () => {
    expect(
      unlistedTestCommands({
        files: ["scripts/first.test.ts", "scripts/check.sh"],
        timeout: undefined,
      }),
    ).toEqual([
      ["bun", "test", "scripts/first.test.ts"],
      ["bash", "scripts/check.sh"],
    ]);
  });
});
