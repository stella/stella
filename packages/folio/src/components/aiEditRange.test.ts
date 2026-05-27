import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import { createFolioAIEditSnapshot } from "../core/ai-edits/snapshot";
import { clampRangeToDocSize, resolveFolioAIBlockRange } from "./aiEditRange";

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

const makeDoc = (blocks: { paraId: string | null; text: string }[]) =>
  schema.node(
    "doc",
    null,
    blocks.map((block) =>
      schema.node("paragraph", { paraId: block.paraId }, [
        schema.text(block.text),
      ]),
    ),
  );

describe("clampRangeToDocSize", () => {
  test("passes a range untouched when both endpoints sit inside the doc", () => {
    expect(clampRangeToDocSize(100, { from: 12, to: 34 })).toEqual({
      from: 12,
      to: 34,
    });
  });

  test("clamps `to` when it points one past the doc end", () => {
    expect(clampRangeToDocSize(100, { from: 50, to: 101 })).toEqual({
      from: 50,
      to: 100,
    });
  });

  test("clamps both endpoints when both exceed the doc", () => {
    expect(clampRangeToDocSize(50, { from: 80, to: 120 })).toEqual({
      from: 50,
      to: 50,
    });
  });

  test("clamps a negative `from` up to zero", () => {
    expect(clampRangeToDocSize(100, { from: -5, to: 20 })).toEqual({
      from: 0,
      to: 20,
    });
  });

  test("preserves a cursor range (from === to)", () => {
    expect(clampRangeToDocSize(100, { from: 42, to: 42 })).toEqual({
      from: 42,
      to: 42,
    });
  });

  test("yields a doc-end cursor when both endpoints are well past the end", () => {
    // `TextSelection.between` falls back to a cursor selection when both
    // endpoints collapse — that is the intended behavior for stale ids.
    expect(clampRangeToDocSize(20, { from: 1000, to: 1500 })).toEqual({
      from: 20,
      to: 20,
    });
  });
});

describe("resolveFolioAIBlockRange", () => {
  test("resolves paraId block ids against the live document before snapshot positions", () => {
    const snapshot = createFolioAIEditSnapshot(
      makeDoc([
        { paraId: "11111111", text: "Before" },
        { paraId: "AAAA0001", text: "Target" },
      ]),
    );
    const liveDoc = makeDoc([
      { paraId: "22222222", text: "Inserted" },
      { paraId: "11111111", text: "Before" },
      { paraId: "AAAA0001", text: "Target" },
    ]);

    const range = resolveFolioAIBlockRange({
      blockId: "AAAA0001",
      doc: liveDoc,
      snapshot,
    });

    if (range === null) {
      throw new Error("Expected paraId-backed block to resolve");
    }
    expect(liveDoc.resolve(range.from + 1).parent.textContent).toBe("Target");
  });

  test("keeps seq fallback block ids anchored to the snapshot", () => {
    const snapshot = createFolioAIEditSnapshot(
      makeDoc([
        { paraId: null, text: "Before" },
        { paraId: null, text: "Target" },
      ]),
    );
    const liveDoc = makeDoc([
      { paraId: null, text: "Inserted" },
      { paraId: null, text: "Before" },
      { paraId: null, text: "Target" },
    ]);

    const range = resolveFolioAIBlockRange({
      blockId: "seq-0002",
      doc: liveDoc,
      snapshot,
    });

    if (range === null) {
      throw new Error("Expected seq-backed block to resolve");
    }
    expect(liveDoc.resolve(range.from + 1).parent.textContent).toBe("Inserted");
  });
});
