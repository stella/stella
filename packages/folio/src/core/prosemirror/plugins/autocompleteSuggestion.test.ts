import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";

import {
  acceptAutocompleteSuggestion,
  acceptAutocompleteWord,
  appendAutocompleteToken,
  autocompleteSuggestionPlugin,
  clearAutocompleteSuggestion,
  finishAutocompleteSuggestion,
  getAutocompleteSuggestion,
  shouldTriggerAutocomplete,
  startAutocompleteSuggestion,
} from "./autocompleteSuggestion";

const schema = new Schema({
  nodes: {
    doc: { content: "block*" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "inline*", toDOM: () => ["h1", 0] },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      toDOM: () => ["pre", ["code", 0]],
    },
    text: { group: "inline" },
  },
});

type BlockName = "paragraph" | "heading" | "code_block";

const blockDoc = (block: BlockName, text: string): PMNode =>
  schema.node("doc", null, [
    schema.node(block, null, text.length > 0 ? [schema.text(text)] : []),
  ]);

const emptyDoc = (): PMNode => schema.node("doc", null, []);

// Caret immediately after the text of a single-block document: the
// block opens at doc position 0, so content starts at 1.
const endOfText = (text: string): number => 1 + text.length;

const mkState = (doc: PMNode, caret?: number): EditorState => {
  const plugins = [autocompleteSuggestionPlugin()];
  if (caret === undefined) {
    return EditorState.create({ doc, plugins });
  }
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, caret),
    plugins,
  });
};

const docText = (state: EditorState): string => {
  let out = "";
  state.doc.descendants((node) => {
    if (node.isText && node.text !== undefined) {
      out += node.text;
    }
  });
  return out;
};

// Build a state with a fully streamed-and-finished ("shown") suggestion
// anchored at the end of a paragraph's text.
const shownState = (
  base: string,
  suggestion: string,
  requestId = "r1",
): { state: EditorState; anchor: number } => {
  const anchor = endOfText(base);
  let state = mkState(blockDoc("paragraph", base), anchor);
  state = state.apply(startAutocompleteSuggestion(state.tr, anchor, requestId));
  state = state.apply(appendAutocompleteToken(state.tr, requestId, suggestion));
  state = state.apply(finishAutocompleteSuggestion(state.tr, requestId));
  return { state, anchor };
};

describe("autocompleteSuggestion reducer", () => {
  test("start enters streaming with empty text and the anchor", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    const sug = getAutocompleteSuggestion(state);
    expect(sug.status).toBe("streaming");
    expect(sug.anchor).toBe(5);
    expect(sug.text).toBe("");
    expect(sug.requestId).toBe("r1");
  });

  test("tokens for the active request accumulate in order", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", " Sir"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", " or Madam"));
    const sug = getAutocompleteSuggestion(state);
    expect(sug.text).toBe(" Sir or Madam");
    expect(sug.status).toBe("streaming");
  });

  test("tokens from a stale request are ignored", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", "a"));
    state = state.apply(appendAutocompleteToken(state.tr, "stale", "b"));
    expect(getAutocompleteSuggestion(state).text).toBe("a");
  });

  test("tokens while idle are ignored", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", "a"));
    expect(getAutocompleteSuggestion(state).status).toBe("idle");
  });

  test("finish for the active request promotes streaming to shown", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", " Sir"));
    state = state.apply(finishAutocompleteSuggestion(state.tr, "r1"));
    expect(getAutocompleteSuggestion(state).status).toBe("shown");
  });

  test("finish for a stale request does not change status", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    state = state.apply(finishAutocompleteSuggestion(state.tr, "stale"));
    expect(getAutocompleteSuggestion(state).status).toBe("streaming");
  });

  test("clear returns to idle", () => {
    const { state } = shownState("Dear", " Sir");
    const cleared = state.apply(clearAutocompleteSuggestion(state.tr));
    expect(getAutocompleteSuggestion(cleared).status).toBe("idle");
  });

  test("a doc-changing transaction without meta dismisses the suggestion", () => {
    const { state } = shownState("Dear", " Sir");
    const edited = state.apply(state.tr.insertText("x", 1));
    expect(getAutocompleteSuggestion(edited).status).toBe("idle");
  });

  test("a selection-only transaction preserves the suggestion", () => {
    const { state } = shownState("Dear", " Sir");
    const moved = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 2)),
    );
    const sug = getAutocompleteSuggestion(moved);
    expect(sug.status).toBe("shown");
    expect(sug.text).toBe(" Sir");
  });
});

