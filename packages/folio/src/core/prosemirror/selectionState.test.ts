import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "./schema";
import { extractSelectionState } from "./selectionState";

const bold = schema.marks["bold"]!;

function paragraphWithBoldRun() {
  // Text node layout: "before " (plain) + "Parent" (bold) + " after" (plain).
  // Cursor positions (1-indexed inside paragraph):
  //   1               start of "before "
  //   8               just after "before " — same-paragraph boundary entering bold
  //   14              end of "Parent"
  //   20              end of " after"
  return schema.node("doc", null, [
    schema.node("paragraph", null, [
      schema.text("before "),
      schema.text("Parent", [bold.create()]),
      schema.text(" after"),
    ]),
  ]);
}

function stateAt(from: number, to: number): EditorState {
  const doc = paragraphWithBoldRun();
  return EditorState.create({ doc }).apply(
    EditorState.create({ doc }).tr.setSelection(
      TextSelection.create(doc, from, to),
    ),
  );
}

describe("extractSelectionState — bold detection", () => {
  test("reports bold for a selection that starts at a same-paragraph non-bold→bold boundary", () => {
    // Selection: from boundary (8) to 2 chars into "Parent" (10).
    // $from.marks() is left-biased and would return the prior text node's
    // marks (non-bold), making the toolbar misreport bold as inactive even
    // though the selected content is entirely bold. The range walk fixes it.
    const state = stateAt(8, 10);
    const result = extractSelectionState(state);

    expect(result?.textFormatting.bold).toBe(true);
  });

  test("reports bold for a selection fully inside a bold run", () => {
    const state = stateAt(9, 13);
    const result = extractSelectionState(state);

    expect(result?.textFormatting.bold).toBe(true);
  });

  test("reports bold for a mixed selection that crosses bold and non-bold text", () => {
    // Spans the boundary on both sides: "before " (plain) + "Parent" (bold).
    // Match toggleMark semantics — bold present anywhere in the range counts.
    const state = stateAt(3, 12);
    const result = extractSelectionState(state);

    expect(result?.textFormatting.bold).toBe(true);
  });

  test("reports bold=false for a selection entirely inside non-bold text", () => {
    const state = stateAt(2, 6);
    const result = extractSelectionState(state);

    expect(result?.textFormatting.bold).toBeUndefined();
  });

  test("empty cursor at a non-bold→bold boundary keeps left-biased semantics", () => {
    // Empty selection uses storedMarks || $from.marks(); preserves the
    // existing typing-into-cursor behavior.
    const state = stateAt(8, 8);
    const result = extractSelectionState(state);

    expect(result?.textFormatting.bold).toBeUndefined();
  });
});
