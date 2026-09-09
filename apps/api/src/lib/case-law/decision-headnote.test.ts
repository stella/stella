import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_HEADNOTE_TRUNCATION_MARK } from "@stll/api-contract/case-law-text-field";
import { propertyConfig } from "@stll/property-testing";

import {
  normalizeDecisionHeadnote,
  truncateDecisionHeadnote,
} from "@/api/lib/case-law/decision-headnote";
import { LIMITS } from "@/api/lib/limits";

const headnoteTextArbitrary = fc.oneof(
  fc.string({ minLength: 0, maxLength: 800, unit: "grapheme" }),
  fc.string({
    minLength: LIMITS.caseLawHeadnoteMaxChars + 1,
    maxLength: LIMITS.caseLawHeadnoteMaxChars + 80,
    unit: fc.constant("a"),
  }),
);

describe("headnote text fits one row", () => {
  test("never exceeds the budget and never carries stray whitespace", () => {
    fc.assert(
      fc.property(headnoteTextArbitrary, (raw) => {
        const headnote = normalizeDecisionHeadnote(raw);
        if (headnote === null) {
          expect(raw.trim()).toBe("");
          return;
        }
        expect(headnote.text.length).toBeLessThanOrEqual(
          LIMITS.caseLawHeadnoteMaxChars,
        );
        expect(headnote.text).toBe(headnote.text.trim());
        expect(headnote.text).not.toMatch(/\s{2}/u);
        expect(headnote.text).not.toMatch(/[\n\t]/u);
        expect(headnote.text.isWellFormed()).toBe(true);
      }),
      propertyConfig(),
    );
  });

  test("short text passes through with its whitespace collapsed", () => {
    expect(
      normalizeDecisionHeadnote("  Nájemní   smlouva\n\tvýpověď "),
    ).toEqual({ text: "Nájemní smlouva výpověď", truncated: false });
  });

  test("long text is cut on a word boundary and reports truncation", () => {
    const words = Array.from({ length: 80 }, (_, i) => `slovo${i}`).join(" ");
    const headnote = normalizeDecisionHeadnote(words);

    expect(headnote).not.toBeNull();
    expect(headnote?.truncated).toBe(true);
    expect(headnote?.text).toMatch(/slovo\d+…$/u);
    expect(headnote?.text.length).toBeLessThanOrEqual(
      LIMITS.caseLawHeadnoteMaxChars,
    );
  });

  test("nothing but whitespace, or a non-string, is no headnote", () => {
    expect(normalizeDecisionHeadnote("   \n ")).toBeNull();
    expect(normalizeDecisionHeadnote(null)).toBeNull();
    expect(normalizeDecisionHeadnote(["legal sentence"])).toBeNull();
  });
});

describe("headnote cuts are explicit word-boundary decisions", () => {
  test("preserves short text and cuts arbitrary long text only between segments", () => {
    const segmenter = new Intl.Segmenter("und", { granularity: "word" });

    fc.assert(
      fc.property(headnoteTextArbitrary, (text) => {
        const headnote = truncateDecisionHeadnote(text);
        if (text.length <= LIMITS.caseLawHeadnoteMaxChars) {
          expect(headnote).toEqual({ text, truncated: false });
          return;
        }

        expect(headnote.truncated).toBe(true);
        expect(headnote.text.endsWith(DECISION_HEADNOTE_TRUNCATION_MARK)).toBe(
          true,
        );
        const prefix = headnote.text.slice(
          0,
          -DECISION_HEADNOTE_TRUNCATION_MARK.length,
        );
        expect(text.startsWith(prefix)).toBe(true);
        expect(headnote.text.length).toBeLessThanOrEqual(
          LIMITS.caseLawHeadnoteMaxChars,
        );
        const boundaries = new Set(
          [...segmenter.segment(text)].map(
            ({ index, segment }) => index + segment.length,
          ),
        );
        expect(prefix.length === 0 || boundaries.has(prefix.length)).toBe(true);
      }),
      propertyConfig(),
    );
  });

  test("does not invent a boundary by slicing through a flag", () => {
    const prefix = "a".repeat(LIMITS.caseLawHeadnoteMaxChars - 2);

    expect(truncateDecisionHeadnote(`${prefix}🇨🇿tail`)).toEqual({
      text: `${prefix}${DECISION_HEADNOTE_TRUNCATION_MARK}`,
      truncated: true,
    });
  });
});
