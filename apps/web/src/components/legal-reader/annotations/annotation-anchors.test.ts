import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  annotationSegments,
  buildAnnotationAnchors,
} from "@/components/legal-reader/annotations/annotation-anchors";
import type { AnnotationAnchorSource } from "@/components/legal-reader/annotations/annotation-anchors";

/**
 * Both readers lay their marks over the text through this one module, so the
 * invariants are about the mapping, not about either corpus: every mark
 * reaches the piece it names, and the runs it is drawn in tile the text
 * without gaps or repeats. A mark filed under the wrong piece is a highlight
 * drawn over the wrong words, and two marks over the same words print those
 * words twice — neither of which a rendering test would notice.
 */
const annotationArbitrary = fc.record({
  blockAnchorId: fc.constantFrom("p-1", "p-2", "p-3", "cl_7", "priloha-1"),
  color: fc.constantFrom("yellow", "red", null),
  endOffset: fc.integer({ min: 1, max: 40 }),
  id: fc.uuid(),
  kind: fc.constantFrom("highlight" as const, "comment" as const),
  startOffset: fc.integer({ min: 0, max: 39 }),
  style: fc.constantFrom(
    "highlight" as const,
    "underline" as const,
    "squiggly" as const,
    "strikethrough" as const,
    null,
  ),
});

const marksArbitrary = fc.uniqueArray(annotationArbitrary, {
  maxLength: 8,
  selector: (annotation) => annotation.id,
});

describe("annotation anchors", () => {
  test("files every anchor under the piece its own mark names", () => {
    fc.assert(
      fc.property(marksArbitrary, (annotations: AnnotationAnchorSource[]) => {
        const pieceOf = new Map(
          annotations.map((annotation) => [
            annotation.id,
            annotation.blockAnchorId,
          ]),
        );
        const anchorsByPieceId = buildAnnotationAnchors(annotations);

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
      startOffset: 0,
      style: "highlight",
    } as const satisfies AnnotationAnchorSource;

    expect(annotationSegments([alone])).toEqual([
      { annotation: alone, end: 9, start: 0 },
    ]);
  });

  test("a mark in a table cell is drawn in the cell, not on the table", () => {
    const inCell = {
      blockAnchorId: "table:b-3:0:1",
      color: "yellow",
      endOffset: 4,
      id: "019b0121-9dd7-7000-8000-0000000000c1",
      kind: "highlight",
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
});
