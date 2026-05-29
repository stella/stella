import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import type { Plugin } from "prosemirror-state";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  createSuggestionModePlugin,
  paragraphBoundaryTarget,
} from "./suggestionMode";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      attrs: { pPrMark: { default: null } },
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

type FakeView = {
  state: EditorState;
  dispatch: EditorView["dispatch"];
};

function createFakeView(state: EditorState): FakeView {
  const view: FakeView = {
    state,
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}

function plug(): Plugin {
  return createSuggestionModePlugin(true, "Tester");
}

function setCaret(state: EditorState, pos: number): EditorState {
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, pos)),
  );
}

function makeDoc(paragraphs: { text: string; pPrMark?: unknown }[]) {
  return schema.node(
    "doc",
    null,
    paragraphs.map((p) =>
      schema.node(
        "paragraph",
        { pPrMark: p.pPrMark ?? null },
        p.text ? [schema.text(p.text)] : [],
      ),
    ),
  );
}

function stateWith(paragraphs: { text: string; pPrMark?: unknown }[]) {
  return EditorState.create({
    schema,
    doc: makeDoc(paragraphs),
    plugins: [plug()],
  });
}

describe("paragraphBoundaryTarget", () => {
  test("returns previous paragraph position when caret is at start of paragraph", () => {
    const initial = stateWith([{ text: "first" }, { text: "second" }]);
    // Position of caret at start of "second" — start of "first" is 1,
    // end is 1 + "first".length + 1 (paragraph close) = 7, start of "second" is 8.
    const state = setCaret(initial, 8);
    expect(paragraphBoundaryTarget(state, "backward")).toBe(0);
  });

  test("returns null when caret is mid-paragraph", () => {
    const initial = stateWith([{ text: "hello" }, { text: "world" }]);
    const state = setCaret(initial, 3);
    expect(paragraphBoundaryTarget(state, "backward")).toBeNull();
    expect(paragraphBoundaryTarget(state, "forward")).toBeNull();
  });

  test("returns current paragraph position when caret is at end of paragraph", () => {
    const initial = stateWith([{ text: "first" }, { text: "second" }]);
    // End of "first" is 1 + 5 = 6.
    const state = setCaret(initial, 6);
    expect(paragraphBoundaryTarget(state, "forward")).toBe(0);
  });

  test("returns null at document edges (Backspace at doc start, Delete at doc end)", () => {
    const initial = stateWith([{ text: "lone" }]);
    const startCaret = setCaret(initial, 1);
    const endCaret = setCaret(initial, 5);
    expect(paragraphBoundaryTarget(startCaret, "backward")).toBeNull();
    expect(paragraphBoundaryTarget(endCaret, "forward")).toBeNull();
  });
});

describe("suggestion mode — paragraph-mark keymap", () => {
  test("Enter mid-paragraph stamps pPrMark.kind='ins' on the first half", () => {
    const initial = stateWith([{ text: "hello world" }]);
    const state = setCaret(initial, 6);
    const view = createFakeView(state);
    const p = plug();
    const handled = p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Enter" } as KeyboardEvent,
    );

    expect(handled).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).textContent).toBe("hello");
    expect(view.state.doc.child(1).textContent).toBe(" world");

    const firstPPrMark = view.state.doc.child(0).attrs["pPrMark"] as {
      kind: "ins" | "del";
      info: { id?: unknown; revisionId?: unknown; author: string };
    } | null;
    expect(firstPPrMark?.kind).toBe("ins");
    expect(typeof firstPPrMark?.info.id).toBe("number");
    expect(firstPPrMark?.info.revisionId).toBeUndefined();
    expect(firstPPrMark?.info.author).toBe("Tester");
    expect(view.state.doc.child(1).attrs["pPrMark"]).toBeNull();
  });

  test("Enter does not overwrite an existing pPrMark on the source paragraph", () => {
    const existing = {
      kind: "ins" as const,
      info: { id: 99, author: "Other", date: "2026-01-01" },
    };
    const initial = stateWith([{ text: "hello world", pPrMark: existing }]);
    const state = setCaret(initial, 6);
    const view = createFakeView(state);
    const p = plug();
    p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Enter" } as KeyboardEvent,
    );

    expect(view.state.doc.child(0).attrs["pPrMark"]).toEqual(existing);
  });

  test("Backspace at paragraph start sets pPrMark.kind='del' on the previous paragraph", () => {
    const initial = stateWith([{ text: "first" }, { text: "second" }]);
    const state = setCaret(initial, 8);
    const view = createFakeView(state);
    const p = plug();
    p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Backspace" } as KeyboardEvent,
    );

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(1).textContent).toBe("second");
    const firstMark = view.state.doc.child(0).attrs["pPrMark"] as {
      kind: "ins" | "del";
      info: { id?: unknown; revisionId?: unknown };
    } | null;
    expect(firstMark?.kind).toBe("del");
    expect(typeof firstMark?.info.id).toBe("number");
    expect(firstMark?.info.revisionId).toBeUndefined();
  });

  test("Delete at paragraph end sets pPrMark.kind='del' on the current paragraph", () => {
    const initial = stateWith([{ text: "first" }, { text: "second" }]);
    const state = setCaret(initial, 6);
    const view = createFakeView(state);
    const p = plug();
    p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Delete" } as KeyboardEvent,
    );

    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.child(0).textContent).toBe("first");
    const firstMark = view.state.doc.child(0).attrs["pPrMark"] as {
      kind: "ins" | "del";
      info: { id?: unknown; revisionId?: unknown };
    } | null;
    expect(firstMark?.kind).toBe("del");
    expect(typeof firstMark?.info.id).toBe("number");
    expect(firstMark?.info.revisionId).toBeUndefined();
  });

  test("Backspace retracts the current author's paragraph-mark insertion", () => {
    const initial = stateWith([
      {
        text: "first",
        pPrMark: {
          kind: "ins",
          info: { id: 99, author: "Tester", date: "2026-05-01" },
        },
      },
      { text: "second" },
    ]);
    const state = setCaret(initial, 8);
    const view = createFakeView(state);
    const p = plug();
    const handled = p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Backspace" } as KeyboardEvent,
    );

    expect(handled).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });

  test("Delete retracts the current author's paragraph-mark insertion", () => {
    const initial = stateWith([
      {
        text: "first",
        pPrMark: {
          kind: "ins",
          info: { id: 100, author: "Tester", date: "2026-05-01" },
        },
      },
      { text: "second" },
    ]);
    const state = setCaret(initial, 6);
    const view = createFakeView(state);
    const p = plug();
    const handled = p.props.handleKeyDown?.call(
      p,
      view as unknown as EditorView,
      { key: "Delete" } as KeyboardEvent,
    );

    expect(handled).toBe(true);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
    expect(view.state.doc.child(0).attrs["pPrMark"]).toBeNull();
  });
});
