import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import type { Block, Inline } from "@stll/legal-ast/document-ast";
import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  buildDocumentAstSearchPieces,
  inlinesToPlainText,
} from "@/components/legal-reader/document-ast-text";
import type { ReaderMarkRange } from "@/components/legal-reader/reader-search";
import {
  compareText,
  diffMarkRanges,
  markSide,
  splitSurroundingWhitespace,
} from "@/features/statutes/statute-diff-marks";

const WHITESPACE = /\s/u;

// Words, spaces, line breaks and a non-breaking space: the characters a
// changed run is trimmed by, and the ones it is not.
const segmentText = fc
  .array(fc.constantFrom("a", "b", "§", " ", "\n", "\u00a0", "\t"), {
    maxLength: 8,
  })
  .map((characters) => characters.join(""));

const segmentArbitrary = fc.record({
  type: fc.constantFrom("equal", "del", "ins"),
  text: segmentText,
});

type Positioned = { start: number; segment: WordDiffSegment };

const positioned = (segments: readonly WordDiffSegment[]): Positioned[] => {
  const list: Positioned[] = [];
  let start = 0;
  for (const segment of segments) {
    list.push({ start, segment });
    start += segment.text.length;
  }
  return list;
};

const covered = (ranges: readonly ReaderMarkRange[]): Set<number> => {
  const positions = new Set<number>();
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      positions.add(index);
    }
  }
  return positions;
};

