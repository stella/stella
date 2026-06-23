import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorState as PMEditorState } from "prosemirror-state";

import { schema } from "../schema";
import {
  clearTemplateSlashMenu,
  consumeTemplateSlashQuery,
  getTemplateSlashMenu,
  resetTemplateSlashQuery,
  templateSlashMenuKey,
  templateSlashMenuPlugin,
} from "./templateSlashMenu";

/** A single-paragraph doc with `text`, caret parked at `caret` (a parent
 *  offset, converted to the absolute PM position by the leading "+1"). */
const stateWith = (text: string, caret: number): PMEditorState => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text === "" ? null : [schema.text(text)]),
  ]);
  return EditorState.create({
    doc,
    plugins: [templateSlashMenuPlugin()],
    selection: TextSelection.create(doc, caret + 1),
  });
};

/** Open the menu anchored at the `/` already present at `slashOffset`
 *  (parent offset), with the caret just past it. Mirrors what the plugin's
 *  handleTextInput dispatches once PM has inserted the `/`. */
const openAt = (state: PMEditorState, slashOffset: number): PMEditorState => {
  const tr = state.tr.setMeta(templateSlashMenuKey, {
    type: "open",
    from: slashOffset + 1,
    query: "",
  });
  return state.apply(tr);
};

describe("templateSlashMenu state machine", () => {
  test("typing field-name chars after the slash extends the query", () => {
    // "/" already typed at offset 0, caret after it.
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    expect(getTemplateSlashMenu(state).active).toBe(true);

    // Type "fee": each insertText moves the caret and re-derives the query.
    for (const char of "fee") {
      const at = state.selection.from;
      state = state.apply(state.tr.insertText(char, at));
    }
    const open = getTemplateSlashMenu(state);
    expect(open.active).toBe(true);
    expect(open.active && open.query).toBe("fee");
  });

  test("a space after the slash closes the menu (ends the query)", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = state.apply(state.tr.insertText(" ", state.selection.from));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("deleting the slash closes the menu", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    // Remove the "/" itself.
    state = state.apply(state.tr.delete(1, 2));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("moving the caret before the slash closes the menu", () => {
    let state = stateWith("a/", 2);
    state = openAt(state, 1);
    // Caret jumps to the very start, before the "/".
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("clear meta tears the menu down regardless of caret", () => {
    let state = stateWith("/field", 6);
    state = openAt(state, 0);
    expect(getTemplateSlashMenu(state).active).toBe(true);
    state = state.apply(clearTemplateSlashMenu(state.tr));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });
});

describe("consumeTemplateSlashQuery", () => {
  test("deletes the /query range and reports it for marker insertion", () => {
    let state = stateWith("Fee /field", 10);
    state = openAt(state, 4);
    const result = consumeTemplateSlashQuery(state);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.from).toBe(5);
    expect(result.to).toBe(11);
    const after = state.apply(result.tr);
    expect(after.doc.textContent).toBe("Fee ");
    expect(getTemplateSlashMenu(after).active).toBe(false);
  });

  test("returns null when no trigger is active", () => {
    const state = stateWith("plain prose", 5);
    expect(consumeTemplateSlashQuery(state)).toBeNull();
  });
});

describe("resetTemplateSlashQuery", () => {
  test("clears the typed query but keeps the slash and the trigger active", () => {
    let state = stateWith("/clause", 7);
    state = openAt(state, 0);
    const tr = resetTemplateSlashQuery(state);
    expect(tr).not.toBeNull();
    if (tr === null) {
      return;
    }
    const after = state.apply(tr);
    expect(after.doc.textContent).toBe("/");
    const open = getTemplateSlashMenu(after);
    expect(open.active).toBe(true);
    expect(open.active && open.query).toBe("");
  });

  test("returns null when the query is already empty", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    expect(resetTemplateSlashQuery(state)).toBeNull();
  });
});
