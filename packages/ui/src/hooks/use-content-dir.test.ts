import { describe, expect, test } from "bun:test";

import { contentDir, isStructuredInputType } from "./use-content-dir";

/**
 * Bidi direction resolution for free-text fields.
 *
 * The direction of a user-text field is *not* segmented in JS: `BidiText`
 * (`../components/bidi-text.tsx`) and the shared inputs delegate per-character
 * bidi to the browser via `dir="auto"` + `unicode-bidi: isolate`. The only
 * decision made in JS is `contentDir`: whether to emit `dir="auto"` (let the
 * content pick its own direction) or omit `dir` entirely (inherit the ambient
 * UI direction so an empty field keeps its caret on the RTL side under Arabic).
 *
 * These tests pin that script-agnostic contract: any non-empty value resolves
 * to `"auto"` regardless of script or mix (Latin, Arabic, mixed runs, digits),
 * and only an empty value inherits. A regression that started computing a
 * concrete `"ltr"`/`"rtl"` from the text in JS — instead of deferring to the
 * browser — would break this and mis-place carets in mixed content.
 */

const ARABIC = "السلام عليكم";
const LATIN = "Hello world";
// A Latin sentence carrying an Arabic quotation.
const LTR_WITH_ARABIC = 'He said "السلام" today';
// An Arabic sentence carrying a Latin case citation.
const RTL_WITH_LATIN = "حكم رقم Smith v Jones لعام";
// Digits embedded in an Arabic run.
const RTL_WITH_NUMBERS = "المادة 42 من القانون";

describe("contentDir", () => {
  test("empty string inherits the ambient direction (no dir attribute)", () => {
    expect(contentDir("")).toBeUndefined();
  });

  test("undefined value inherits the ambient direction", () => {
    expect(contentDir(undefined)).toBeUndefined();
  });

  test("pure LTR text resolves to auto", () => {
    expect(contentDir(LATIN)).toBe("auto");
  });

  test("pure RTL (Arabic) text resolves to auto", () => {
    expect(contentDir(ARABIC)).toBe("auto");
  });

  test("LTR text with an Arabic quote resolves to auto", () => {
    expect(contentDir(LTR_WITH_ARABIC)).toBe("auto");
  });

  test("RTL text with a Latin citation resolves to auto", () => {
    expect(contentDir(RTL_WITH_LATIN)).toBe("auto");
  });

  test("digits inside an RTL run resolve to auto", () => {
    expect(contentDir(RTL_WITH_NUMBERS)).toBe("auto");
  });

  test("script never changes the outcome: all non-empty text is auto", () => {
    // The decision is content-presence, not script; the browser segments.
    for (const value of [LATIN, ARABIC, LTR_WITH_ARABIC, RTL_WITH_LATIN]) {
      expect(contentDir(value)).toBe("auto");
    }
  });

  test("whitespace-only text counts as content (auto, not inherit)", () => {
    expect(contentDir(" ")).toBe("auto");
  });

  test("a numeric value counts as content", () => {
    expect(contentDir(0)).toBe("auto");
    expect(contentDir(42)).toBe("auto");
  });

  test("a multi-value field is content only when non-empty", () => {
    expect(contentDir([])).toBeUndefined();
    expect(contentDir(["a"])).toBe("auto");
  });
});

describe("isStructuredInputType", () => {
  test("structured input types are treated as always-LTR", () => {
    for (const type of [
      "email",
      "url",
      "tel",
      "number",
      "password",
      "date",
      "datetime-local",
      "time",
      "month",
      "week",
    ]) {
      expect(isStructuredInputType(type)).toBe(true);
    }
  });

  test("free-text and unspecified types are not structured", () => {
    expect(isStructuredInputType("text")).toBe(false);
    expect(isStructuredInputType("search")).toBe(false);
    expect(isStructuredInputType(undefined)).toBe(false);
  });
});
