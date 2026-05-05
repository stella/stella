import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { resolveFindMatchRange } from "./findReplaceSelection";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
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
});
