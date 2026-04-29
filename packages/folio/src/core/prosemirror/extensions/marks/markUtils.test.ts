import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "../../schema";
import { setMark } from "./markUtils";

describe("mark commands", () => {
  test("preserve stored marks when setting formatting in an empty paragraph", () => {
    const fontSize = schema.marks.fontSize;
    if (!fontSize) {
      throw new Error("Expected fontSize mark in schema");
    }

    let state = EditorState.create({
      doc: schema.node("doc", null, [schema.node("paragraph")]),
      schema,
    });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );

    const didSetMark = setMark(fontSize, { size: 32 })(state, (tr) => {
      state = state.apply(tr);
    });

    expect(didSetMark).toBe(true);
    expect(state.storedMarks?.some((mark) => mark.type === fontSize)).toBe(
      true,
    );
    expect(state.doc.firstChild?.attrs.defaultTextFormatting).toEqual({
      fontSize: 32,
    });
  });
});
