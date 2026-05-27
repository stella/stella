import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import {
  findParagraphByParaId,
  findStartPosForParaId,
} from "./findParagraphByParaId";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { paraId: { default: null } },
    },
    text: { group: "inline" },
  },
});

const doc = schema.node("doc", null, [
  schema.node("paragraph", { paraId: "A1111111" }, [schema.text("first")]),
  schema.node("paragraph", { paraId: "B2222222" }, [schema.text("second")]),
  schema.node("paragraph", { paraId: null }, [schema.text("no id")]),
]);

describe("findParagraphByParaId / findStartPosForParaId", () => {
  test("finds the matching paragraph and returns its range + node", () => {
    const hit = findParagraphByParaId(doc, "B2222222");
    expect(hit).not.toBeNull();
    expect(hit?.node.textContent).toBe("second");
    // `from` is immediately before the textblock; text lives at from+1
    expect(doc.resolve(hit!.from + 1).parent.textContent).toBe("second");
  });

  test("returns null when no paragraph carries the given paraId", () => {
    expect(findParagraphByParaId(doc, "ZZZZZZZZ")).toBeNull();
    expect(findStartPosForParaId(doc, "ZZZZZZZZ")).toBeNull();
  });

  test("returns null for empty / whitespace-only paraId without walking the doc", () => {
    expect(findParagraphByParaId(doc, "")).toBeNull();
    expect(findParagraphByParaId(doc, "   ")).toBeNull();
    expect(findStartPosForParaId(doc, "")).toBeNull();
  });

  test("findStartPosForParaId returns the same position as findParagraphByParaId.from", () => {
    const hit = findParagraphByParaId(doc, "A1111111");
    expect(findStartPosForParaId(doc, "A1111111")).toBe(hit?.from ?? null);
  });
});
