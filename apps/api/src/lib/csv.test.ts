import { describe, expect, test } from "bun:test";

import { escapeCSV } from "@/api/lib/csv";

// Invariants over a large, fuzzed input space live in csv.property.test.ts
// (fast-check). These example tests pin the exact emitted strings for the
// canonical cases.
describe("escapeCSV", () => {
  test("passes through plain values unchanged", () => {
    for (const v of ["", "abc", "John Smith", "123.45", "Praha 1", "café"]) {
      expect(escapeCSV(v)).toBe(v);
    }
  });

  test("quotes and doubles inner quotes for delimiter-bearing values", () => {
    expect(escapeCSV("a,b")).toBe('"a,b"');
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCSV("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCSV("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  test("neutralizes spreadsheet formula prefixes with a leading tab", () => {
    // The classic CSV-injection vectors must never reach a cell that a
    // spreadsheet would evaluate as a formula.
    for (const v of [
      "=1+1",
      "+1",
      "-1+cmd",
      "@SUM(A1)",
      "=HYPERLINK(...)",
      "\t=evil",
    ]) {
      const escaped = escapeCSV(v);
      expect(escaped.startsWith('"\t')).toBe(true);
    }
  });

  test("neutralizes formula prefixes even behind leading whitespace", () => {
    // Excel trims leading spaces before deciding a cell is a formula.
    for (const v of ["   =1+1", "  +cmd", " \t-danger", "  @x"]) {
      expect(escapeCSV(v).startsWith('"\t')).toBe(true);
    }
  });

  test("does NOT add a tab guard to non-formula values", () => {
    for (const v of ["a,b", 'say "hi"', "plain", "1,000.00"]) {
      expect(escapeCSV(v).startsWith('"\t')).toBe(false);
    }
  });
});