describe("splitSurroundingWhitespace", () => {
  test("leaves the line break before an added heading title unmarked", () => {
    expect(splitSurroundingWhitespace("\nSmluvený rozvod manželství")).toEqual({
      leading: "\n",
      core: "Smluvený rozvod manželství",
      trailing: "",
    });
  });

  test("rebuilds the run exactly for any mix of whitespace and text", () => {
    fc.assert(
      fc.property(segmentText, (text) => {
        const { core, leading, trailing } = splitSurroundingWhitespace(text);
        expect(leading + core + trailing).toBe(text);
        expect(core.trim()).toBe(core);
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  });
});

describe("diffMarkRanges", () => {
  test("marks exactly the visible text of every changed run", () => {
    fc.assert(
      fc.property(fc.array(segmentArbitrary, { maxLength: 12 }), (segments) => {
        const text = segments.map((segment) => segment.text).join("");
        const ranges = diffMarkRanges(segments);
        const marked = covered(ranges);

        for (const [index, range] of ranges.entries()) {
          // Inside the text, non-empty, in order and apart.
          expect(range.start).toBeGreaterThanOrEqual(0);
          expect(range.end).toBeLessThanOrEqual(text.length);
          expect(range.start).toBeLessThan(range.end);
          expect(range.start).toBeGreaterThanOrEqual(
            ranges.slice(0, index).at(-1)?.end ?? 0,
          );
          // Never opens or closes on whitespace.
          expect(WHITESPACE.test(text.at(range.start) ?? "")).toBe(false);
          expect(WHITESPACE.test(text.at(range.end - 1) ?? "")).toBe(false);
        }

        for (const { segment, start } of positioned(segments)) {
          for (let offset = 0; offset < segment.text.length; offset += 1) {
            const character = segment.text.charAt(offset);
            const position = start + offset;
            if (segment.type === "equal") {
              expect(marked.has(position)).toBe(false);
            } else if (!WHITESPACE.test(character)) {
              expect(marked.has(position)).toBe(true);
            }
          }
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  });

  test("marks a deletion deleted and an insertion inserted", () => {
    expect(
      diffMarkRanges([
        { type: "equal", text: "within " },
        { type: "del", text: "ten " },
        { type: "ins", text: " working " },
        { type: "equal", text: "days" },
      ]),
    ).toEqual([
      { type: "deleted", start: 7, end: 10 },
      { type: "inserted", start: 12, end: 19 },
    ]);
  });

  test("a whitespace-only change marks nothing", () => {
    expect(
      diffMarkRanges([
        { type: "equal", text: "a" },
        { type: "ins", text: " \n " },
        { type: "equal", text: "b" },
      ]),
    ).toEqual([]);
  });
});

const text = (value: string): Inline => ({ type: "text", text: value });

const inlineArbitrary: fc.Arbitrary<Inline[]> = fc.array(
  fc.oneof(
    segmentText.map(text),
    fc.constant<Inline>({ type: "line-break" }),
    segmentText.map((value): Inline => ({
      type: "bold",
      children: [text(value)],
    })),
  ),
  { maxLength: 5 },
);

/** Every block kind the reader renders, with the shapes that carry pieces. */
const blockArbitrary = (id: string): fc.Arbitrary<Block> =>
  fc.oneof(
    inlineArbitrary.map((inlines): Block => ({
      type: "heading",
      id,
      anchorId: id,
      level: 6,
      inlines,
      plainText: inlinesToPlainText(inlines),
    })),
    fc
      .tuple(inlineArbitrary, fc.option(fc.integer({ min: 1, max: 999 })))
      .map(([inlines, number]): Block => ({
        type: "paragraph",
        id,
        anchorId: id,
        inlines,
        plainText: inlinesToPlainText(inlines),
        number: number ?? undefined,
      })),
    fc
      .array(fc.array(inlineArbitrary, { minLength: 1, maxLength: 3 }), {
        maxLength: 3,
      })
      .map((rows): Block => ({
        type: "table",
        id,
        anchorId: id,
        rows: rows.map((row) =>
          row.map((inlines) => ({
            inlines,
            plainText: inlinesToPlainText(inlines),
          })),
        ),
        plainText: "",
      })),
    fc.constant<Block>({
      type: "image",
      id,
      anchorId: id,
      src: "asset://seal",
      plainText: "",
    }),
  );

const blocksArbitrary = fc
  .integer({ min: 1, max: 4 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) =>
        blockArbitrary(`b${index}`),
      ),
    ),
  );

/** A diff of a side's text: the text cut into runs of random kinds. */
const sideDiff = (value: string): fc.Arbitrary<WordDiffSegment[]> =>
  fc
    .array(
      fc.record({
        cut: fc.integer({ min: 0, max: value.length }),
        type: fc.constantFrom<"equal" | "del">("equal", "del"),
      }),
      { maxLength: 6 },
    )
    .map((cuts) => {
      const ordered = cuts.toSorted((left, right) => left.cut - right.cut);
      const segments: WordDiffSegment[] = [];
      let start = 0;
      for (const { cut, type } of [
        ...ordered,
        { cut: value.length, type: "del" as const },
      ]) {
        segments.push({ type, text: value.slice(start, cut) });
        start = cut;
      }
      return segments.filter((segment) => segment.text !== "");
    });

describe("compareText", () => {
  test("is the reader's plain text for every block kind, piece by piece", () => {
    fc.assert(
      fc.property(blockArbitrary("b"), (block) => {
        const expected =
          block.type === "image"
            ? [block.src]
            : buildDocumentAstSearchPieces([block]).map((piece) => piece.text);

        expect(compareText([block])).toBe(expected.join("\n"));
        if (block.type === "heading") {
          expect(compareText([block])).toBe(inlinesToPlainText(block.inlines));
        }
        if (block.type === "paragraph" && block.number === undefined) {
          expect(compareText([block])).toBe(inlinesToPlainText(block.inlines));
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  });
});

describe("markSide", () => {
  test("puts every mark on the characters the side's diff marks", () => {
    fc.assert(
      fc.property(
        blocksArbitrary.chain((blocks) =>
          sideDiff(compareText(blocks)).map(
            (segments) => [blocks, segments] as const,
          ),
        ),
        ([blocks, segments]) => {
          const side = compareText(blocks);
          const expected = covered(diffMarkRanges(segments));
          const actual = new Set<number>();
          // Positions inside a piece the reader shows: not the line breaks
          // that join pieces, not an image's address.
          const shown = new Set<number>();
          let pieceStart = 0;

          const marked = markSide({ blocks, segments });
          expect(marked.map(({ block }) => block)).toEqual(blocks);

          for (const { block, rangesByPieceId } of marked) {
            const pieces =
              block.type === "image"
                ? [{ id: null, text: block.src }]
                : buildDocumentAstSearchPieces([block]);
            for (const piece of pieces) {
              const ranges =
                piece.id === null ? [] : (rangesByPieceId[piece.id] ?? []);
              for (const range of ranges) {
                expect(range.start).toBeGreaterThanOrEqual(0);
                expect(range.end).toBeLessThanOrEqual(piece.text.length);
                // The mark sits on the same characters in the piece as in
                // the side's text.
                expect(piece.text.slice(range.start, range.end)).toBe(
                  side.slice(pieceStart + range.start, pieceStart + range.end),
                );
              }
              for (const position of covered(ranges)) {
                actual.add(pieceStart + position);
              }
              if (piece.id !== null) {
                for (let index = 0; index < piece.text.length; index += 1) {
                  shown.add(pieceStart + index);
                }
              }
              pieceStart += piece.text.length + 1;
            }
          }

          const expectedShown = [...expected].filter((position) =>
            shown.has(position),
          );
          expect([...actual].toSorted((a, b) => a - b)).toEqual(
            expectedShown.toSorted((a, b) => a - b),
          );
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  });

  test("refuses a diff that does not spell the side's text", () => {
    expect(() =>
      markSide({
        blocks: [
          {
            type: "paragraph",
            id: "p",
            anchorId: "p",
            inlines: [text("(1) Wording.")],
            plainText: "(1) Wording.",
          },
        ],
        segments: [{ type: "equal", text: "(1) Wording" }],
      }),
    ).toThrow("does not spell");
  });
});