describe("acceptAutocompleteSuggestion", () => {
  test("is a no-op when idle", () => {
    const state = mkState(blockDoc("paragraph", "Dear"));
    expect(acceptAutocompleteSuggestion(state)).toEqual({ accepted: false });
  });

  test("is a no-op while streaming with no text yet", () => {
    let state = mkState(blockDoc("paragraph", "Dear"));
    state = state.apply(startAutocompleteSuggestion(state.tr, 5, "r1"));
    expect(acceptAutocompleteSuggestion(state)).toEqual({ accepted: false });
  });

  test("inserts the suggestion at the anchor and clears state", () => {
    const { state, anchor } = shownState("Dear", " Sir");
    let next = state;
    const result = acceptAutocompleteSuggestion(next, (tr) => {
      next = next.apply(tr);
    });
    expect(result).toEqual({
      accepted: true,
      from: anchor,
      to: anchor + 4,
      text: " Sir",
    });
    expect(docText(next)).toBe("Dear Sir");
    expect(getAutocompleteSuggestion(next).status).toBe("idle");
  });

  test("can accept mid-stream (status streaming)", () => {
    const anchor = endOfText("Dear");
    let state = mkState(blockDoc("paragraph", "Dear"), anchor);
    state = state.apply(startAutocompleteSuggestion(state.tr, anchor, "r1"));
    state = state.apply(appendAutocompleteToken(state.tr, "r1", " Sir"));
    expect(getAutocompleteSuggestion(state).status).toBe("streaming");
    let next = state;
    const result = acceptAutocompleteSuggestion(next, (tr) => {
      next = next.apply(tr);
    });
    expect(result.accepted).toBe(true);
    expect(docText(next)).toBe("Dear Sir");
    expect(getAutocompleteSuggestion(next).status).toBe("idle");
  });

  test("without dispatch it reports the accept without mutating", () => {
    const { state, anchor } = shownState("Dear", " Sir");
    const result = acceptAutocompleteSuggestion(state);
    expect(result).toEqual({
      accepted: true,
      from: anchor,
      to: anchor + 4,
      text: " Sir",
    });
    expect(docText(state)).toBe("Dear");
    expect(getAutocompleteSuggestion(state).status).toBe("shown");
  });
});

describe("acceptAutocompleteWord", () => {
  test("consumes one word and shrinks the remaining suggestion", () => {
    const { state, anchor } = shownState("Dear", "Sir or Madam");
    let next = state;
    const result = acceptAutocompleteWord(next, (tr) => {
      next = next.apply(tr);
    });
    expect(result).toEqual({
      accepted: true,
      from: anchor,
      to: anchor + 4,
      text: "Sir ",
    });
    expect(docText(next)).toBe("DearSir ");
    const sug = getAutocompleteSuggestion(next);
    expect(sug.text).toBe("or Madam");
    expect(sug.anchor).toBe(anchor + 4);
    expect(sug.status).toBe("shown");
  });

  test("keeps leading whitespace attached to the consumed word", () => {
    const { state } = shownState("Dear", " foo bar");
    let next = state;
    const result = acceptAutocompleteWord(next, (tr) => {
      next = next.apply(tr);
    });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.text).toBe(" foo ");
    }
    expect(getAutocompleteSuggestion(next).text).toBe("bar");
  });

  test("falls through to full accept on the final word", () => {
    const { state } = shownState("Dear", "End");
    let next = state;
    const result = acceptAutocompleteWord(next, (tr) => {
      next = next.apply(tr);
    });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.text).toBe("End");
    }
    expect(docText(next)).toBe("DearEnd");
    expect(getAutocompleteSuggestion(next).status).toBe("idle");
  });

  test("is a no-op when idle", () => {
    const state = mkState(blockDoc("paragraph", "Dear"));
    expect(acceptAutocompleteWord(state)).toEqual({ accepted: false });
  });
});

describe("shouldTriggerAutocomplete", () => {
  test("fires after a word boundary in prose", () => {
    const state = mkState(blockDoc("paragraph", "Hello "), endOfText("Hello "));
    expect(shouldTriggerAutocomplete(state)).toEqual({ ok: true });
  });

  test("skips when the selection is a range", () => {
    const doc = blockDoc("paragraph", "hello");
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 4),
      plugins: [autocompleteSuggestionPlugin()],
    });
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "selection-non-empty",
    });
  });

  test("skips an empty document", () => {
    const state = mkState(emptyDoc());
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "empty-doc",
    });
  });

  test("skips inside a heading dead zone", () => {
    const state = mkState(blockDoc("heading", "Title"), 1);
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "deadzone",
      detail: "heading",
    });
  });

  test("skips inside a code block dead zone", () => {
    const state = mkState(blockDoc("code_block", "x = 1"), 1);
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "deadzone",
      detail: "code_block",
    });
  });

  test("skips mid-word after an ASCII letter", () => {
    const state = mkState(blockDoc("paragraph", "foo"), endOfText("foo"));
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "midword",
      detail: "o",
    });
  });

  test("treats an accented letter as a word continuation char", () => {
    const state = mkState(blockDoc("paragraph", "Dobrý"), endOfText("Dobrý"));
    expect(shouldTriggerAutocomplete(state)).toEqual({
      ok: false,
      reason: "midword",
      detail: "ý",
    });
  });

  test("honours extra dead-zone node names from options", () => {
    const state = mkState(blockDoc("paragraph", "x"), 1);
    expect(
      shouldTriggerAutocomplete(state, { extraDeadZoneNodes: ["paragraph"] }),
    ).toEqual({ ok: false, reason: "deadzone", detail: "paragraph" });
  });
});
