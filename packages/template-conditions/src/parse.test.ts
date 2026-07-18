import { describe, expect, test } from "bun:test";

import type { CompareOp, ConditionNode } from "@stll/conditions";

import { parseCondition } from "./parse.js";

// Direct AST-shape assertions for the surface-syntax parser. evaluateCondition
// covers behavior end-to-end; this pins the exact @stll/conditions node the
// grammar produces, so a parser regression is caught at the AST, not only by a
// downstream evaluation result.

const path = (p: string): ConditionNode => ({
  type: "predicate",
  operand: { type: "path", path: p },
  op: "is_truthy",
});

describe("operands", () => {
  test("a bare identifier is a truthiness predicate on a path operand", () => {
    expect(parseCondition("name")).toEqual({
      type: "predicate",
      operand: { type: "path", path: "name" },
      op: "is_truthy",
    });
  });

  test("a dotted identifier keeps the full path", () => {
    expect(parseCondition("company.isActive")).toEqual(
      path("company.isActive"),
    );
  });

  test("a hyphenated path segment stays one operand", () => {
    expect(parseCondition("base-rent")).toEqual(path("base-rent"));
  });

  test("numeric, boolean, and string literals are literal operands", () => {
    expect(parseCondition("amount == 1000")).toEqual({
      type: "compare",
      left: { type: "path", path: "amount" },
      op: "eq",
      right: { type: "literal", value: 1000 },
    });
    expect(parseCondition("flag == true")).toEqual({
      type: "compare",
      left: { type: "path", path: "flag" },
      op: "eq",
      right: { type: "literal", value: true },
    });
    expect(parseCondition('country == "UK"')).toEqual({
      type: "compare",
      left: { type: "path", path: "country" },
      op: "eq",
      right: { type: "literal", value: "UK" },
    });
  });

  test("numeric underscores are stripped; escaped quotes are unescaped", () => {
    expect(parseCondition("n == 5_000")).toEqual({
      type: "compare",
      left: { type: "path", path: "n" },
      op: "eq",
      right: { type: "literal", value: 5000 },
    });
    expect(parseCondition('s == "a\\"b"')).toEqual({
      type: "compare",
      left: { type: "path", path: "s" },
      op: "eq",
      right: { type: "literal", value: 'a"b' },
    });
  });

  test("an empty string literal is the empty string", () => {
    expect(parseCondition('s == ""')).toEqual({
      type: "compare",
      left: { type: "path", path: "s" },
      op: "eq",
      right: { type: "literal", value: "" },
    });
  });

  test("multiple escaped quotes in one string literal are all unescaped", () => {
    expect(parseCondition('s == "a\\"b\\"c"')).toEqual({
      type: "compare",
      left: { type: "path", path: "s" },
      op: "eq",
      right: { type: "literal", value: 'a"b"c' },
    });
  });

  test('an escaped backslash is kept literally (only \\" is unescaped)', () => {
    expect(parseCondition('s == "a\\\\b"')).toEqual({
      type: "compare",
      left: { type: "path", path: "s" },
      op: "eq",
      right: { type: "literal", value: "a\\\\b" },
    });
  });
});

describe("comparisons", () => {
  test("each symbol maps to its @stll/conditions compare op", () => {
    const ops: [string, CompareOp][] = [
      ["==", "eq"],
      ["!=", "neq"],
      [">", "gt"],
      ["<", "lt"],
      [">=", "gte"],
      ["<=", "lte"],
    ];
    for (const [symbol, op] of ops) {
      expect(parseCondition(`a ${symbol} 1`)).toEqual({
        type: "compare",
        left: { type: "path", path: "a" },
        op,
        right: { type: "literal", value: 1 },
      });
    }
  });

  test("contains is a predicate carrying a literal payload", () => {
    expect(parseCondition('notes contains "urgent"')).toEqual({
      type: "predicate",
      operand: { type: "path", path: "notes" },
      op: "contains",
      value: "urgent",
    });
  });
});

describe("logical structure", () => {
  test("a single rule is returned unwrapped (no group)", () => {
    expect(parseCondition("a == 1")).toEqual({
      type: "compare",
      left: { type: "path", path: "a" },
      op: "eq",
      right: { type: "literal", value: 1 },
    });
  });

  test("and / or build a group with the matching combinator", () => {
    expect(parseCondition("a and b")).toEqual({
      type: "group",
      combinator: "and",
      children: [path("a"), path("b")],
    });
    expect(parseCondition("a or b")).toEqual({
      type: "group",
      combinator: "or",
      children: [path("a"), path("b")],
    });
  });

  test("and binds tighter than or", () => {
    // a or b and c → a or (b and c)
    expect(parseCondition("a or b and c")).toEqual({
      type: "group",
      combinator: "or",
      children: [
        path("a"),
        { type: "group", combinator: "and", children: [path("b"), path("c")] },
      ],
    });
  });

  test("parentheses override precedence", () => {
    expect(parseCondition("(a or b) and c")).toEqual({
      type: "group",
      combinator: "and",
      children: [
        { type: "group", combinator: "or", children: [path("a"), path("b")] },
        path("c"),
      ],
    });
  });
});

describe("negation", () => {
  test("! wraps the node in a negated and-group", () => {
    expect(parseCondition("!isUK")).toEqual({
      type: "group",
      combinator: "and",
      negated: true,
      children: [path("isUK")],
    });
  });

  test("!! nests two negated groups", () => {
    expect(parseCondition("!!isUK")).toEqual({
      type: "group",
      combinator: "and",
      negated: true,
      children: [
        {
          type: "group",
          combinator: "and",
          negated: true,
          children: [path("isUK")],
        },
      ],
    });
  });

  test("!(a and b) negates the parenthesized group", () => {
    expect(parseCondition("!(a and b)")).toEqual({
      type: "group",
      combinator: "and",
      negated: true,
      children: [
        { type: "group", combinator: "and", children: [path("a"), path("b")] },
      ],
    });
  });
});

describe("degenerate input", () => {
  test("an empty (or whitespace-only) expression is null", () => {
    expect(parseCondition("")).toBeNull();
    expect(parseCondition("   ")).toBeNull();
  });

  test("an unmatched ( closes gracefully at end of input", () => {
    expect(parseCondition("(isUK")).toEqual(path("isUK"));
  });

  test("a dangling operator falls back to the left operand's truthiness", () => {
    expect(parseCondition("a ==")).toEqual(path("a"));
  });
});

describe("tokenizer performance", () => {
  // The tokenizer's string-literal handling used to be a regex branch
  // (`"[^"\\]*(?:\\.[^"\\]*)*"`) scanned via an unanchored `matchAll`. On an
  // unterminated string, the scan for a closing quote fails, and `matchAll`
  // retries that same expensive "find the close, honoring escapes" search
  // starting at every subsequent `"` character in the input, quadratic in
  // the input length. Guard against that shape reappearing by asserting a
  // large adversarial input (many escaped-quote-like sequences, never
  // closing) still parses fast.
  test("an unterminated quoted string with many escape-like sequences parses in linear time", () => {
    const evilTail = '\\"\\a'.repeat(10_000); // ~50k chars, never closes the string
    const expression = `s == "${evilTail}`;

    const start = performance.now();
    const node = parseCondition(expression);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
    // Malformed input degrades gracefully: a literal missing its closing
    // quote closes at end of input (consistent with an unmatched `(` closing
    // at end of input), producing one (very large) string literal.
    expect(node).toMatchObject({
      type: "compare",
      left: { type: "path", path: "s" },
      op: "eq",
      right: { type: "literal" },
    });
  });
});
