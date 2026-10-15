import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-wallclock-assertions-in-tests";
const lint = (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "x.test.ts" });

const ELAPSED_ASSERTION =
  "expect(performance.now() - start).toBeLessThan(100);";

describe(RULE, () => {
  test("rejects all ordered elapsed matchers, including modifiers", async () => {
    expect(
      await lint(
        [
          'import { expect } from "bun:test";',
          "const start = performance.now();",
          ELAPSED_ASSERTION,
          "expect(performance.now() - start).toBeLessThanOrEqual(100);",
          "expect(performance.now() - start).not.toBeGreaterThan(100);",
          "expect(performance.now() - start).resolves.toBeGreaterThanOrEqual(100);",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6]);
  });

  test("follows clock, timestamp, elapsed, and expect aliases", async () => {
    expect(
      await lint(
        [
          'import { expect as check } from "bun:test";',
          "const { now: read } = globalThis.performance;",
          "const started = read();",
          "const startAlias = started;",
          "let ended; ended = read();",
          "const elapsed = ended - startAlias;",
          "const seconds = elapsed / 1000;",
          "const verify = check;",
          "verify(seconds).toBeLessThan(1);",
          "expect(new globalThis.Date() - new Date()).toBeGreaterThan(0);",
          "expect(Temporal.Now.instant() - Temporal.Now.instant()).toBeLessThan(1);",
        ].join("\n"),
      ),
    ).toEqual([9, 10, 11]);
  });

  test("follows numeric conversions of ambient Date values", async () => {
    expect(
      await lint(
        [
          "const start = new Date().getTime();",
          "const end = new Date();",
          "expect(end.valueOf() - start).toBeLessThan(100);",
          "expect(new Date(0).getTime() - new Date(0).getTime()).toBeLessThan(1);",
        ].join("\n"),
      ),
    ).toEqual([3]);
  });

  test("reports ratios of timings even outside assertions", async () => {
    expect(
      await lint(
        [
          "const start = Date.now();",
          "const first = Date.now() - start;",
          "const second = performance.now() - performance.now();",
          "const ratio = first / second;",
          "expect(first / second).toBeLessThan(2);",
          "const rawRatio = Date.now() / performance.now();",
          "const ordinaryDivision = first / 1000;",
          "void [ratio, rawRatio, ordinaryDivision];",
        ].join("\n"),
      ),
    ).toEqual([4, 5, 6]);
  });

  test("accepts shadowed clocks and expect, fixed dates, and ordinary assertions", async () => {
    expect(
      await lint(
        [
          "const elapsed = 10 - 5;",
          "expect(elapsed).toBeLessThan(100);",
          "expect(Date.now() - Date.now()).toBe(0);",
          "expect(new Date(0) - new Date(0)).toBeLessThan(1);",
          "const localClock = (performance) => expect(performance.now() - performance.now()).toBeLessThan(1);",
          "const localDate = (Date) => expect(Date.now() - Date.now()).toBeLessThan(1);",
          "const localGlobal = (globalThis) => expect(globalThis.Date.now() - globalThis.Date.now()).toBeLessThan(1);",
          "const localTemporal = (Temporal) => expect(Temporal.Now.instant() - Temporal.Now.instant()).toBeLessThan(1);",
          "const localExpect = (expect) => expect(Date.now() - Date.now()).toBeLessThan(1);",
          "const a = b; const b = a; expect(a - b).toBeLessThan(1);",
          "void [localClock, localDate, localGlobal, localTemporal, localExpect];",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("recognizes namespace and Playwright assertion imports", async () => {
    expect(
      await lint(
        [
          'import * as testing from "bun:test";',
          'import { expect as check } from "@playwright/test";',
          "testing.expect(Date.now() - Date.now()).toBeLessThan(100);",
          "check(Date.now() - Date.now()).toBeGreaterThan(0);",
        ].join("\n"),
      ),
    ).toEqual([3, 4]);
  });

  test("accepts deterministic test-kit clocks", async () => {
    expect(
      await lint(
        [
          'import { createTestClock } from "@stll/test-kit";',
          "const clock = createTestClock();",
          "const start = clock.now();",
          "expect(clock.now() - start).toBeLessThan(100);",
          "const ratio = clock.now() / clock.now();",
          "void ratio;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("requires a reason for same-line and previous-line escapes", async () => {
    expect(
      await lint(
        [
          "const start = performance.now();",
          "// kit-allow: exercising an external clock contract",
          ELAPSED_ASSERTION,
          `${ELAPSED_ASSERTION} // kit-allow: external clock contract`,
          "// kit-allow:",
          ELAPSED_ASSERTION,
          `${ELAPSED_ASSERTION} // kit-allow:`,
        ].join("\n"),
      ),
    ).toEqual([6, 7]);
  });

  test("limits checks to test files and exempts the test-kit owner", async () => {
    const source = "expect(Date.now() - Date.now()).toBeLessThan(100);";
    expect(await lintSingleRule(RULE, source, { sourcePath: "x.ts" })).toEqual(
      [],
    );
    expect(
      await lintSingleRule(RULE, source, {
        sourcePath: "packages/test-kit/clock.test.ts",
      }),
    ).toEqual([]);
    expect(
      await lintSingleRule(RULE, source, { sourcePath: "x.property.test.ts" }),
    ).toEqual([1]);
    expect(
      await lintSingleRule(RULE, source, { sourcePath: "x.spec.ts" }),
    ).toEqual([1]);
  });

  test("enforces exact, over, stale, and escaped baseline counts", async () => {
    const options = {
      sourcePath: "x.test.ts",
      cwd: "scratch",
      settings: { testDeterminismBaseline: { "x.test.ts": 1 } },
    } as const;
    const assertion = "expect(Date.now() - Date.now()).toBeLessThan(100);";
    expect(await lintSingleRule(RULE, assertion, options)).toEqual([]);
    expect(
      await lintSingleRule(RULE, `${assertion}\n${assertion}`, options),
    ).toEqual([2]);
    expect(await lintSingleRule(RULE, "const work = 1;", options)).toEqual([1]);
    expect(
      await lintSingleRule(
        RULE,
        `// kit-allow: external clock contract\n${assertion}`,
        options,
      ),
    ).toEqual([]);
    expect(
      await lintSingleRule(
        RULE,
        `// kit-allow: external clock contract\n${assertion}\n${assertion}`,
        options,
      ),
    ).toEqual([3]);
  });

  test("the planted fixture fails when its suppression is removed", async () => {
    const fixture = readFileSync(
      path.join(
        import.meta.dirname,
        "../__fixtures__/no-wallclock-assertions-in-tests.fixture.test.ts",
      ),
      "utf-8",
    ).replaceAll(/^\/\/ oxlint-disable-next-line .*\n/gmu, "");
    expect(await lint(fixture)).toEqual([6]);
  });
});
