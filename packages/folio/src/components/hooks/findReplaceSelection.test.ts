import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { resolveFindMatchRange } from "./findReplaceSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "(paragraph | table | textBox)+" },
    paragraph: { group: "block", content: "inline*" },
    table: { group: "block", content: "tableRow+" },
    tableRow: { content: "(tableCell | tableHeader)+" },
    tableCell: { content: "(paragraph | table)+" },
    tableHeader: { content: "(paragraph | table)+" },
    textBox: { group: "block", content: "(paragraph | table)+" },
    tab: { group: "inline", inline: true },
    hardBreak: { group: "inline", inline: true },
    text: { group: "inline" },
  },
});

describe("Folio find match selection", () => {
  test("maps paragraph-relative find offsets to ProseMirror positions", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Preferred stock")]),
      schema.node("paragraph", null, [schema.text("Common stock")]),
    ]);

    expect(
      resolveFindMatchRange(doc, {
        paragraphIndex: 1,
        contentIndex: 0,
        startOffset: 7,
        endOffset: 12,
        text: "stock",
      }),
    ).toEqual({ from: 25, to: 30 });
  });

  test("skips text box paragraphs to match document search traversal", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Preferred stock")]),
      schema.node("textBox", null, [
        schema.node("paragraph", null, [schema.text("stock in text box")]),
      ]),
      schema.node("paragraph", null, [schema.text("Common stock")]),
    ]);

    expect(
      resolveFindMatchRange(doc, {
        paragraphIndex: 1,
        contentIndex: 0,
        startOffset: 7,
        endOffset: 12,
        text: "stock",
      }),
    ).toEqual({ from: 46, to: 51 });
  });

  test("maps offsets after inline search tokens", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("pre"),
        schema.node("tab"),
        schema.text("stock"),
        schema.node("hardBreak"),
        schema.text("tail"),
      ]),
    ]);

    expect(
      resolveFindMatchRange(doc, {
        paragraphIndex: 0,
        contentIndex: 0,
        startOffset: 4,
        endOffset: 9,
        text: "stock",
      }),
    ).toEqual({ from: 5, to: 10 });
  });
});
