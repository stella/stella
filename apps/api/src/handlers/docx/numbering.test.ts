import { describe, expect, test } from "bun:test";

import {
  applyNumbering,
  assignNumbers,
  hasNumberingMarkers,
  resolveRefs,
} from "./numbering";

describe("hasNumberingMarkers", () => {
  test("detects @num / @ref markers, ignores plain placeholders", () => {
    expect(hasNumberingMarkers("Clause {{@num:rent}}")).toBe(true);
    expect(hasNumberingMarkers("see {{@ref:rent}}")).toBe(true);
    expect(hasNumberingMarkers("{{tenant.name}} and {{@clause:x}}")).toBe(
      false,
    );
  });
});

describe("assignNumbers", () => {
  test("numbers @num markers 1-based in document order", () => {
    const { xml, numbers } = assignNumbers(
      "Clause {{@num:rent}}. Rent. Clause {{@num:term}}. Term.",
    );
    expect(xml).toBe("Clause 1. Rent. Clause 2. Term.");
    expect(numbers.get("rent")).toBe(1);
    expect(numbers.get("term")).toBe(2);
  });

  test("a repeated key reuses its first number", () => {
    const { xml, numbers } = assignNumbers(
      "{{@num:a}} ... {{@num:b}} ... {{@num:a}}",
    );
    expect(xml).toBe("1 ... 2 ... 1");
    expect(numbers.size).toBe(2);
  });
});

describe("resolveRefs", () => {
  test("resolves refs and leaves unresolved ones intact", () => {
    const numbers = new Map([["rent", 9]]);
    expect(resolveRefs("see Clause {{@ref:rent}}", numbers)).toBe(
      "see Clause 9",
    );
    // The target clause was excluded → reference stays visible for diagnostics.
    expect(resolveRefs("see Clause {{@ref:dropped}}", numbers)).toBe(
      "see Clause {{@ref:dropped}}",
    );
  });
});

describe("applyNumbering — end to end", () => {
  test("resolves forward and backward references to clause numbers", () => {
    const input =
      "as set out in Clause {{@ref:term}}. " +
      "Clause {{@num:rent}}. Rent. " +
      "Clause {{@num:term}}. Term, see Clause {{@ref:rent}}.";
    expect(applyNumbering(input)).toBe(
      "as set out in Clause 2. Clause 1. Rent. Clause 2. Term, see Clause 1.",
    );
  });

  test("Maciej's amendment: reference to an excluded clause is not resolved", () => {
    // The {{@num:guarantee}} clause was removed by a {{#if}} before this pass,
    // so only `rent` is numbered; the dangling guarantee reference stays put.
    const assembled =
      "Clause {{@num:rent}}. Rent. " +
      "After Clause {{@ref:rent}} a clause is added. " +
      "Per Clause {{@ref:guarantee}} (removed).";
    expect(applyNumbering(assembled)).toBe(
      "Clause 1. Rent. After Clause 1 a clause is added. Per Clause {{@ref:guarantee}} (removed).",
    );
  });
});
