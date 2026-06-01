import { describe, test, expect } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";

import { acceptChange, rejectChange } from "../../commands/comments";
import { createSuggestionModePlugin } from "../../plugins/suggestionMode";
import { toggleBulletList } from "./ListExtension";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: {
        numPr: { default: null },
        listIsBullet: { default: null },
        listNumFmt: { default: null },
        listMarker: { default: null },
        _propertyChanges: { default: null },
        pPrMark: { default: null },
      },
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
  marks: {
    insertion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: { revisionId: {}, author: {}, date: {} },
      toDOM: () => ["del", 0],
    },
  },
});

describe("ListExtension suggestion mode integration", () => {
  test("toggle list in suggesting mode records paragraph property changes (w:pPrChange)", () => {
    const plugin = createSuggestionModePlugin(true, "Jane");

    let state = EditorState.create({
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Hello")]),
      ]),
      plugins: [plugin],
    });

    // Place selection in the first paragraph
    const sel = TextSelection.create(state.doc, 3);
    state = state.apply(state.tr.setSelection(sel));

    // Initially numPr is null, no _propertyChanges
    const initialPara = state.doc.child(0);
    expect(initialPara.attrs.numPr).toBeNull();
    expect(initialPara.attrs._propertyChanges).toBeNull();

    // Toggle bullet list
    let dispatched = false;
    toggleBulletList(state, (tr) => {
      state = state.apply(tr);
      dispatched = true;
    });

    expect(dispatched).toBe(true);

    // Paragraph should now have numPr set, and also _propertyChanges set!
    const updatedPara = state.doc.child(0);
    expect(updatedPara.attrs.numPr).toEqual({ numId: 1, ilvl: 0 });

    expect(updatedPara.attrs._propertyChanges).not.toBeNull();
    expect(updatedPara.attrs._propertyChanges.length).toBe(1);

    const propChange = updatedPara.attrs._propertyChanges[0];
    expect(propChange.type).toBe("paragraphPropertyChange");
    expect(propChange.info.author).toBe("Jane");
    expect(propChange.previousFormatting).toEqual({ numPr: null });
  });

  test("accept bullet list suggestion clears property changes and keeps list formatting", () => {
    const plugin = createSuggestionModePlugin(true, "Jane");

    let state = EditorState.create({
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Hello")]),
      ]),
      plugins: [plugin],
    });

    const sel = TextSelection.create(state.doc, 3);
    state = state.apply(state.tr.setSelection(sel));

    // Toggle list
    toggleBulletList(state, (tr) => {
      state = state.apply(tr);
    });

    // Make sure we have a property change
    let para = state.doc.child(0);
    expect(para.attrs._propertyChanges).not.toBeNull();

    // Now accept the change
    let accepted = false;
    acceptChange(0, state.doc.content.size)(state, (tr) => {
      state = state.apply(tr);
      accepted = true;
    });

    expect(accepted).toBe(true);

    // After accept, list properties should remain but _propertyChanges should be cleared
    para = state.doc.child(0);
    expect(para.attrs.numPr).toEqual({ numId: 1, ilvl: 0 });
    expect(para.attrs._propertyChanges).toBeNull();
  });

  test("reject bullet list suggestion restores previous formatting (numPr: null)", () => {
    const plugin = createSuggestionModePlugin(true, "Jane");

    let state = EditorState.create({
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Hello")]),
      ]),
      plugins: [plugin],
    });

    const sel = TextSelection.create(state.doc, 3);
    state = state.apply(state.tr.setSelection(sel));

    // Toggle list
    toggleBulletList(state, (tr) => {
      state = state.apply(tr);
    });

    // Make sure we have a property change
    let para = state.doc.child(0);
    expect(para.attrs._propertyChanges).not.toBeNull();

    // Now reject the change
    let rejected = false;
    rejectChange(0, state.doc.content.size)(state, (tr) => {
      state = state.apply(tr);
      rejected = true;
    });

    expect(rejected).toBe(true);

    // After reject, list properties should be restored to null and _propertyChanges cleared
    para = state.doc.child(0);
    expect(para.attrs.numPr).toBeNull();
    expect(para.attrs._propertyChanges).toBeNull();
  });
});
