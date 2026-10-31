import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "@stll/api-contract/legal-reader-annotations";
import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  annotationSegments,
  annotationTextAnchors,
  buildAnnotationAnchors,
} from "./annotation-anchors";
import type { AnnotationAnchorSource } from "./annotation-anchors";

/** Every piece's text in these properties: long enough for any mark. */
const PIECE_TEXT = Array.from(
  { length: READER_ANNOTATION_QUOTE_MAX_LENGTH },
  (_unused, index) => String.fromCodePoint(0x61 + (index % 26)),
).join("");

const ANCHOR_IDS = ["p-1", "p-2", "p-3", "cl_7", "priloha-1"] as const;

/** One paragraph per anchor, rendered under the anchor as its own id. */
const PIECE_BLOCKS: Block[] = ANCHOR_IDS.map((anchorId) => ({
  anchorId,
  id: anchorId,
  inlines: [{ text: PIECE_TEXT, type: "text" }],
  plainText: PIECE_TEXT,
  type: "paragraph",
}));

/**
 * Both readers lay their marks over the text through this one module, so the
 * invariants are about the mapping, not about either corpus: every mark
 * reaches the piece it names, and the runs it is drawn in tile the text
 * without gaps or repeats. A mark filed under the wrong piece is a highlight
 * drawn over the wrong words, and two marks over the same words print those
 * words twice — neither of which a rendering test would notice.
 */
const annotationArbitrary = fc
  .record({
    blockAnchorId: fc.constantFrom(...ANCHOR_IDS),
    color: fc.constantFrom("yellow", "red", null),
    endOffset: fc.integer({ min: 1, max: READER_ANNOTATION_QUOTE_MAX_LENGTH }),
    id: fc.uuid(),
    kind: fc.constantFrom("highlight" as const, "comment" as const),
    startOffset: fc.integer({
      min: 0,
      max: READER_ANNOTATION_QUOTE_MAX_LENGTH - 1,
    }),
    style: fc.constantFrom(
      "highlight" as const,
      "underline" as const,
      "squiggly" as const,
      "strikethrough" as const,
      null,
    ),
  })
  .map((annotation) => ({
    ...annotation,
    quote: PIECE_TEXT.slice(annotation.startOffset, annotation.endOffset),
  }));

const marksArbitrary = fc.uniqueArray(annotationArbitrary, {
  selector: (annotation) => annotation.id,
});

const answerMarksArbitrary = marksArbitrary.chain((annotations) =>
  fc
    .array(fc.boolean(), {
      minLength: annotations.length,
      maxLength: annotations.length,
    })
    .map((answers) =>
      annotations.map((annotation, index) => ({
        ...annotation,
        activationLabel: answers.at(index)
          ? `Open answer ${annotation.id}`
          : undefined,
      })),
    ),
);

