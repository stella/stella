/**
 * What must hold for any decision, numbered or not.
 *
 * - Faithful: a numbered paragraph's text is the printed text with only the
 *   marker removed, and the marker states exactly the stored number.
 * - Structure-preserving: the same blocks, ids and anchors, in order.
 * - Idempotent: a second pass changes nothing — a re-parse or a replay of a
 *   numbered decision cannot number its nested lists.
 * - Sound: stored numbers come from markers alone, and a rejected or
 *   unnumbered outcome leaves the blocks exactly as they were.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { extractCourtParagraphNumbers } from "@/api/handlers/case-law/ingestion/parsers/court-paragraph-numbers";

const MARKERS = {
  bracket: (number: number) => `[${String(number)}] `,
  dot: (number: number) => `${String(number)}.\t`,
  paren: (number: number) => `${String(number)}) `,
} as const;

const words = fc
  .array(
    fc.constantFrom(
      "Soud",
      "žalobce",
      "dovolání",
      "odst. 2",
      "bod 12",
      "§ 237",
      "zamítl",
      "12. 3. 2020",
      "(viz [3])",
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(" "));

type Draft = {
  readonly role: ParagraphBlock["role"];
  readonly marker: keyof typeof MARKERS | null;
  readonly number: number;
  readonly text: string;
};

const draft: fc.Arbitrary<Draft> = fc.record({
  role: fc.constantFrom(undefined, undefined, "holding", "dissent", "closing"),
  marker: fc.constantFrom(null, "bracket", "dot", "dot", "paren"),
  number: fc.integer({ min: 1, max: 40 }),
  text: words,
});

/** Decisions that mostly count up, with lists, skips and stray markers. */
const decision = fc
  .tuple(fc.array(draft, { maxLength: 40 }), fc.boolean())
  .map(([drafts, counting]): Block[] => {
    let next = 1;
    return drafts.map((item, index) => {
      const number = counting && item.marker !== null ? next++ : item.number;
      const plainText =
        item.marker === null
          ? item.text
          : `${MARKERS[item.marker](number)}${item.text}`;
      return {
        id: `b${String(index)}`,
        anchorId: `p-${String(index)}`,
        type: "paragraph",
        role: item.role,
        inlines: [{ type: "text", text: plainText }],
        plainText,
      };
    });
  });

const MARKER_PREFIX = /^(?:\[(\d+)\][ \t]*|(\d+)\.[ \t]+|(\d+)\)[ \t]+)/u;

test("court paragraph numbers are faithful, structure-preserving and idempotent", () => {
  assertProperty(
    "court paragraph numbers are faithful, structure-preserving and idempotent",
    fc.property(decision, (blocks) => {
      const numbering = extractCourtParagraphNumbers(blocks);

      expect(
        numbering.blocks.map(({ id, anchorId, type }) => [id, anchorId, type]),
      ).toEqual(blocks.map(({ id, anchorId, type }) => [id, anchorId, type]));
      if (numbering.type !== "numbered") {
        expect(numbering.blocks).toEqual(blocks);
      }
      for (const [index, after] of numbering.blocks.entries()) {
        const before = blocks[index];
        if (after.type !== "paragraph" || before?.type !== "paragraph") {
          continue;
        }
        if (after.number === undefined) {
          expect(after).toEqual(before);
          continue;
        }
        const marker = MARKER_PREFIX.exec(before.plainText);
        expect(marker).not.toBeNull();
        const stated = Number(marker?.[1] ?? marker?.[2] ?? marker?.[3]);
        expect(after.number).toBe(stated);
        expect(after.plainText).toBe(
          before.plainText.slice(marker?.[0].length ?? 0).trim(),
        );
        expect(before.role === "holding" || before.role === "closing").toBe(
          false,
        );
      }

      expect(extractCourtParagraphNumbers(numbering.blocks).blocks).toEqual(
        numbering.blocks,
      );
    }),
  );
});
