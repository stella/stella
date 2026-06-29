import { describe, expect, test } from "bun:test";

import { evaluateCondition, MAX_CONDITION_DEPTH } from "./index";
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

  // ── String-encoded numbers (form/JSON inputs serialize as strings) ──

  test("ordering coerces a numeric-string field value", () => {
    expect(
      evaluateCondition("contractValue > 100000", { contractValue: "150000" }),
    ).toBe(true);
    expect(
      evaluateCondition("contractValue < 100000", { contractValue: "150000" }),
    ).toBe(false);
    expect(
      evaluateCondition("contractValue >= 150000", { contractValue: "150000" }),
    ).toBe(true);
  });

  test("equality coerces a numeric-string field value", () => {
    expect(evaluateCondition("amount == 5000", { amount: "5000" })).toBe(true);
    expect(evaluateCondition("amount != 5000", { amount: "5000" })).toBe(false);
  });

  test("does not coerce non-numeric strings or empty strings", () => {
    // "abc" must not become 0; "" must not become 0.
    expect(evaluateCondition("v == 0", { v: "abc" })).toBe(false);
    expect(evaluateCondition("v == 0", { v: "" })).toBe(false);
    expect(evaluateCondition("v > 0", { v: "abc" })).toBe(false);
  });

  test("string-vs-string equality is unaffected by numeric coercion", () => {
    expect(evaluateCondition('code == "5000"', { code: "5000" })).toBe(true);
    expect(evaluateCondition('code == "UK"', { code: "UK" })).toBe(true);
  });

  // ── Date comparisons (ISO YYYY-MM-DD, lexicographic) ──

  test("date >= (on or after, positive)", () => {
    expect(
      evaluateCondition('signed >= "2026-01-01"', { signed: "2026-06-13" }),
    ).toBe(true);
  });

  test("date >= (on or after, boundary equal)", () => {
    expect(
      evaluateCondition('signed >= "2026-06-13"', { signed: "2026-06-13" }),
    ).toBe(true);
  });

  test("date >= (negative)", () => {
    expect(
      evaluateCondition('signed >= "2026-06-13"', { signed: "2025-12-31" }),
    ).toBe(false);
  });

  test("date <= (on or before, positive)", () => {
    expect(
      evaluateCondition('signed <= "2026-12-31"', { signed: "2026-06-13" }),
    ).toBe(true);
  });

  test("date <= (negative)", () => {
    expect(
      evaluateCondition('signed <= "2026-01-01"', { signed: "2026-06-13" }),
    ).toBe(false);
  });

  test("date > (after, positive + boundary negative)", () => {
    expect(
      evaluateCondition('signed > "2026-06-12"', { signed: "2026-06-13" }),
    ).toBe(true);
    expect(
      evaluateCondition('signed > "2026-06-13"', { signed: "2026-06-13" }),
    ).toBe(false);
  });

  test("date < (before, positive + boundary negative)", () => {
    expect(
      evaluateCondition('signed < "2026-06-14"', { signed: "2026-06-13" }),
    ).toBe(true);
    expect(
      evaluateCondition('signed < "2026-06-13"', { signed: "2026-06-13" }),
    ).toBe(false);
  });

  test("date == / != (string equality path, unchanged)", () => {
    expect(
      evaluateCondition('signed == "2026-06-13"', { signed: "2026-06-13" }),
    ).toBe(true);
    expect(
      evaluateCondition('signed != "2026-06-13"', { signed: "2026-06-14" }),
    ).toBe(true);
  });

  test("ordered comparison falls back to lexicographic for non-numeric operands", () => {
    // A non-numeric ordered comparison stringifies both sides and compares
    // lexicographically, matching the shared @stll/conditions evaluator (and the
    // SQL filter side). ISO dates sort chronologically as a happy consequence.
    expect(
      evaluateCondition('signed >= "2026-06-13"', { signed: 20_260_613 }),
    ).toBe(true); // "20260613" >= "2026-06-13"
    expect(
      evaluateCondition('signed >= "2026-06-13"', { signed: "13/06/2026" }),
    ).toBe(false); // "13/06/2026" < "2026-06-13"
    expect(evaluateCondition('signed < "2026-06-13"', { signed: "soon" })).toBe(
      false,
    ); // "soon" > "2026-06-13"
  });

  test("numeric ordering still works alongside date support", () => {
    expect(evaluateCondition("amount >= 1000", { amount: 1000 })).toBe(true);
    expect(evaluateCondition("amount < 1000", { amount: 1000 })).toBe(false);
  });

  // ── contains ──────────────────────────────────────────

  test("string contains (case-insensitive, positive)", () => {
    expect(
      evaluateCondition('notes contains "urgent"', { notes: "VERY URGENT!" }),
    ).toBe(true);
  });

  test("string contains (negative)", () => {
    expect(
      evaluateCondition('notes contains "urgent"', { notes: "all calm" }),
    ).toBe(false);
  });

  test("array/multi-select membership (positive)", () => {
    expect(
      evaluateCondition('parties contains "guarantor"', {
        parties: ["buyer", "guarantor", "seller"],
      }),
    ).toBe(true);
  });

  test("array/multi-select membership (negative)", () => {
    expect(
      evaluateCondition('parties contains "guarantor"', {
        parties: ["buyer", "seller"],
      }),
    ).toBe(false);
  });

  test("array membership coerces non-string elements to string", () => {
    expect(evaluateCondition('codes contains "2"', { codes: [1, 2, 3] })).toBe(
      true,
    );
  });

  test("contains substring-matches a stringified scalar left", () => {
    expect(evaluateCondition('n contains "1"', { n: 12 })).toBe(true); // "12" ⊇ "1"
    expect(evaluateCondition('n contains "9"', { n: 12 })).toBe(false);
    expect(evaluateCondition('flag contains "x"', { flag: true })).toBe(false);
    expect(evaluateCondition('missing contains "x"', {})).toBe(false);
  });

  test("contains binds tighter than and (comparison precedence)", () => {
    // a contains "x" and b == 1 → (a contains "x") and (b == 1)
    expect(
      evaluateCondition('a contains "x" and b == 1', { a: "xy", b: 1 }),
    ).toBe(true);
    expect(
      evaluateCondition('a contains "x" and b == 1', { a: "xy", b: 2 }),
    ).toBe(false);
    expect(
      evaluateCondition('a contains "x" and b == 1', { a: "zz", b: 1 }),
    ).toBe(false);
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

  test("AST-backed named condition resolves a formula operand", () => {
    // `rent * 12 < 100000` — no `{{#if}}` string form, so the rule lives as the
    // AST `node` and the formula operand is computed against the fill bag.
    const conditions: NamedCondition[] = [
      {
        name: "fitsBudget",
        expression: "",
        node: {
          type: "compare",
          left: { type: "formula", expr: "rent * 12" },
          op: "lt",
          right: { type: "literal", value: 100_000 },
        },
      },
    ];
    expect(evaluateCondition("fitsBudget", { rent: 8000 }, conditions)).toBe(
      true,
    );
    expect(evaluateCondition("fitsBudget", { rent: 9000 }, conditions)).toBe(
      false,
    );
  });

  test("circular named condition returns false", () => {
    const conditions: NamedCondition[] = [
      { name: "a", expression: "b" },
      { name: "b", expression: "a" },
    ];
    expect(evaluateCondition("a", {}, conditions)).toBe(false);
  });

  test("deep named condition chain returns false at depth limit", () => {
    // Build a chain: c0 → c1 → c2 → ... → cN → data_field
    const chainLength = MAX_CONDITION_DEPTH + 10;
    const conditions: NamedCondition[] = [];
    for (let i = 0; i < chainLength; i++) {
      conditions.push({ name: `c${i}`, expression: `c${i + 1}` });
    }
    // Terminal condition resolves to a truthy data field
    conditions.push({
      name: `c${chainLength}`,
      expression: "value",
    });

    // Should return false (depth exceeded) instead of
    // overflowing the call stack
    expect(evaluateCondition("c0", { value: true }, conditions)).toBe(false);
  });

  test("named condition chain within depth limit resolves normally", () => {
    // Build a chain shorter than the limit
    const chainLength = 5;
    const conditions: NamedCondition[] = [];
    for (let i = 0; i < chainLength; i++) {
      conditions.push({ name: `c${i}`, expression: `c${i + 1}` });
    }
    conditions.push({
      name: `c${chainLength}`,
      expression: "value",
    });

    expect(evaluateCondition("c0", { value: true }, conditions)).toBe(true);
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
