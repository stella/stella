import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects catch clauses with or without a binding", async () => {
  expect(
    await lintSingleRule(
      "no-try-catch-outside-boundary",
      "try { run(); } catch (cause) { return cause; }\ntry { run(); } catch { recover(); }",
      { plugin: "result-boundary" },
    ),
  ).toEqual([1, 2]);
});

test("rejects catch clauses even with cleanup", async () => {
  expect(
    await lintSingleRule(
      "no-try-catch-outside-boundary",
      "try { run(); } catch (cause) { return map(cause); } finally { cleanup(); }",
      { plugin: "result-boundary" },
    ),
  ).toEqual([1]);
});

test("accepts cleanup without error translation", async () => {
  expect(
    await lintSingleRule(
      "no-try-catch-outside-boundary",
      "try { run(); } finally { cleanup(); }",
      { plugin: "result-boundary" },
    ),
  ).toEqual([]);
});

test("accepts typed result boundaries with callback properties", async () => {
  expect(
    await lintSingleRule(
      "no-try-catch-outside-boundary",
      "Result.try({ try: () => run(), catch: cause => map(cause) });\nawait Result.tryPromise({ try: () => asyncRun(), catch: cause => map(cause) });",
      { plugin: "result-boundary" },
    ),
  ).toEqual([]);
});
