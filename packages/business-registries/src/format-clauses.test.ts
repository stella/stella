import { describe, expect, test } from "bun:test";

import {
  clausesForTokens,
  formatFromClauses,
  type RegistryFormatClause,
  templateForTokens,
} from "./format-clauses";

const CLAUSES: readonly RegistryFormatClause[] = [
  { template: "**[name]**", requires: ["name"] },
  { template: "of [city]", requires: ["city"] },
  { template: "(no. [id])", requires: ["id"], separator: " " },
  { template: "at [address]", requires: ["address"], separator: " " },
];

const ALL = {
  name: "ACME",
  city: "Brno",
  id: "123",
  address: "Main St",
};

describe("formatFromClauses", () => {
  test("joins every clause with its own separator", () => {
    expect(formatFromClauses(CLAUSES)).toBe(
      "**[name]**, of [city] (no. [id]) at [address]",
    );
  });

  test("is the rendering of a hit that fills every clause", () => {
    expect(templateForTokens(CLAUSES, ALL)).toBe(formatFromClauses(CLAUSES));
  });

  test("returns an empty string for no clauses", () => {
    expect(formatFromClauses([])).toBe("");
  });
});

describe("templateForTokens", () => {
  test.each([
    [{ ...ALL, city: null }, "**[name]** (no. [id]) at [address]"],
    [{ ...ALL, id: null }, "**[name]**, of [city] at [address]"],
    [{ ...ALL, address: undefined }, "**[name]**, of [city] (no. [id])"],
    [{ name: "ACME" }, "**[name]**"],
    [{ ...ALL, name: null }, "of [city] (no. [id]) at [address]"],
  ])("drops the clauses the hit cannot fill", (tokens, expected) => {
    expect(templateForTokens(CLAUSES, tokens)).toBe(expected);
  });

  test("dropping the first clause leaves no leading separator", () => {
    expect(templateForTokens(CLAUSES, { city: "Brno" })).toBe("of [city]");
    expect(templateForTokens(CLAUSES, { id: "123" })).toBe("(no. [id])");
  });

  test("treats blank and whitespace-only particulars as missing", () => {
    expect(templateForTokens(CLAUSES, { ...ALL, city: "" })).toBe(
      "**[name]** (no. [id]) at [address]",
    );
    expect(templateForTokens(CLAUSES, { ...ALL, city: "   " })).toBe(
      "**[name]** (no. [id]) at [address]",
    );
  });

  test("emits a clause that requires nothing", () => {
    const fixed: readonly RegistryFormatClause[] = [
      { template: "registered", requires: [] },
    ];
    expect(templateForTokens(fixed, {})).toBe("registered");
  });

  test("keeps clause order and never duplicates a clause", () => {
    const kept = clausesForTokens(CLAUSES, ALL);
    expect(kept).toEqual([...CLAUSES]);
  });
});
