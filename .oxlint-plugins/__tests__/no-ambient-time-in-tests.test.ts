import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-ambient-time-in-tests";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "x.test.ts" });

describe(RULE, () => {
  test("rejects each ambient clock through direct and globalThis reads", async () => {
    expect(
      await lint(
        [
          "Date.now();",
          "performance.now();",
          "new Date();",
          "Temporal.Now.instant();",
          'globalThis.Date["now"]();',
          "globalThis.performance.now();",
          "new globalThis.Date();",
          "globalThis.Temporal.Now.zonedDateTimeISO();",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test.each([
    "Date();",
    "Date(2020);",
    "globalThis.Date();",
    "globalThis.Date(2020);",
  ])(
    "rejects Date function calls even with explicit arguments: %s",
    async (source) => {
      expect(await lint(source)).toEqual([1]);
    },
  );

  test("follows Date function aliases and destructured constructors", async () => {
    expect(
      await lint(
        [
          "const clock = Date;",
          "clock();",
          "clock(2020);",
          "const { Date: Clock } = globalThis;",
          "Clock();",
          "Clock(2020);",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 5, 6]);
  });

  test("follows called, applied, and bound Date functions without treating bound arguments as fixed dates", async () => {
    expect(
      await lint(
        [
          "Date.call(null);",
          "Date.call(null, 2020);",
          "Date.apply(null, []);",
          "Date.apply(null, [2020]);",
          "const clock = Date.bind(null);",
          "clock();",
          "clock(2020);",
          "const fixedArgument = Date.bind(null, 2020);",
          "fixedArgument();",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 6, 7, 9]);
  });

  test("accepts fixed Date construction and shadowed Date function aliases", async () => {
    expect(
      await lint(
        [
          "new Date(2020);",
          "const Clock = Date; new Clock(2020);",
          "const { Date: GlobalClock } = globalThis; new GlobalClock(2020);",
          "const Fixed = Date.bind(null, 2020); new Fixed();",
          "const shadowDate = (Date) => { Date(); Date(2020); const clock = Date; clock(); clock(2020); };",
          "const shadowRoot = (globalThis) => { globalThis.Date(); const { Date: Clock } = globalThis; Clock(2020); };",
          "void [shadowDate, shadowRoot];",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("follows aliases, destructuring, nested bindings and later assignments", async () => {
    expect(
      await lint(
        [
          "const clock = Date;",
          "const read = clock.now;",
          "read();",
          "const { now: tick } = performance;",
          "tick();",
          "const { Temporal: { Now: { instant } } } = globalThis;",
          "instant();",
          "const { Date: Clock } = globalThis;",
          "new Clock();",
          "let late;",
          "late = Date.now;",
          "late();",
          "const root = globalThis;",
          "root.performance.now();",
        ].join("\n"),
      ),
    ).toEqual([3, 5, 7, 9, 12, 14]);
  });

  test("follows property paths in later destructuring assignments", async () => {
    expect(
      await lint(
        [
          "let read; ({ now: read } = Date); read();",
          "let nested; ({ performance: { now: nested } } = globalThis); nested();",
          "let instant; ({ Temporal: { Now: { instant } } } = globalThis); instant();",
          "let Clock; ({ Date: Clock } = globalThis); new Clock();",
          'let computed; ({ ["now"]: computed } = performance); computed();',
          "let direct; direct = Date.now; direct();",
          "let local; ({ now: local } = { now: () => 0 }); local();",
          "const shadowed = (Date) => { let read; ({ now: read } = Date); read(); };",
          "const key = unknown; let dynamic; ({ [key]: dynamic } = Date); dynamic();",
          "let repeated; ({ missing: repeated, now: repeated } = Date); repeated();",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 10]);
  });

  test("recognizes node performance imports and expression wrappers", async () => {
    expect(
      await lint(
        [
          'import { performance as clock } from "node:perf_hooks";',
          'import * as hooks from "node:perf_hooks";',
          "clock.now();",
          "hooks.performance.now();",
          "(Date.now as () => number)();",
          "globalThis?.performance.now();",
          "const { performance: destructured } = hooks;",
          "destructured.now();",
          "const { window: root } = globalThis;",
          "root.Date.now();",
          "const { globalThis: nestedRoot } = globalThis;",
          "nestedRoot.performance.now();",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6, 8, 10, 12]);
  });

  test("follows call, apply and bound clock aliases without counting bind creation", async () => {
    expect(
      await lint(
        [
          "Date.now.call(Date);",
          "performance.now.apply(performance, []);",
          "const now = Date.now.bind(Date);",
          "now();",
          "const { now: raw } = performance;",
          "const bound = raw.bind(performance);",
          "bound();",
          "const root = globalThis;",
          "root.Temporal.Now.instant.call(root.Temporal.Now);",
          "const local = { now: () => 0 };",
          "const safe = local.now.bind(local); safe();",
          "const shadow = (Date) => Date.now.call(Date);",
          "const Ambient = Date.bind(null);",
          "new Ambient();",
          "const Fixed = Date.bind(null, 0);",
          "new Fixed();",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 4, 7, 9, 14]);
  });

  test("accepts explicit dates, injected clocks, shadowed globals and unrelated methods", async () => {
    expect(
      await lint(
        [
          'import { createTestClock } from "@stll/test-kit";',
          "const clock = createTestClock();",
          "clock.now();",
          "new Date(0);",
          'new Date("2026-01-01");',
          "const shadowDate = (Date) => { Date.now(); new Date(); };",
          "const shadowPerformance = (performance) => performance.now();",
          "const shadowTemporal = (Temporal) => Temporal.Now.instant();",
          "const shadowRoot = (globalThis) => globalThis.Date.now();",
          "const local = { now: () => 0 }; local.now();",
          "const recursive = recursive; recursive();",
          'const now = "unrelated"; const { [now]: dynamic } = Date; dynamic();',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("only checks test files and exempts the test-kit owner", async () => {
    expect(
      await lintSingleRule(RULE, "Date.now();", { sourcePath: "source.ts" }),
    ).toEqual([]);
    expect(
      await lintSingleRule(RULE, "Date.now();", {
        sourcePath: "packages/test-kit/src/clock.test.ts",
      }),
    ).toEqual([]);
    for (const sourcePath of [
      "x.spec.ts",
      "x.property.test.ts",
      "x.test.mjs",
      "x.spec.tsx",
    ]) {
      expect(await lintSingleRule(RULE, "Date.now();", { sourcePath })).toEqual(
        [1],
      );
    }
  });

  test("accepts reasoned escapes but requires a nonempty reason", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "Date.now(); // kit-allow: verifying a real-clock boundary",
          "// kit-allow: verifying a real-clock boundary",
          "performance.now();",
          "// kit-allow:",
          "new Date();",
          "Temporal.Now.instant(); // kit-allow:   ",
        ].join("\n"),
        {
          sourcePath: "x.test.ts",
          settings: { testDeterminismBaseline: { "x.test.ts": 2 } },
        },
      ),
    ).toEqual([5, 6]);
  });

  test("enforces exact, over-budget and stale baselines including escaped reads", async () => {
    const settings = { testDeterminismBaseline: { "x.test.ts": 1 } };
    const options = { sourcePath: "x.test.ts", settings };
    expect(await lintSingleRule(RULE, "Date.now();", options)).toEqual([]);
    expect(
      await lintSingleRule(RULE, "Date.now();\nperformance.now();", options),
    ).toEqual([2]);
    expect(await lintSingleRule(RULE, "new Date(0);", options)).toEqual([1]);
    expect(
      await lintSingleRule(
        RULE,
        "Date.now(); // kit-allow: real-clock boundary",
        options,
      ),
    ).toEqual([]);
  });

  test("escapes consume baseline slots regardless of source order", async () => {
    const plain = "Date.now();";
    const escaped = `${plain} // kit-allow: external clock boundary`;
    const options = {
      sourcePath: "x.test.ts",
      settings: { testDeterminismBaseline: { "x.test.ts": 1 } },
    };
    expect(
      await lintSingleRule(RULE, `${plain}\n\n${escaped}`, options),
    ).toEqual([1]);
    expect(
      await lintSingleRule(RULE, `${escaped}\n\n${plain}`, options),
    ).toEqual([3]);
    expect(
      await lintSingleRule(RULE, `${escaped}\n\n${escaped}`, options),
    ).toHaveLength(1);
    expect(await lintSingleRule(RULE, escaped, options)).toEqual([]);
    expect(
      await lintSingleRule(RULE, escaped, {
        ...options,
        settings: { testDeterminismBaseline: { "x.test.ts": 0 } },
      }),
    ).toEqual([1]);
    expect(
      await lintSingleRule(RULE, `${escaped}\n\n${plain}`, {
        ...options,
        settings: {
          testDeterminismBaseline: { "x.test.ts": 1 },
          testDeterminismCensus: true,
        },
      }),
    ).toEqual([1, 3]);
  });

  test("the planted fixture fails when its suppression is removed", async () => {
    const fixture = readFileSync(
      path.join(
        import.meta.dirname,
        "../__fixtures__/no-ambient-time-in-tests.fixture.test.ts",
      ),
      "utf-8",
    );
    const wrongFixture = fixture.replaceAll(
      /^\/\/ oxlint-disable-next-line .*\n/gmu,
      "",
    );
    expect(wrongFixture).not.toBe(fixture);
    expect(await lint(wrongFixture)).toEqual([1]);
  });
});
