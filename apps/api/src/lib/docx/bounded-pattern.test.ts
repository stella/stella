import { describe, expect, it } from "bun:test";

import { compileBoundedPattern } from "@/api/lib/docx/bounded-pattern";
import { LIMITS } from "@/api/lib/limits";

describe("compileBoundedPattern", () => {
  it("compiles ordinary manifest patterns anchored to the whole value", () => {
    const compiled = compileBoundedPattern("[^@]+@[^@]+");
    expect(compiled.status).toBe("valid");
    if (compiled.status === "valid") {
      expect(compiled.regex.test("a@b")).toBe(true);
      expect(compiled.regex.test("a@b@c")).toBe(false);
    }
  });

  it("keeps alternation and quantifiers usable outside a repeated group", () => {
    for (const pattern of [
      String.raw`\d{2}-\d{3}`,
      "(?:rad\\. praw\\.|adw\\.) .+",
      "[A-Z][a-z]*(?: [A-Z][a-z]*)?",
      "a{2,4}",
    ]) {
      expect(compileBoundedPattern(pattern).status).toBe("valid");
    }
  });

  it("refuses shapes whose match time is not linear in the value", () => {
    for (const pattern of [
      "(a+)+",
      "(a*)*",
      "(?:a|a)+",
      "([a-zA-Z]+)*",
      "(a?){10}",
      "(x)(?:y)\\1",
      String.raw`(?<part>a)\k<part>`,
    ]) {
      expect(compileBoundedPattern(pattern).status).toBe("invalid");
    }
  });

  it("refuses a pattern the engine cannot parse", () => {
    expect(compileBoundedPattern("(unclosed").status).toBe("invalid");
    expect(compileBoundedPattern("[").status).toBe("invalid");
  });

  it("refuses a pattern longer than the manifest cap", () => {
    const withinCap = "a".repeat(LIMITS.templateFieldPatternMaxLength);
    const overCap = "a".repeat(LIMITS.templateFieldPatternMaxLength + 1);
    expect(compileBoundedPattern(withinCap).status).toBe("valid");
    expect(compileBoundedPattern(overCap).status).toBe("invalid");
  });

  it("matches a repeated group in linear time on a non-matching value", () => {
    // The classic backtracking input: without the scan this shape runs for
    // seconds on a value this short.
    // Assembled from parts so the source holds no nested-quantifier literal.
    const nested = ["(a+)", "+b"].join("");
    const compiled = compileBoundedPattern(nested);
    expect(compiled.status).toBe("invalid");

    const linear = compileBoundedPattern("a+b");
    expect(linear.status).toBe("valid");
    if (linear.status === "valid") {
      expect(linear.regex.test(`${"a".repeat(40)}c`)).toBe(false);
    }
  });
});
