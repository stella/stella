import { describe, expect, test } from "bun:test";

import { evaluateCondition } from "./index";
import type { NamedCondition } from "./index";

describe("evaluateCondition", () => {
  // ── Basic truthiness ──────────────────────────────────

  test("truthy string", () => {
    expect(evaluateCondition("name", { name: "Alice" })).toBe(true);
  });

  test("empty string is falsy", () => {
    expect(evaluateCondition("name", { name: "" })).toBe(false);
  });

  test("boolean true", () => {
    expect(evaluateCondition("isUK", { isUK: true })).toBe(true);
  });

  test("boolean false", () => {
    expect(evaluateCondition("isUK", { isUK: false })).toBe(false);
  });

  test("undefined path is falsy", () => {
    expect(evaluateCondition("missing", {})).toBe(false);
  });

  // ── Negation ──────────────────────────────────────────

  test("negation of truthy", () => {
    expect(evaluateCondition("!isUK", { isUK: true })).toBe(false);
  });

  test("double negation", () => {
    expect(evaluateCondition("!!isUK", { isUK: true })).toBe(true);
  });

  // ── Comparisons ───────────────────────────────────────

  test("string equality", () => {
    expect(
      evaluateCondition('country == "UK"', {
        country: "UK",
      }),
    ).toBe(true);
  });

  test("string inequality", () => {
    expect(
      evaluateCondition('country != "UK"', {
        country: "DE",
      }),
    ).toBe(true);
  });

  test("numeric comparison", () => {
    expect(evaluateCondition("amount > 1000", { amount: 5000 })).toBe(true);
  });

  // ── Logical operators ─────────────────────────────────

  test("and: both true", () => {
    expect(
      evaluateCondition("isUK and hasLicense", {
        isUK: true,
        hasLicense: true,
      }),
    ).toBe(true);
  });

  test("and: one false", () => {
    expect(
      evaluateCondition("isUK and hasLicense", {
        isUK: true,
        hasLicense: false,
      }),
    ).toBe(false);
  });

  test("or: one true", () => {
    expect(
      evaluateCondition("isUK or isDE", {
        isUK: false,
        isDE: true,
      }),
    ).toBe(true);
  });

  test("and has higher precedence than or", () => {
    // A or B and C → A or (B and C)
    expect(
      evaluateCondition("isUK or isDE and hasLicense", {
        isUK: true,
        isDE: false,
        hasLicense: false,
      }),
    ).toBe(true); // isUK is true
  });

  // ── Parentheses ───────────────────────────────────────

  test("parentheses override precedence", () => {
    // (A or B) and C — without parens, A or (B and C)
    expect(
      evaluateCondition("(isUK or isDE) and hasLicense", {
        isUK: true,
        isDE: false,
        hasLicense: false,
      }),
    ).toBe(false); // (true or false) and false = false
  });

  test("negated parenthesized group", () => {
    // !(A and B) — De Morgan: !A or !B
    expect(
      evaluateCondition("!(isUK and hasLicense)", {
        isUK: true,
        hasLicense: false,
      }),
    ).toBe(true); // !(true and false) = !false = true
  });

  test("negated parenthesized group: both true", () => {
    expect(
      evaluateCondition("!(isUK and hasLicense)", {
        isUK: true,
        hasLicense: true,
      }),
    ).toBe(false); // !(true and true) = !true = false
  });

  test("nested parentheses", () => {
    expect(
      evaluateCondition("((isUK or isDE) and hasLicense)", {
        isUK: false,
        isDE: true,
        hasLicense: true,
      }),
    ).toBe(true);
  });

  test("compound negation for else branch", () => {
    // Simulates: {{#if isUK and hasLicense}}
    //            {{#else}} → !(isUK and hasLicense)
    // With isUK=false, hasLicense=false: else should show
    expect(
      evaluateCondition("!(isUK and hasLicense)", {
        isUK: false,
        hasLicense: false,
      }),
    ).toBe(true);
  });

  test("elseif with or expression", () => {
    // Simulates: {{#if A}}...{{#elseif C or D}}
    // Condition: !A and (C or D)
    expect(
      evaluateCondition("!A and (C or D)", {
        A: false,
        C: false,
        D: true,
      }),
    ).toBe(true);

    // A is true → !A is false → whole thing false
    expect(
      evaluateCondition("!A and (C or D)", {
        A: true,
        C: false,
        D: true,
      }),
    ).toBe(false);
  });

  // ── Named conditions ──────────────────────────────────

  test("named condition resolution", () => {
    const conditions: NamedCondition[] = [
      { name: "isUK", expression: 'country == "UK"' },
    ];
    expect(evaluateCondition("isUK", { country: "UK" }, conditions)).toBe(true);
  });

  test("circular named condition returns false", () => {
    const conditions: NamedCondition[] = [
      { name: "a", expression: "b" },
      { name: "b", expression: "a" },
    ];
    expect(evaluateCondition("a", {}, conditions)).toBe(false);
  });

  // ── Dotted paths ──────────────────────────────────────

  test("dotted path resolution", () => {
    expect(
      evaluateCondition("company.isActive", {
        company: { isActive: true },
      }),
    ).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────

  test("empty expression returns false", () => {
    expect(evaluateCondition("", {})).toBe(false);
  });

  test("unmatched paren treated gracefully", () => {
    // Should not throw
    expect(evaluateCondition("(isUK", { isUK: true })).toBe(true);
  });
});
