import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_HEADNOTE_TRUNCATION_MARK } from "@stll/api-contract/case-law-text-field";
import { propertyConfig } from "@stll/property-testing";

import {
  collapseDecisionHeadnote,
  normalizeDecisionHeadnote,
  normalizeDecisionKeywords,
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
        // One break between lines, one space inside them, and nothing else:
        // the publisher's structure survives, their typing does not.
        expect(headnote.text).not.toMatch(/[^\S\n]{2}/u);
        expect(headnote.text).not.toMatch(/\n\s|\s\n/u);
        expect(headnote.text).not.toMatch(/[\t\r]/u);
        expect(headnote.text.isWellFormed()).toBe(true);
      }),
      propertyConfig(),
    );
  });

  test("short text passes through with its spacing collapsed", () => {
    expect(normalizeDecisionHeadnote("  Nájemní   smlouva \tvýpověď ")).toEqual(
      { text: "Nájemní smlouva výpověď", truncated: false },
    );
  });

  test("the publisher's numbered points keep their own lines", () => {
    // How a Constitutional Court headnote is written, and why a flattened one
    // reads as a single sentence saying three different things.
    expect(
      normalizeDecisionHeadnote(
        "I. První bod.\r\n\r\n\r\nII.  Druhý   bod.\nIII. Třetí bod.",
      ),
    ).toEqual({
      text: "I. První bod.\nII. Druhý bod.\nIII. Třetí bod.",
      truncated: false,
    });
  });

  test("a break between lines is not a line of its own", () => {
    expect(normalizeDecisionHeadnote("\n\n  Jediná věta.  \n \t \n")).toEqual({
      text: "Jediná věta.",
      truncated: false,
    });
  });

  test("a cut falling on a break leaves no break behind", () => {
    // The first point fills the row, and the second opens with a word too
    // long to fit, so the only boundary the cut can take is the break itself.
    const first = "I. ".concat("a".repeat(LIMITS.caseLawHeadnoteMaxChars - 5));
    const headnote = normalizeDecisionHeadnote(`${first}\n${"II".repeat(20)}`);

    expect(headnote?.truncated).toBe(true);
    expect(headnote?.text).toMatch(/…$/u);
    expect(headnote?.text).not.toMatch(/\s…$/u);
    expect(headnote?.text.length).toBeLessThanOrEqual(
      LIMITS.caseLawHeadnoteMaxChars,
    );
  });

  test("a term of a classification is one line whatever the publisher typed", () => {
    expect(normalizeDecisionKeywords(["Nájem\nbytu", "  Výpověď  "])).toEqual({
      items: ["Nájem bytu", "Výpověď"],
      omitted: 0,
    });
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

  test("the preview is the whole line's own opening", () => {
    fc.assert(
      fc.property(headnoteTextArbitrary, (raw) => {
        const whole = collapseDecisionHeadnote(raw);
        const preview = normalizeDecisionHeadnote(raw);
        if (whole === null) {
          expect(preview).toBeNull();
          return;
        }
        expect(preview).not.toBeNull();
        if (preview === null || !preview.truncated) {
          expect(preview?.text).toBe(whole);
          return;
        }
        // The row that shows the rest continues this text; it does not
        // replace it with a second reading of the same field.
        expect(
          whole.startsWith(
            preview.text.slice(0, -DECISION_HEADNOTE_TRUNCATION_MARK.length),
          ),
        ).toBe(true);
        expect(whole.length).toBeGreaterThan(preview.text.length);
      }),
      propertyConfig(),
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
