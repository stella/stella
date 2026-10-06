/**
 * Properties of the reader's display elisions over generated text mixing
 * letter-spaced words, ordinary words, one-letter prepositions, gaps of one
 * or more spaces, quotation marks and backslashes.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { collapseSpacedLetters } from "@stll/text-normalize";

import {
  DISPLAY_ELISION_KIND,
  displayElisions,
  drawnText,
} from "./display-elision.js";
import type { DisplayElision } from "./display-elision.js";

const LETTERS = "abcdeiklmnoprstuvzáčďéěíňóřšťúůýžODÚVNĚÍ".split("");
const letter = fc.constantFrom(...LETTERS);
const word = fc
  .array(letter, { minLength: 2, maxLength: 9 })
  .map((letters) => letters.join(""));
const gap = fc.constantFrom(" ", "  ", "   ");
const spacedWord = fc
  .tuple(fc.array(letter, { minLength: 1, maxLength: 9 }), gap)
  .map(([letters, separator]) => letters.join(separator));
const token = fc.oneof(
  word,
  spacedWord,
  fc.constantFrom("a", "k", "v", "§", "237", ":", ".", '\\"', '"', "\\", "\n"),
);
const textArb = fc
  .array(fc.tuple(token, gap), { maxLength: 14 })
  .map((parts) => parts.map(([part, separator]) => part + separator).join(""));

/** Any text over letters, spaces, quotation marks and backslashes. */
const rawTextArb = fc
  .array(fc.constantFrom("a", "ž", " ", '"', "\\", "„", "“"), {
    maxLength: 40,
  })
  .map((characters) => characters.join(""));

/** Space runs drawn as one, as a browser draws collapsible whitespace. */
const squeeze = (text: string): string => text.replaceAll(/ {2,}/gu, " ");

const ofKind = (
  elisions: readonly DisplayElision[],
  kind: DisplayElision["kind"],
): DisplayElision[] => elisions.filter((elision) => elision.kind === kind);

/** A publisher's escape: a backslash before every quotation mark. */
const escapeQuotes = (text: string): string =>
  text.replaceAll('"', () => '\\"');

describe("the reader's display elisions", () => {
  test("draw the text as the shared letter-spacing rule folds it", () => {
    assertProperty(
      "draw the text as the shared letter-spacing rule folds it",
      fc.property(textArb, (text) => {
        const spacing = ofKind(
          displayElisions(text),
          DISPLAY_ELISION_KIND.LETTER_SPACING,
        );
        expect(squeeze(drawnText(text, spacing))).toBe(
          collapseSpacedLetters(text),
        );
      }),
    );
  });

  test("are idempotent: drawn text has nothing left to elide", () => {
    assertProperty(
      "are idempotent: drawn text has nothing left to elide",
      fc.property(textArb, (text) => {
        const once = squeeze(drawnText(text, displayElisions(text)));
        expect(displayElisions(once)).toEqual([]);
      }),
    );
  });

  test("leave text without a spaced run or an escaped quote unchanged", () => {
    assertProperty(
      "leave text without a spaced run or an escaped quote unchanged",
      fc.property(
        fc.array(word, { maxLength: 12 }).map((words) => words.join(" ")),
        (text) => {
          expect(displayElisions(text)).toEqual([]);
        },
      ),
    );
  });

  test("map back: elided and drawn characters partition the source", () => {
    assertProperty(
      "map back: elided and drawn characters partition the source",
      fc.property(textArb, (text) => {
        const elisions = displayElisions(text);
        let cursor = 0;
        let rebuilt = "";
        for (const elision of elisions) {
          expect(elision.start).toBeGreaterThanOrEqual(cursor);
          expect(elision.end).toBeGreaterThan(elision.start);
          const elided = text.slice(elision.start, elision.end);
          // Only spaces, and a backslash right before a quotation mark, are
          // ever left undrawn.
          if (elision.kind === DISPLAY_ELISION_KIND.ESCAPED_QUOTE) {
            expect(elided).toBe("\\");
            expect(text.charAt(elision.end)).toBe('"');
          } else {
            expect(elided.trim()).toBe("");
          }
          rebuilt += text.slice(cursor, elision.start) + elided;
          cursor = elision.end;
        }
        rebuilt += text.slice(cursor);
        expect(rebuilt).toBe(text);
        expect(drawnText(text, elisions).length).toBe(
          text.length -
            elisions.reduce((total, { end, start }) => total + end - start, 0),
        );
      }),
    );
  });

  test("draw an escaped text as it was before the escape", () => {
    assertProperty(
      "draw an escaped text as it was before the escape",
      fc.property(
        rawTextArb.filter((text) => !text.includes('\\"')),
        (text) => {
          const escaped = escapeQuotes(text);
          const quotes = ofKind(
            displayElisions(escaped),
            DISPLAY_ELISION_KIND.ESCAPED_QUOTE,
          );
          expect(drawnText(escaped, quotes)).toBe(text);
        },
      ),
    );
  });

  test("keep every backslash of a text that is not escaped throughout", () => {
    assertProperty(
      "keep every backslash of a text that is not escaped throughout",
      fc.property(rawTextArb, (text) => {
        const quotes = ofKind(
          displayElisions(text),
          DISPLAY_ELISION_KIND.ESCAPED_QUOTE,
        );
        const quoteMarks = [...text.matchAll(/"/gu)];
        const escapedThroughout =
          quoteMarks.length > 0 &&
          quoteMarks.every(
            ({ index }) =>
              text.charAt(index - 1) === "\\" &&
              text.charAt(index - 2) !== "\\",
          );
        expect(quotes.length).toBe(escapedThroughout ? quoteMarks.length : 0);
      }),
    );
  });
});
