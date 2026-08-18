import { describe, expect, test } from "bun:test";

import { CSV_PARSE_STATUS, escapeCSV, parseCSV } from "@/api/lib/csv";

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

describe("parseCSV", () => {
  test("keeps quoted multiline cells in one record", () => {
    const result = parseCSV(
      'slug,title,body,tags\r\nclause,Title,"First\r\nSecond","one,two"',
    );

    expect(result).toEqual({
      status: CSV_PARSE_STATUS.SUCCESS,
      rows: [
        ["slug", "title", "body", "tags"],
        ["clause", "Title", "First\r\nSecond", "one,two"],
      ],
    });
  });

  test("parses semicolon and tab delimited records", () => {
    expect(
      parseCSV('name;email\n"Doe, Jane";jane@example.com', { delimiter: ";" }),
    ).toEqual({
      status: CSV_PARSE_STATUS.SUCCESS,
      rows: [
        ["name", "email"],
        ["Doe, Jane", "jane@example.com"],
      ],
    });
    expect(
      parseCSV("name\temail\nJane\tjane@example.com", { delimiter: "\t" }),
    ).toEqual({
      status: CSV_PARSE_STATUS.SUCCESS,
      rows: [
        ["name", "email"],
        ["Jane", "jane@example.com"],
      ],
    });
  });

  test("rejects an unterminated quoted cell", () => {
    expect(
      parseCSV(
        'slug,title,body,tags\nfirst,First,"Body\nsecond,Second,Body,two',
      ),
    ).toEqual({ status: CSV_PARSE_STATUS.INVALID });
  });

  test("rejects characters after a closing quote", () => {
    expect(
      parseCSV('slug,title,body,tags\nfirst,"First"suffix,Body,two'),
    ).toEqual({ status: CSV_PARSE_STATUS.INVALID });
  });

  test("removes only the formula guard added by the exporter", () => {
    expect(parseCSV('"\t=SUM(A1:A2)",plain')).toEqual({
      status: CSV_PARSE_STATUS.SUCCESS,
      rows: [["=SUM(A1:A2)", "plain"]],
    });
    expect(parseCSV('"\tplain",plain')).toEqual({
      status: CSV_PARSE_STATUS.SUCCESS,
      rows: [["\tplain", "plain"]],
    });
  });

  test("stops parsing when the record limit is exceeded", () => {
    expect(
      parseCSV('name\nfirst\nsecond\n"unterminated', { maxRows: 2 }),
    ).toEqual({
      status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED,
      rows: [["name"], ["first"]],
    });
  });
});
