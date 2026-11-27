import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Document, Paragraph } from "@stll/docx-core/model";
import { assertProperty } from "@stll/property-testing";

import {
  createParagraphFootnoteReader,
  createParagraphLineReader,
} from "./document-footnotes";

const paragraphOf = (ids: readonly number[]): Paragraph => ({
  type: "paragraph",
  content: [
    {
      type: "run",
      content: ids.map((id) => ({ type: "footnoteRef", id })),
    },
  ],
});

test("a document without a footnote part still emits its body paragraph", () => {
  const paragraph = paragraphOf([]);
  const readLines = createParagraphLineReader(
    { package: { document: { content: [paragraph] } } },
    (value) => value,
  );
  expect(readLines(paragraph)).toEqual([{ kind: "body", value: paragraph }]);
});

test("note placement follows paragraph reference order, independently of package order", () => {
  assertProperty(
    "note placement follows paragraph reference order, independently of package order",
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

test("shared paragraph lines preserve body and nested note membership", () => {
  const anchor = paragraphOf([1]);
  const note = paragraphOf([2]);
  const nested = paragraphOf([]);
  const document: Document = {
    package: {
      document: { content: [anchor] },
      footnotes: [
        { type: "footnote", id: 1, content: [note] },
        { type: "footnote", id: 2, content: [nested] },
      ],
    },
  };
  const readLines = createParagraphLineReader(
    document,
    (paragraph) => paragraph,
  );
  expect(readLines(anchor)).toEqual([
    { kind: "body", value: anchor },
    { kind: "note", note: { value: note, label: "1", noteId: "fn-1" } },
    { kind: "note", note: { value: nested, label: "2", noteId: "fn-2" } },
  ]);
});
