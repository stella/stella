import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "../../schema";
import { setMark, textFormattingToMarks } from "./markUtils";

describe("rtl run direction round-trips through the mark helpers", () => {
  // eigenpal/docx-editor#806: the conversion path handled `rtl`, but the
  // live-edit / clipboard / keymap helpers (`textFormattingToMarks` /
  // `marksToTextFormatting`) had no rtl branch, so an Arabic/Hebrew run lost
  // its direction the moment it was re-marked in the editor.
  test("textFormattingToMarks emits the rtl mark", () => {
    const rtl = schema.marks.rtl;
    if (!rtl) {
      throw new Error("Expected rtl mark in schema");
    }
    const marks = textFormattingToMarks({ rtl: true }, schema);
    expect(marks.some((mark) => mark.type === rtl)).toBe(true);
  });

  test("setMark(rtl) records rtl in the paragraph default text formatting", () => {
    const rtl = schema.marks.rtl;
    if (!rtl) {
      throw new Error("Expected rtl mark in schema");
    }
    let state = EditorState.create({
      doc: schema.node("doc", null, [schema.node("paragraph")]),
      schema,
    });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );

    setMark(rtl, {})(state, (tr) => {
      state = state.apply(tr);
    });

    expect(state.doc.firstChild?.attrs.defaultTextFormatting).toEqual({
      rtl: true,
    });
  });
});

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
