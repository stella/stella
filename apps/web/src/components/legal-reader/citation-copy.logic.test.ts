import { describe, expect, test } from "bun:test";

import { UI_LANGUAGES } from "@stll/locales";
import type { UiLanguageCode } from "@stll/locales";

import {
  citationCopyText,
  PREVIEW_QUOTE_CHARS,
  previewQuotation,
  quotationMarksFor,
} from "@/components/legal-reader/citation-copy.logic";

const CITATION =
  "nález Ústavního soudu ze dne 15. 4. 2026, sp. zn. III.ÚS 2429/24, bod 22";
const QUOTE = "Rozhodování samosoudcem lze akceptovat pouze tam";

const EXPECTED_QUOTATION_BY_LANGUAGE = {
  ar: "«text»",
  cs: "„text“",
  de: "„text“",
  en: "“text”",
  es: "«text»",
  et: "„text“",
  fr: "«\u202Ftext\u202F»",
  hu: "„text”",
  lt: "„text“",
  lv: "„text“",
  pl: "„text”",
  pt: "“text”",
  sk: "„text“",
} as const satisfies Record<UiLanguageCode, string>;

describe("quotation marks follow the source's language", () => {
  test("a Czech decision is quoted „…“ whatever the interface language", () => {
    const marks = quotationMarksFor({ country: "CZE", language: "cs" });
    expect(
      citationCopyText("quoteWithCitation", {
        citation: CITATION,
        marks,
        quote: QUOTE,
      }),
    ).toBe(`„${QUOTE}“ ${CITATION}.`);
    expect(
      citationCopyText("citationWithQuote", {
        citation: CITATION,
        marks,
        quote: QUOTE,
      }),
    ).toBe(`${CITATION} („${QUOTE}“).`);
  });

  test("the document's language wins over its court's country", () => {
    expect(quotationMarksFor({ country: "CZE", language: "en" })).toEqual({
      close: "”",
      open: "“",
    });
    expect(quotationMarksFor({ country: "EU", language: "fr" })).toEqual({
      close: " »",
      open: "« ",
    });
  });

  test("without a language, the court's country decides", () => {
    expect(quotationMarksFor({ country: "svk", language: null })).toEqual({
      close: "“",
      open: "„",
    });
    expect(quotationMarksFor({ country: "POL", language: null })).toEqual({
      close: "”",
      open: "„",
    });
    expect(quotationMarksFor({ country: "USA", language: null })).toEqual({
      close: "”",
      open: "“",
    });
  });

  test("forms without a quotation carry no marks", () => {
    const marks = quotationMarksFor({ country: "CZE", language: "cs" });
    expect(
      citationCopyText("blockQuoteWithCitation", {
        citation: CITATION,
        marks,
        quote: QUOTE,
      }),
    ).toBe(`${QUOTE}\n\n${CITATION}.`);
    expect(
      citationCopyText("textOnly", { citation: CITATION, marks, quote: QUOTE }),
    ).toBe(QUOTE);
  });
});

describe("every UI language has its own quotation marks", () => {
  test.each(UI_LANGUAGES)(
    "$code text is quoted in its marks, by base code or UI locale",
    ({ code, uiLocale }) => {
      for (const language of [code, uiLocale, uiLocale.toUpperCase()]) {
        const marks = quotationMarksFor({ country: null, language });
        expect(`${marks.open}text${marks.close}`).toBe(
          EXPECTED_QUOTATION_BY_LANGUAGE[code],
        );
      }
    },
  );
});

describe("a copy preview trims a long quotation after a whole word", () => {
  const word = "Rozhodování";
  const long = Array.from({ length: 40 }, () => word).join(" ");

  test("a quotation within the budget is shown whole", () => {
    expect(previewQuotation(QUOTE)).toBe(QUOTE);
  });

  test("a long quotation ends on a whole word and an ellipsis", () => {
    const preview = previewQuotation(long);
    expect(preview.endsWith(`${word}…`)).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_QUOTE_CHARS + 1);
    expect(long.startsWith(preview.slice(0, -1))).toBe(true);
  });

  test("a break right at the budget keeps the full budget", () => {
    const exact = `${"a".repeat(PREVIEW_QUOTE_CHARS)} tail`;
    expect(previewQuotation(exact)).toBe(`${"a".repeat(PREVIEW_QUOTE_CHARS)}…`);
  });

  test("one unbroken token is cut at the budget", () => {
    const token = `ab ${"x".repeat(PREVIEW_QUOTE_CHARS * 2)}`;
    expect(previewQuotation(token)).toBe(
      `${token.slice(0, PREVIEW_QUOTE_CHARS)}…`,
    );
  });

  test("whitespace before the cut stays out of the preview", () => {
    const body = "b".repeat(PREVIEW_QUOTE_CHARS - 20);
    const spaced = `${word}\n\n${body}  ${word.repeat(3)}`;
    expect(previewQuotation(spaced)).toBe(`${word}\n\n${body}…`);
  });
});
