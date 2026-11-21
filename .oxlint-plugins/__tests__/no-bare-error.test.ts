import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-bare-error", () => {
  test("reports native thrown failures", async () => {
    expect(
      await lintSingleRule("no-bare-error", 'throw new Error("failed");'),
    ).toEqual([1]);
  });
  test("reports native failures in imported Result aliases", async () => {
    expect(
      await lintSingleRule(
        "no-bare-error",
        'import { Result as R } from "better-result";\nR.err(new globalThis.TypeError("invalid"));',
      ),
    ).toEqual([2]);
  });
  test("accepts local classes that shadow native names", async () => {
    expect(
      await lintSingleRule(
        "no-bare-error",
        "class Error {}\nthrow new Error();",
      ),
    ).toEqual([]);
  });
  test("accepts tagged failures and rethrows", async () => {
    expect(
      await lintSingleRule(
        "no-bare-error",
        'import { Result } from "better-result";\nResult.err(new FetchBoundaryError({ message: "failed" }));\nthrow previousError;',
      ),
    ).toEqual([]);
  });
});
