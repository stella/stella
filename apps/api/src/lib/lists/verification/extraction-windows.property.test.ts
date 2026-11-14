/**
 * What must hold for any text a run reads, however its blocks are sized: no
 * extraction call is asked about more text than the window budget, every
 * piece of text is asked about exactly once, and a piece's offsets are its
 * own words in the whole block, so an anchor found in a piece lands where
 * the reader shows it.
 */

import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  BYTES_PER_TOKEN_ESTIMATE,
  estimateTextTokens,
} from "@/api/lib/ai-generation/token-estimate";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import {
  EXTRACTION_CONTEXT_TOKENS,
  EXTRACTION_WINDOW_TOKENS,
  extractionPieces,
  extractionWindows,
  pieceLine,
  splitText,
  windowContext,
  windowFits,
  windowText,
} from "@/api/lib/lists/verification/extraction-windows";
import type { VerificationPassage } from "@/api/lib/lists/verification/paragraph-scope";

/** Words in several scripts, so byte and character lengths differ. */
const WORD = fc.constantFrom(
  "the",
  "care",
  "homes",
  "discharge",
  "agreed",
  "£1.3bn",
  "žádost",
  "ověřeno",
  "über",
  "تحقق",
  "确认",
  "🙂",
  "(a)",
  "82.",
  "“quoted”",
);
const SEPARATOR = fc.constantFrom(" ", ". ", ".\n", "\n", "\n\n", ", ");

/** Text from a few words to several pages, laid out as prose and lines. */
const prose = fc
  .array(fc.tuple(WORD, SEPARATOR), { minLength: 1, maxLength: 3000 })
  .map((parts) => parts.map(([word, separator]) => word + separator).join(""));

const passages = fc
  .array(fc.tuple(prose, fc.boolean(), fc.nat(), fc.nat(), fc.boolean()), {
    minLength: 1,
    maxLength: 8,
  })
  .map((entries) =>
    entries.map(([text, pdf, a, b, sliced], index): VerificationPassage => {
      const id = pdf ? `P${String(index + 1)}` : `b${String(index)}`;
      const block: VerificationBlock = {
        id,
        text,
        source: pdf
          ? { type: "pdf-page", pageNumber: index + 1 }
          : { type: "docx-block", blockId: id },
      };
      // A paragraph scope reads a slice of a block; offsets stay the
      // block's own.
      const from = sliced ? a % (text.length + 1) : 0;
      const to = sliced ? from + (b % (text.length - from + 1)) : text.length;
      return { block, start: from, end: to };
    }),
  );

test("no window is over budget, and every piece is asked about exactly once", () => {
  assertProperty(
    "no window is over budget, and every piece is asked about exactly once",
    fc.property(passages, (input) => {
      const pieces = extractionPieces(input);
      const windows = extractionWindows(pieces);
      let next = 0;
      for (const window of windows) {
        expect(window.from).toBe(next);
        expect(window.to).toBeGreaterThan(window.from);
        const asked = pieces.slice(window.from, window.to);
        expect(windowFits(asked)).toBe(true);
        expect(estimateTextTokens(windowText(asked))).toBeLessThanOrEqual(
          EXTRACTION_WINDOW_TOKENS,
        );
        next = window.to;
      }
      expect(next).toBe(pieces.length);
    }),
  );
});

test("pieces round-trip to the passage text in whole-block offsets", () => {
  assertProperty(
    "pieces round-trip to the passage text in whole-block offsets",
    fc.property(passages, (input) => {
      const pieces = extractionPieces(input);
      expect(new Set(pieces.map((piece) => piece.id)).size).toBe(pieces.length);
      for (const [passageIndex, passage] of input.entries()) {
        const own = pieces.filter(
          (piece) => piece.passageIndex === passageIndex,
        );
        expect(own.length).toBeGreaterThan(0);
        let offset = passage.start;
        for (const piece of own) {
          expect(piece.start).toBe(offset);
          expect(piece.text).toBe(
            passage.block.text.slice(piece.start, piece.end),
          );
          offset = piece.end;
        }
        expect(offset).toBe(passage.end);
        // A block read whole keeps its own id; a cut one numbers its pieces.
        if (own.length === 1) {
          expect(own[0]?.id).toBe(passage.block.id);
        } else {
          for (const piece of own) {
            expect(piece.id.startsWith(`${passage.block.id}~`)).toBe(true);
          }
        }
      }
    }),
  );
});

test("context around a window is the nearest text, within its budget", () => {
  assertProperty(
    "context around a window is the nearest text, within its budget",
    fc.property(passages, (input) => {
      const pieces = extractionPieces(input);
      for (const window of extractionWindows(pieces)) {
        const { before, after } = windowContext(pieces, window);
        for (const side of [before, after]) {
          const bytes = side.reduce(
            (sum, piece) =>
              sum + Buffer.byteLength(pieceLine(piece.id, piece.text)) + 1,
            0,
          );
          expect(bytes).toBeLessThanOrEqual(
            EXTRACTION_CONTEXT_TOKENS * BYTES_PER_TOKEN_ESTIMATE,
          );
        }
        // Before: the pieces just ahead of the window, the farthest one
        // possibly cut to its end.
        for (const [index, piece] of before.entries()) {
          const whole =
            pieces[window.from - before.length + index] ??
            panic("A context piece is in range");
          expect(piece.id).toBe(whole.id);
          expect(
            index === 0
              ? whole.text.endsWith(piece.text)
              : whole.text === piece.text,
          ).toBe(true);
        }
        for (const [index, piece] of after.entries()) {
          const whole =
            pieces[window.to + index] ?? panic("A context piece is in range");
          expect(piece.id).toBe(whole.id);
          expect(
            index === after.length - 1
              ? whole.text.startsWith(piece.text)
              : whole.text === piece.text,
          ).toBe(true);
        }
      }
    }),
  );
});

test("a long page is cut after a sentence or a blank line, not mid-word", () => {
  const sentence = "The plan was agreed with the council on 2 April. ";
  const page = `${sentence.repeat(200)}\n\n${sentence.repeat(200)}`;
  const spans = splitText(page, 0, page.length, 9000);
  expect(spans.length).toBeGreaterThan(1);
  for (const span of spans.slice(0, -1)) {
    // Every cut lands after a sentence's closing space or a blank line.
    expect(page.slice(span.start, span.end)).toMatch(/(?:\. |\n\n)$/u);
  }
  expect(spans.at(-1)?.end).toBe(page.length);
});

test("a surrogate pair is never cut in half", () => {
  const text = "🙂".repeat(5000);
  for (const span of splitText(text, 0, text.length, 9001)) {
    expect(span.start % 2).toBe(0);
    expect(span.end % 2).toBe(0);
  }
});
