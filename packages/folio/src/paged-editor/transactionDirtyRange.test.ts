import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import { schema } from "../core/prosemirror/schema";
import { getTransactionDirtyRange } from "./transactionDirtyRange";

describe("getTransactionDirtyRange", () => {
  test("maps changed ranges from multi-step transactions into final document coordinates", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("abcdefghijklmnopqrstuvwxyz".repeat(6)),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const firstEditPosition = 100;
    const prefixInsertion = "x".repeat(80);
    const transaction = state.tr
      .insertText("A", firstEditPosition)
      .insertText(prefixInsertion, 2);

    const dirtyRange = getTransactionDirtyRange(transaction);

    expect(dirtyRange).toEqual({
      from: 2,
      to: firstEditPosition + prefixInsertion.length + 1,
    });
  });
});
