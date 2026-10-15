import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-inline-style-colors", () => {
  test("reports colors inside border shorthands", async () => {
    expect(
      await lintSingleRule(
        "no-inline-style-colors",
        'const view = <div style={{ border: "1px solid #abc" }} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1]);
  });
  test("reports static template color functions", async () => {
    expect(
      await lintSingleRule(
        "no-inline-style-colors",
        "const view = <div style={{ boxShadow: `0 0 2px rgba(0,0,0,1)` }} />;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1]);
  });
  test("accepts tokens and inherited colors", async () => {
    expect(
      await lintSingleRule(
        "no-inline-style-colors",
        'const view = <div style={{ color: "var(--ink, #fff)", background: "transparent", borderColor: "currentColor" }} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("does not mistake white-space for a color", async () => {
    expect(
      await lintSingleRule(
        "no-inline-style-colors",
        'const view = <div style={{ transition: "white-space 1s", color: chosenColor }} />;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
