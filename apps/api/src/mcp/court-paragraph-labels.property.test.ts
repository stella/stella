/**
 * What must hold for any stored decision a read tool serves, however many
 * headings, ruling items and unnumbered blocks stand before and between the
 * court's numbered paragraphs:
 *
 * - A paragraph the court numbered is labelled and linked by that number,
 *   never by its position.
 * - The court labels run in document order, increasing and each once.
 * - A number a paragraph merely prints never repeats a court label.
 * - `numbering` is `court` exactly when some paragraph carries a number.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { decisionParagraphNumbering } from "@stll/legal-ast/court-paragraph-number";
import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { decisionBlockDeepLink } from "@/api/mcp/case-law-decision-link";
import { locateDecisionBlocks } from "@/api/mcp/case-law-decision-outline";
import { decisionParagraphs } from "@/api/mcp/case-law-decision-read";
import { toPlainCorpusText } from "@/api/mcp/tool-utils";

const URL = "https://example.test/decision";

type Draft =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "unnumbered"; readonly text: string }
  | {
      readonly kind: "printed";
      readonly printed: number;
      readonly text: string;
    }
  | { readonly kind: "numbered"; readonly step: number; readonly text: string };

const words = fc
  .array(
    fc.constantFrom(
      "Soud",
      "stěžovatel",
      "kasační stížnost",
      "odst. 2",
      "bod 12",
      "§ 237",
      "zamítl",
      "12. 3. 2020",
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((parts) => parts.join(" "));

const draft: fc.Arbitrary<Draft> = fc.oneof(
  fc.record({ kind: fc.constant("heading" as const), text: words }),
  fc.record({ kind: fc.constant("unnumbered" as const), text: words }),
  fc.record({
    kind: fc.constant("printed" as const),
    printed: fc.integer({ min: 1, max: 60 }),
    text: words,
  }),
  fc.record({
    kind: fc.constant("numbered" as const),
    // The court skips a number now and then; it never counts back.
    step: fc.constantFrom(1, 1, 1, 2),
    text: words,
  }),
);

/** A stored decision: an unnumbered opening, then mixed blocks. */
const decision = fc
  .tuple(
    fc.array(
      fc.constantFrom<Draft>(
        { kind: "heading", text: "ROZSUDEK" },
        { kind: "unnumbered", text: "JMÉNEM REPUBLIKY" },
        { kind: "unnumbered", text: "Nejvyšší správní soud rozhodl takto:" },
        { kind: "heading", text: "Odůvodnění:" },
      ),
      { maxLength: 12 },
    ),
    fc.array(draft, { maxLength: 40 }),
  )
  .map(([opening, body]): Block[] => {
    let next = 0;
    return [...opening, ...body].map((item, index): Block => {
      const id = `b${String(index)}`;
      const base = { id, inlines: [] };
      switch (item.kind) {
        case "heading":
          return {
            ...base,
            anchorId: `h-${String(index)}`,
            type: "heading",
            level: 2,
            plainText: `${item.text} ${String(index)}`,
          };
        case "unnumbered":
          return {
            ...base,
            anchorId: `p-${String(index)}`,
            type: "paragraph",
            plainText: `${item.text} ${String(index)}`,
          };
        case "printed":
          return {
            ...base,
            anchorId: `p-${String(index)}`,
            type: "paragraph",
            plainText: `${String(item.printed)}. ${item.text} ${String(index)}`,
          };
        case "numbered":
          next += item.step;
          return {
            ...base,
            anchorId: `p-${String(index)}`,
            type: "paragraph",
            number: next,
            plainText: `${item.text} ${String(index)}`,
          };
        default:
          item satisfies never;
          throw new Error("unhandled draft");
      }
    });
  });

test("court paragraph labels are the court's numbers, in order and each once, whatever precedes them", () => {
  assertProperty(
    "court paragraph labels are the court's numbers, in order and each once, whatever precedes them",
    fc.property(decision, (blocks) => {
      // An empty decision serves no text at all.
      const text = toPlainCorpusText({ blocks, fulltext: null }) ?? "";
      const located = locateDecisionBlocks(blocks, text);
      const paragraphs = decisionParagraphs({ located, text });
      const stored = blocks.flatMap((block) =>
        block.type === "paragraph" && block.number !== undefined
          ? [block.number]
          : [],
      );

      expect(decisionParagraphNumbering(located)).toBe(
        stored.length > 0 ? "court" : "none",
      );
      const courtLabels: number[] = [];
      for (const paragraph of paragraphs) {
        const link = decisionBlockDeepLink({ url: URL, ...paragraph }).url;
        if (paragraph.number === undefined) {
          expect(link?.includes("#par=")).not.toBe(true);
          continue;
        }
        expect(paragraph.label).toBe(String(paragraph.number));
        expect(link).toBe(`${URL}#par=${String(paragraph.number)}`);
        courtLabels.push(paragraph.number);
      }
      // Every stored number is served, in document order.
      expect(courtLabels).toEqual(stored);
      expect(
        courtLabels.every(
          (label, index) =>
            index === 0 || label > (courtLabels[index - 1] ?? 0),
        ),
      ).toBe(true);
      const printedLabels = paragraphs.flatMap(({ label, number }) =>
        number === undefined && label !== null ? [Number(label)] : [],
      );
      expect(
        printedLabels.filter((label) => courtLabels.includes(label)),
      ).toEqual([]);
    }),
  );
});