describe("annotation anchors", () => {
  test("overlapping answers retain every activation and the original annotation winner without repeating text", () => {
    assertProperty(
      "overlapping answers retain every activation and the original annotation winner without repeating text",
      fc.property(answerMarksArbitrary, (annotations) => {
        const segments = annotationSegments(annotations);
        const normalSegments = annotationSegments(
          annotations.filter(
            (annotation) => annotation.activationLabel === undefined,
          ),
        );
        for (let offset = 0; offset < 40; offset += 1) {
          const covering = annotations.filter(
            (annotation) =>
              annotation.startOffset <= offset && annotation.endOffset > offset,
          );
          const runs = segments.filter(
            (segment) => segment.start <= offset && segment.end > offset,
          );
          expect(runs.length).toBe(covering.length === 0 ? 0 : 1);
          const run = runs.at(0);
          if (run === undefined) {
            continue;
          }
          const expectedNormal = normalSegments.find(
            (segment) => segment.start <= offset && segment.end > offset,
          );
          if (expectedNormal !== undefined) {
            expect(run.annotation).toBe(expectedNormal.annotation);
          }
          const activations = [run.annotation, ...run.overlays]
            .filter((annotation) => annotation.activationLabel !== undefined)
            .map((annotation) => annotation.id)
            .toSorted();
          expect(activations).toEqual(
            covering
              .filter((annotation) => annotation.activationLabel !== undefined)
              .map((annotation) => annotation.id)
              .toSorted(),
          );
        }
      }),
    );
  });

  test("files every anchor under the piece its own mark names", () => {
    fc.assert(
      fc.property(marksArbitrary, (annotations: AnnotationAnchorSource[]) => {
        const pieceOf = new Map(
          annotations.map((annotation) => [
            annotation.id,
            annotation.blockAnchorId,
          ]),
        );
        const anchorsByPieceId = buildAnnotationAnchors(
          annotations,
          PIECE_BLOCKS,
        );

        for (const [pieceId, anchors] of Object.entries(anchorsByPieceId)) {
          for (const anchor of anchors) {
            // `annotation:<id>:<start>`; the id is a UUID, so it holds no colon.
            const id = anchor.key.split(":").at(1);
            expect(pieceOf.get(id ?? "")).toBe(pieceId);
          }
        }

        // A mark is only ever absent because another mark draws every run it
        // covers, which the coverage property below proves loses no text.
        const drawn = new Set(
          Object.values(anchorsByPieceId)
            .flat()
            .map((anchor) => anchor.key.split(":").at(1)),
        );
        for (const id of drawn) {
          expect(pieceOf.has(id ?? "")).toBe(true);
        }
      }),
      propertyConfig(),
    );
  });

  test("draws every marked character exactly once", () => {
    fc.assert(
      fc.property(marksArbitrary, (annotations: AnnotationAnchorSource[]) => {
        const marked = annotations.filter(
          (annotation) => annotation.endOffset > annotation.startOffset,
        );
        const segments = annotationSegments(marked);

        // The runs are ordered, disjoint, and inside the marks that made them.
        let cursor = -1;
        for (const segment of segments) {
          expect(segment.start).toBeGreaterThanOrEqual(cursor);
          expect(segment.end).toBeGreaterThan(segment.start);
          expect(segment.annotation.startOffset).toBeLessThanOrEqual(
            segment.start,
          );
          expect(segment.annotation.endOffset).toBeGreaterThanOrEqual(
            segment.end,
          );
          cursor = segment.end;
        }

        // Every character any mark covers is drawn, and drawn once. The
        // renderer walks the anchors with one cursor, so this set equality is
        // what makes the text on screen the text the document holds.
        const covered = new Set<number>();
        for (const annotation of marked) {
          for (
            let offset = annotation.startOffset;
            offset < annotation.endOffset;
            offset += 1
          ) {
            covered.add(offset);
          }
        }
        const drawn: number[] = [];
        for (const segment of segments) {
          for (let offset = segment.start; offset < segment.end; offset += 1) {
            drawn.push(offset);
          }
        }
        expect(drawn).toEqual([...covered].toSorted((a, b) => a - b));
        expect(new Set(drawn).size).toBe(drawn.length);
      }),
      propertyConfig(),
    );
  });

  test("a mark inside another is the one those words carry", () => {
    const outer = {
      blockAnchorId: "p-1",
      color: "yellow",
      endOffset: 20,
      id: "019b0121-9dd7-7000-8000-0000000000a1",
      kind: "highlight",
      quote: "x".repeat(20),
      startOffset: 0,
      style: "highlight",
    } as const satisfies AnnotationAnchorSource;
    const inner = {
      ...outer,
      color: "red",
      endOffset: 12,
      id: "019b0121-9dd7-7000-8000-0000000000a2",
      startOffset: 8,
    } as const satisfies AnnotationAnchorSource;

    expect(
      annotationSegments([outer, inner]).map((segment) => ({
        end: segment.end,
        id: segment.annotation.id,
        start: segment.start,
      })),
    ).toEqual([
      { end: 8, id: outer.id, start: 0 },
      { end: 12, id: inner.id, start: 8 },
      { end: 20, id: outer.id, start: 12 },
    ]);
  });

  test("a mark nothing overlaps stays one run", () => {
    const alone = {
      blockAnchorId: "p-1",
      color: "yellow",
      endOffset: 9,
      id: "019b0121-9dd7-7000-8000-0000000000b1",
      kind: "highlight",
      quote: "x".repeat(9),
      startOffset: 0,
      style: "highlight",
    } as const satisfies AnnotationAnchorSource;

    expect(annotationSegments([alone])).toEqual([
      { annotation: alone, overlays: [], end: 9, start: 0 },
    ]);
  });

  test("a mark in a table cell is drawn in the cell, not on the table", () => {
    const inCell = {
      blockAnchorId: "table:b-3:0:1",
      color: "yellow",
      endOffset: 4,
      id: "019b0121-9dd7-7000-8000-0000000000c1",
      kind: "highlight",
      quote: "21 %",
      startOffset: 0,
      style: "highlight",
    } as const satisfies AnnotationAnchorSource;
    const blocks = [
      {
        anchorId: "priloha-1",
        id: "b-3",
        plainText: "Rate 21 %",
        rows: [
          [
            {
              inlines: [{ text: "Rate", type: "text" as const }],
              plainText: "Rate",
            },
            {
              inlines: [{ text: "21 %", type: "text" as const }],
              plainText: "21 %",
            },
          ],
        ],
        type: "table" as const,
      },
    ];

    // The cell's piece id is already a piece id, so it passes through the
    // block translation untouched and never lands on the table's own id.
    expect(Object.keys(buildAnnotationAnchors([inCell], blocks))).toEqual([
      "table:b-3:0:1",
    ]);
  });

  test("never draws a mark whose words are not at its offsets", () => {
    assertProperty(
      "never draws a mark whose words are not at its offsets",
      fc.property(
        marksArbitrary,
        fc.string({ minLength: 1, maxLength: 8 }),
        (annotations: AnnotationAnchorSource[], replacement) => {
          // The same marks over a text whose words changed under them, as a
          // re-parse leaves a stored position: only a mark whose quote is
          // still there may be drawn.
          const text = `${replacement}${PIECE_TEXT}`.slice(
            0,
            PIECE_TEXT.length,
          );
          const drawn = new Set(
            annotationTextAnchors(annotations, text).map(
              (anchor) => anchor.key.split(":").at(1) ?? "",
            ),
          );
          for (const annotation of annotations) {
            if (!drawn.has(annotation.id)) {
              continue;
            }
            expect(
              text
                .slice(annotation.startOffset, annotation.endOffset)
                .replaceAll(/\s/gu, ""),
            ).toBe(annotation.quote.replaceAll(/\s/gu, ""));
          }
        },
      ),
    );
  });
});
