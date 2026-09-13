import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { buildStandaloneAnnotationAnchors } from "@/components/legal-reader/annotations/annotation-anchors";
import type { AnnotationAnchorSource } from "@/components/legal-reader/annotations/annotation-anchors";

/**
 * Both readers lay their marks over the text through this one function, so
 * the invariant is about the mapping, not about either corpus: every mark
 * reaches the block it names, exactly once, at the offsets it was stored
 * with. A mark filed under the wrong block is a highlight drawn over the
 * wrong words, which no rendering test would notice.
 */
const annotationArbitrary = fc.record({
  blockAnchorId: fc.constantFrom("p-1", "p-2", "p-3", "cl_7", "priloha-1"),
  color: fc.constantFrom("yellow", "red", null),
  endOffset: fc.integer({ min: 1, max: 400 }),
  id: fc.uuid(),
  kind: fc.constantFrom("highlight" as const, "comment" as const),
  startOffset: fc.integer({ min: 0, max: 399 }),
  style: fc.constantFrom(
    "highlight" as const,
    "underline" as const,
    "squiggly" as const,
    "strikethrough" as const,
    null,
  ),
});

describe("standalone annotation anchors", () => {
  test("files every mark under its own block at its own offsets", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(annotationArbitrary, {
          maxLength: 12,
          selector: (annotation) => annotation.id,
        }),
        (annotations: AnnotationAnchorSource[]) => {
          const anchorsByPieceId =
            buildStandaloneAnnotationAnchors(annotations);

          const placed = Object.values(anchorsByPieceId).flat();
          expect(placed).toHaveLength(annotations.length);

          for (const annotation of annotations) {
            const anchors = anchorsByPieceId[annotation.blockAnchorId] ?? [];
            const anchor = anchors.find(
              (candidate) => candidate.key === `annotation:${annotation.id}`,
            );
            expect(anchor).toEqual({
              end: annotation.endOffset,
              key: `annotation:${annotation.id}`,
              render: expect.any(Function),
              start: annotation.startOffset,
            });
          }
        },
      ),
      propertyConfig(),
    );
  });
});
