// The chat edit tool has no inline run-format channel, so the model improvises
// bold with markdown. These tests pin the conservative parse that promotes
// `**bold**` / `***bold italic***` to runs while leaving ambiguous single
// delimiters (math, identifiers) and plain prose untouched.

import { describe, expect, test } from "bun:test";

import {
  parseInlineEmphasisRuns,
  stripInlineEmphasisMarkers,
} from "./inline-emphasis";

describe("parseInlineEmphasisRuns", () => {
  test("promotes a bold span and keeps surrounding literals", () => {
    expect(parseInlineEmphasisRuns("**Date:** 2026-06-30")).toEqual([
      { text: "Date:", bold: true, italic: false },
      { text: " 2026-06-30", bold: false, italic: false },
    ]);
  });

  test("handles a bold span mid-sentence", () => {
    expect(
      parseInlineEmphasisRuns("(1) **Disclosing Party Name**, with office"),
    ).toEqual([
      { text: "(1) ", bold: false, italic: false },
      { text: "Disclosing Party Name", bold: true, italic: false },
      { text: ", with office", bold: false, italic: false },
    ]);
  });

  test("triple markers are bold and italic", () => {
    expect(parseInlineEmphasisRuns("***Term***")).toEqual([
      { text: "Term", bold: true, italic: true },
    ]);
  });

  test("underscore placeholders stay literal (not emphasis)", () => {
    expect(
      parseInlineEmphasisRuns("__Borrower__ and ___EffectiveDate___"),
    ).toEqual([
      {
        text: "__Borrower__ and ___EffectiveDate___",
        bold: false,
        italic: false,
      },
    ]);
  });

  test("two bold spans in one line", () => {
    expect(parseInlineEmphasisRuns("**a** and **b**")).toEqual([
      { text: "a", bold: true, italic: false },
      { text: " and ", bold: false, italic: false },
      { text: "b", bold: true, italic: false },
    ]);
  });

  test("plain prose stays a single literal run", () => {
    expect(parseInlineEmphasisRuns("Date: {{date}}")).toEqual([
      { text: "Date: {{date}}", bold: false, italic: false },
    ]);
  });

  test("single asterisks are left literal (not italic)", () => {
    expect(parseInlineEmphasisRuns("quantity 5*3*2 units")).toEqual([
      { text: "quantity 5*3*2 units", bold: false, italic: false },
    ]);
  });

  test("unbalanced markers stay literal", () => {
    expect(parseInlineEmphasisRuns("see **infra")).toEqual([
      { text: "see **infra", bold: false, italic: false },
    ]);
  });

  test("space-flanked markers are not a span", () => {
    expect(parseInlineEmphasisRuns("a ** b ** c")).toEqual([
      { text: "a ** b ** c", bold: false, italic: false },
    ]);
  });

  test("backslashes are ordinary characters (no markdown escapes)", () => {
    expect(parseInlineEmphasisRuns("price \\*per unit\\*")).toEqual([
      { text: "price \\*per unit\\*", bold: false, italic: false },
    ]);
  });

  test("a backslash path survives next to a bold span", () => {
    expect(parseInlineEmphasisRuns("**Note:** path C:\\*.txt")).toEqual([
      { text: "Note:", bold: true, italic: false },
      { text: " path C:\\*.txt", bold: false, italic: false },
    ]);
  });
});

describe("stripInlineEmphasisMarkers", () => {
  test("drops markers from a bold span", () => {
    expect(stripInlineEmphasisMarkers("**Date:** 2026")).toBe("Date: 2026");
  });

  test("keeps a backslash path when stripping an adjacent bold span", () => {
    expect(stripInlineEmphasisMarkers("**Note:** path C:\\*.txt")).toBe(
      "Note: path C:\\*.txt",
    );
  });

  test("returns plain prose verbatim", () => {
    for (const input of [
      "Date: {{date}}",
      "quantity 5*3*2 units",
      "path C:\\*.txt",
      "see **infra",
      "__Borrower__ pays ___EffectiveDate___",
    ]) {
      expect(stripInlineEmphasisMarkers(input)).toBe(input);
    }
  });
});
