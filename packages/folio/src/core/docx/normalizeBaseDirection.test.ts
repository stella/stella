/**
 * Model-level base-direction normalization (the save fallback used when the
 * editor view was never instantiated, so the PM-layer detector never ran).
 * Mirrors the editor contract: fill `bidi` only for undecided RTL-led
 * paragraphs; never override an explicit decision or flag LTR content.
 */

import { describe, expect, test } from "bun:test";

import type { Document, Paragraph } from "../types/document";
import { normalizeBaseDirection } from "./normalizeBaseDirection";

const para = (text: string, bidi?: boolean): Paragraph => ({
  type: "paragraph",
  ...(bidi === undefined ? {} : { formatting: { bidi } }),
  content: [{ type: "run", content: [{ type: "text", text }] }],
});

const docOf = (...paragraphs: Paragraph[]): Document => ({
  package: { document: { content: paragraphs } },
});

const bidiOf = (doc: Document, index: number): boolean | undefined => {
  const block = doc.package.document.content.at(index);
  if (block?.type !== "paragraph") {
    throw new Error("expected a paragraph");
  }
  return block.formatting?.bidi;
};

describe("normalizeBaseDirection", () => {
  test("sets bidi=true on an undecided Arabic-led paragraph", () => {
    expect(bidiOf(normalizeBaseDirection(docOf(para("هذا عقد"))), 0)).toBe(
      true,
    );
  });

  test("leaves a Latin-led paragraph undecided", () => {
    expect(
      bidiOf(normalizeBaseDirection(docOf(para("Agreement"))), 0),
    ).toBeUndefined();
  });

  test("does not override an explicit LTR (false)", () => {
    expect(bidiOf(normalizeBaseDirection(docOf(para("عربي", false))), 0)).toBe(
      false,
    );
  });

  test("leaves an explicit RTL (true) untouched", () => {
    expect(bidiOf(normalizeBaseDirection(docOf(para("عربي", true))), 0)).toBe(
      true,
    );
  });

  test("detects RTL inside hyperlinked runs", () => {
    const doc = docOf({
      type: "paragraph",
      content: [
        {
          type: "hyperlink",
          href: "https://example.test",
          children: [
            { type: "run", content: [{ type: "text", text: "عربي" }] },
          ],
        },
      ],
    });
    expect(bidiOf(normalizeBaseDirection(doc), 0)).toBe(true);
  });

  test("normalizes paragraphs nested in table cells", () => {
    const doc: Document = {
      package: {
        document: {
          content: [
            {
              type: "table",
              rows: [
                {
                  type: "tableRow",
                  cells: [{ type: "tableCell", content: [para("نص عربي")] }],
                },
              ],
            },
          ],
        },
      },
    };
    const out = normalizeBaseDirection(doc);
    const table = out.package.document.content.at(0);
    if (table?.type !== "table") {
      throw new Error("expected a table");
    }
    const cell = table.rows[0]?.cells[0];
    const cellPara = cell?.content.at(0);
    if (cellPara?.type !== "paragraph") {
      throw new Error("expected a paragraph in the cell");
    }
    expect(cellPara.formatting?.bidi).toBe(true);
  });

  test("does not mutate the input document", () => {
    const input = docOf(para("هذا عقد"));
    normalizeBaseDirection(input);
    expect(bidiOf(input, 0)).toBeUndefined();
  });
});
