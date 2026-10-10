import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Document, Paragraph } from "@stll/docx-core/model";
import { assertProperty } from "@stll/property-testing";

import { createParagraphFootnoteReader } from "./document-footnotes";

const paragraphOf = (ids: readonly number[]): Paragraph => ({
  type: "paragraph",
  content: [
    {
      type: "run",
      content: ids.map((id) => ({ type: "footnoteRef", id })),
    },
  ],
});

test("note placement follows paragraph reference order, independently of package order", () => {
  assertProperty(
    "document-footnotes-reference-order",
    fc.property(
      fc.array(fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 8 }), {
        maxLength: 8,
      }),
      (references) => {
        const paragraphs = references.map(paragraphOf);
        const document: Document = {
          package: {
            document: { content: paragraphs },
            footnotes: Array.from({ length: 8 }, (_, index) => ({
              type: "footnote",
              id: 8 - index,
              content: [],
            })),
          },
        };
        const notesAfter = createParagraphFootnoteReader(document);
        const seen = new Set<number>();
        for (const [index, paragraph] of paragraphs.entries()) {
          const expected = [];
          for (const id of references[index] ?? []) {
            if (!seen.has(id)) {
              seen.add(id);
              expected.push(id);
            }
          }
          expect(notesAfter(paragraph).map(({ id }) => id)).toEqual(expected);
        }
      },
    ),
    { numRuns: 100 },
  );
});
