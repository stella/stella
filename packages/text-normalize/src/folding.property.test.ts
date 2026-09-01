/**
 * Properties of the fold family: the normalizers that build search match
 * keys.
 *
 * Each is a many-to-one map from written text to a comparison key, and
 * each is applied on both sides of a comparison — once over indexed
 * text, once over a query — so the invariants that matter are stability
 * (folding twice changes nothing) and agreement between a fold and its
 * offset-carrying twin. An offset map that disagrees with its own text
 * misplaces every highlight after the first divergence.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { applyArabicFolds, applyArabicFoldsWithOffsets } from "./arabic.js";
import { foldToAscii } from "./ascii-fold.js";
import { stripDiacritics, stripDiacriticsForSlug } from "./diacritics.js";
import { arabicNormalize } from "./normalize.js";
import {
  findSearchMatchRanges,
  foldSearchMatchText,
  foldSearchMatchTextWithOffsets,
} from "./search-match.js";

// Seeded in PR CI so a counterexample is reproducible from the log, and
// unseeded under the nightly sweep so it explores new inputs. See
// propertySeed in @stll/property-testing.

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

/**
 * Characters from every script and shape these folds claim to handle:
 * Latin with diacritics, Latin letters with no decomposition (ł, ø, ß),
 * compatibility ligatures, dotted and dotless i, Greek final sigma,
 * Arabic with tashkeel, and Arabic-Indic digits.
 */
const SCRIPT_CHARACTERS = "abzAZáčěŘšůžłøđßæœﬁﬂİıΣσςΟمحمدًٌَُّْ٠١٢٣0123".split("");

/** No-break space: a word gap that survives HTML whitespace collapsing. */
const NBSP = String.fromCodePoint(0x00_a0);

/** Arabic tatweel, a pure elongation joiner the folds strip. */
const TATWEEL = String.fromCodePoint(0x06_40);

const SEPARATORS = [" ", "  ", "\n", "\t", NBSP, TATWEEL];

const CHARACTERS = [...SCRIPT_CHARACTERS, ...SEPARATORS];

const text = fc
  .array(fc.constantFrom(...CHARACTERS), { maxLength: 24 })
  .map((parts) => parts.join(""));

const FOLDS = {
  foldToAscii,
  stripDiacritics,
  stripDiacriticsForSlug,
  arabicNormalize,
  applyArabicFolds,
  foldSearchMatchText,
} as const satisfies Record<string, (value: string) => string>;

describe("fold family (properties)", () => {
  /**
   * A match key is stable: folding an already-folded string changes
   * nothing. Without this the index side and the query side of a
   * comparison can disagree purely over how many times each was folded.
   */
  for (const [name, fold] of Object.entries(FOLDS)) {
    test(`${name} is idempotent`, () => {
      fc.assert(
        fc.property(text, (value) => {
          const once = fold(value);

          expect(fold(once)).toBe(once);
        }),
        config(400),
      );
    });
  }

  /** Folding never invents characters out of an empty string. */
  test("every fold maps the empty string to itself", () => {
    for (const fold of Object.values(FOLDS)) {
      expect(fold("")).toBe("");
    }
  });
});

describe("offset-carrying folds (properties)", () => {
  /**
   * The contract that actually holds, and the one the callers rely on:
   * the two variants agree once the input is NFKC-normalized.
   *
   * They sit on opposite sides of one comparison in the API's search
   * highlighter — the source through the offset variant to keep its
   * positions, each candidate through the plain one — and both arrive
   * already NFKC-normalized, the source via
   * `normalizeSourceWithMappings` and the candidate via
   * `arabicNormalize`. A disagreement in that state would paint a
   * highlight over the wrong word.
   */
  test("the variants agree on NFKC-normalized input", () => {
    fc.assert(
      fc.property(text, (value) => {
        const normalized = value.normalize("NFKC");

        expect(applyArabicFoldsWithOffsets(normalized).text).toBe(
          applyArabicFolds(normalized),
        );
      }),
      config(400),
    );
  });

  /**
   * The asymmetry on raw input is deliberate, not a defect, and is
   * pinned here so it is not "fixed" into agreement later.
   *
   * The offset variant normalizes NFKC per character because it is fed
   * raw document text: Arabic PDFs carry presentation forms and
   * ligatures that have to expand to canonical letters to be searchable,
   * and per-character expansion is what keeps each output unit pointing
   * at the one source character it came from. The plain variant folds
   * only, leaving normalization to `arabicNormalize`.
   *
   * Aligning them by dropping that normalization breaks the offset
   * variant's whole purpose — see the presentation-form and ligature
   * cases in arabic.test.ts.
   */
  test("only the offset variant normalizes raw compatibility characters", () => {
    expect(applyArabicFolds("ﬁ")).toBe("ﬁ");
    expect(applyArabicFoldsWithOffsets("ﬁ").text).toBe("fi");
    expect(arabicNormalize("ﬁ")).toBe("fi");
  });

  test("foldSearchMatchTextWithOffsets agrees with foldSearchMatchText", () => {
    fc.assert(
      fc.property(text, (value) => {
        expect(foldSearchMatchTextWithOffsets(value).text).toBe(
          foldSearchMatchText(value),
        );
      }),
      config(400),
    );
  });

  /**
   * Every folded character maps back to a real, forward-ordered slice of
   * the original. A range running backwards or past the end of the input
   * is an anchor that cannot be rendered.
   */
  test("folded offsets stay inside the original and never run backwards", () => {
    fc.assert(
      fc.property(text, (value) => {
        const { text: folded, originalRanges } =
          foldSearchMatchTextWithOffsets(value);

        expect(originalRanges).toHaveLength(folded.length);
        let previousStart = 0;
        for (const { start, end } of originalRanges) {
          expect(start).toBeGreaterThanOrEqual(previousStart);
          expect(end).toBeGreaterThanOrEqual(start);
          expect(end).toBeLessThanOrEqual(value.length);
          previousStart = start;
        }
      }),
      config(400),
    );
  });
});

describe("findSearchMatchRanges (properties)", () => {
  /**
   * Every reported range is a real occurrence: folding the slice it
   * points at yields the folded query. This is the property that keeps a
   * highlight on the text that actually matched, across a fold that
   * changes string length (`ß` to `ss`, `ﬁ` to `fi`).
   */
  test("every reported range folds to the query", () => {
    fc.assert(
      fc.property(text, text, (content, query) => {
        // Mirror the trim the function applies to its own query, or the
        // needle looked for is not the one it searched with.
        const folded = foldSearchMatchText(query.trim());
        fc.pre(folded.length > 0);

        for (const { start, end } of findSearchMatchRanges(content, query)) {
          expect(foldSearchMatchText(content.slice(start, end))).toContain(
            folded,
          );
        }
      }),
      config(300),
    );
  });

  /** Ranges are ordered and never overlap, so highlights cannot nest. */
  test("reported ranges are ordered and disjoint", () => {
    fc.assert(
      fc.property(text, text, (content, query) => {
        const ranges = findSearchMatchRanges(content, query);

        let previousEnd = 0;
        for (const { start, end } of ranges) {
          expect(start).toBeGreaterThanOrEqual(previousEnd);
          expect(end).toBeGreaterThan(start);
          previousEnd = end;
        }
      }),
      config(300),
    );
  });

  /** A blank query matches nothing rather than everything. */
  test("a whitespace-only query reports no ranges", () => {
    fc.assert(
      fc.property(
        text,
        fc.constantFrom("", " ", "   ", "\n"),
        (content, query) => {
          expect(findSearchMatchRanges(content, query)).toEqual([]);
        },
      ),
      config(200),
    );
  });
});
