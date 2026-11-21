import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "confine-sql-close";
const lint = async (
  source: string,
  sourcePath = "apps/api/src/db/example.ts",
) => await lintSingleRule(RULE, source, { sourcePath, cwd: "scratch" });

describe(RULE, () => {
  test("rejects every raw close budget in API production, fixtures and packages", async () => {
    const source = [
      "void client.close({ timeout: 0 });",
      "void client.close({ timeout: 0.001 });",
      "void client.close({ timeout: budget });",
      "const scopeOptions = { closeTimeout: 0 };",
      "const otherScope = { closeTimeout: budget };",
    ].join("\n");
    const results = await Promise.all(
      [
        "apps/api/src/db/example.ts",
        "apps/api/src/tests/example.test.ts",
        "packages/db-load-gate/src/example.ts",
      ].map(async (lintCase, index) => {
        const sourcePath = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(source, sourcePath),
          expected: [1, 2, 3, 4, 5],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("rejects computed literal names, optional calls, casts and assignments", async () => {
    expect(
      await lint(
        [
          'void client["close"]({ ["timeout"]: 0 });',
          "void client?.close({ timeout: budget });",
          "void client.close?.({ timeout: 0.001 });",
          "void client.close(({ timeout: budget } as const));",
          'const scopeOptions = { ["closeTimeout"]: budget };',
          "void client[`close`]({ [`timeout`]: 0 });",
          "scopeOptions.closeTimeout = budget;",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("reads a close budget through destructuring without reporting it", async () => {
    expect(
      await lint(
        [
          "const { closeTimeout } = options;",
          "const { closeTimeout: renamed } = options;",
          "const supplied = { closeTimeout: renamed };",
        ].join("\n"),
      ),
    ).toEqual([3]);
  });

  test("follows stable local option and method aliases including object spreads", async () => {
    expect(
      await lint(
        [
          "const options = { timeout: budget };",
          "const alias = options;",
          "void client.close(alias);",
          "void client.close({ ...alias });",
          "const close = client.close;",
          "close(options);",
          "const cyclic = cyclic;",
          "void client.close(cyclic);",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 6]);
  });

  test("allows raw budgets only in the canonical owner", async () => {
    const source =
      "void client.close({ timeout: budget });\nconst options = { closeTimeout: 0 };";
    expect(await lint(source, "apps/api/src/db/sql-close.ts")).toEqual([]);
    expect(await lint(source, "packages/example/src/sql-close.ts")).toEqual([
      1, 2,
    ]);
    expect(await lint(source, "apps/api/src/db/sql-close.test.ts")).toEqual([
      1, 2,
    ]);
  });

  test("accepts owner helpers, driver defaults and unrelated timeouts", async () => {
    expect(
      await lint(
        [
          "void forceClosePool(client);",
          "void terminateReserved(connection);",
          "void client.close();",
          "void client.close({ unrelated: true });",
          "const unrelatedOptions = { timeout: 0 };",
          "void client.query({ timeout: 0 });",
          "const timeout = 0;",
          "void client.close({ [timeout]: 0 });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("the planted source reports zero, positive and scope budgets without suppressions", async () => {
    const source = readFileSync(
      new URL("../__fixtures__/confine-sql-close.fixture.ts", import.meta.url),
      "utf-8",
    ).replaceAll(/^\/\/ oxlint-disable-next-line .*\n/gmu, "");
    expect((await lint(source)).length).toBe(3);
  });
});
