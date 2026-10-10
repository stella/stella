import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("require-exhaustive-panic", () => {
  test("reports binding and returning unhandled values", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        "function decide(kind) { const exhaustive: never = kind; return exhaustive; }\nfunction other(kind) { return kind satisfies never; }",
      ),
    ).toEqual([1, 2]);
  });
  test("reports fallback and returned bindings after assertions", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        "function decide(kind) { kind satisfies never;\nreturn null; }\nfunction other(kind) { kind satisfies never;\nreturn kind; }",
      ),
    ).toEqual([2, 4]);
  });
  test("rejects a foreign panic", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        'import { panic } from "./errors";\nfunction decide(kind) { kind satisfies never; return panic("unknown"); }',
      ),
    ).toEqual([2]);
  });
  test("accepts the canonical panic under an alias", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        'import { panic as stop } from "better-result";\nfunction decide(kind) { kind satisfies never; return stop("unknown"); }',
      ),
    ).toEqual([]);
  });
  test("accepts an explicit throw after the assertion", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        'function decide(kind) { kind satisfies never; throw new DomainError({ message: "unknown" }); }',
      ),
    ).toEqual([]);
  });
  test("rejects a local declaration shadowing canonical panic", async () => {
    expect(
      await lintSingleRule(
        "require-exhaustive-panic",
        'import { panic } from "better-result";\nfunction decide(kind) { const panic = value => value; kind satisfies never; return panic("unknown"); }',
      ),
    ).toEqual([2]);
  });
});
