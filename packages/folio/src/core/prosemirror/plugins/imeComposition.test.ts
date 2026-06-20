/**
 * IME composition handling in suggestion mode.
 *
 * Regression coverage for Japanese / CJK input garbling: while an IME
 * composition is in flight the plugin must NOT mark the composed text (the
 * `appendTransaction` catch-all is suppressed), and the committed text must be
 * marked as a tracked insertion once, on compositionend. See
 * `createSuggestionModePlugin`'s IME guards and eigenpal/docx-editor#938.
 *
 * The composition handling lives in view-level DOM handlers, so these tests
 * drive `props.handleDOMEvents` against a minimal mock view whose `dispatch`
 * runs the real `EditorState.apply` pipeline (so the plugin's
 * `appendTransaction` runs exactly as it would in the browser).
 */

import { describe, test, expect } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import {
  createSuggestionModePlugin,
  suggestionModeKey,
} from "./suggestionMode";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    // Mirror the production tracked-change marks (TrackedChangeExtensions):
    // inclusive: false so text typed at a revision boundary does not inherit it.
    insertion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      inclusive: false,
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      inclusive: false,
      toDOM: () => ["del", 0],
    },
  },
});

type MockView = {
  state: EditorState;
  composing: boolean;
  dispatch: (tr: Transaction) => void;
};

function makeMockView(state: EditorState): MockView {
  const view: MockView = {
    state,
    composing: false,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}

function insertionText(state: EditorState): string[] {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "insertion")) {
      out.push(node.text ?? "");
    }
  });
  return out;
}

function deletionText(state: EditorState): string[] {
  const out: string[] = [];
  state.doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "deletion")) {
      out.push(node.text ?? "");
    }
  });
  return out;
}

type DomEvents = Record<string, (view: unknown, event?: unknown) => boolean>;

/** Build an active suggestion-mode editor with the cursor at the end of `text`. */
function setup(text: string): {
  view: MockView;
  domEvents: DomEvents;
  handleTextInput: (
    v: unknown,
    from: number,
    to: number,
    text: string,
  ) => boolean;
} {
  const plugin = createSuggestionModePlugin(true, "TestUser");
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(text)]),
  ]);
  const state = EditorState.create({ doc, plugins: [plugin] });
  const view = makeMockView(
    state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, text.length + 1)),
    ),
  );
  // SAFETY: handleDOMEvents and handleTextInput are present on this plugin.
  const props = plugin.props as {
    handleDOMEvents: DomEvents;
    handleTextInput: (
      v: unknown,
      from: number,
      to: number,
      text: string,
    ) => boolean;
  };
  return {
    view,
    domEvents: props.handleDOMEvents,
    handleTextInput: props.handleTextInput,
  };
}

describe("SuggestionMode IME composition", () => {
  test("composed text is NOT marked while a composition is in flight", () => {
    const { view, domEvents } = setup("Hello");

    domEvents.compositionstart(view);
    // PM commits composed text as a plain (non-suggestion) transaction.
    view.dispatch(view.state.tr.insertText("日本語", 6, 6));

    // The catch-all must stay out of the way mid-composition.
    expect(insertionText(view.state)).toEqual([]);
    expect(view.state.doc.textContent).toBe("Hello日本語");
    // The surrounding text must not be struck through as a tracked deletion.
    expect(deletionText(view.state)).toEqual([]);
  });

  test("compositionend marks the committed range as a tracked insertion", async () => {
    const { view, domEvents } = setup("Hello");

    domEvents.compositionstart(view);
    view.dispatch(view.state.tr.insertText("日本語", 6, 6));
    domEvents.compositionend(view);
    // Marking is deferred one microtask so it lands after the composition settles.
    await Promise.resolve();
    await Promise.resolve();

    expect(insertionText(view.state)).toEqual(["日本語"]);
    // The preceding text is NOT marked as a deletion (the garbling assertion).
    expect(deletionText(view.state)).toEqual([]);
    // The caret stays collapsed right after the committed text (not before it).
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.from).toBe(9); // 'Hello'(5) + '日本語'(3) + 1 doc offset
  });

  test("handleTextInput does NOT re-insert composed text while composing", () => {
    // PM commits composed text from the DOM and then calls handleTextInput with
    // it. Re-inserting there duplicates the text (the reported garbling), so the
    // handler must decline while a composition is in flight.
    const { view, domEvents, handleTextInput } = setup("Hello");

    domEvents.compositionstart(view);
    const handled = handleTextInput(view, 6, 6, "あ");

    expect(handled).toBe(false);
    expect(view.state.doc.textContent).toBe("Hello"); // nothing re-inserted
  });

  test("handleTextInput still tracks plain input when not composing", () => {
    const { view, handleTextInput } = setup("Hello");

    const handled = handleTextInput(view, 6, 6, "Z");

    expect(handled).toBe(true);
    expect(view.state.doc.textContent).toBe("HelloZ");
    expect(insertionText(view.state)).toContain("Z");
  });

  test("composed text is left unmarked if suggestion mode is toggled off before compositionend settles", async () => {
    const { view, domEvents } = setup("Hello");

    domEvents.compositionstart(view);
    view.dispatch(view.state.tr.insertText("日本語", 6, 6));
    // Toggle suggestion mode OFF before the deferred marking runs.
    view.dispatch(view.state.tr.setMeta(suggestionModeKey, { active: false }));
    domEvents.compositionend(view);
    await Promise.resolve();
    await Promise.resolve();

    // Tracking is off now, so the composed text must NOT be marked.
    expect(insertionText(view.state)).toEqual([]);
    expect(view.state.doc.textContent).toBe("Hello日本語");
  });

  test("composing over a selection records the replaced text as a tracked deletion (eigenpal/docx-editor#938)", async () => {
    const { view, domEvents } = setup("Hello World");
    // Select "World" (positions 7..12) and start composing over it.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 12)),
    );

    domEvents.compositionstart(view);
    // compositionstart struck the selection and collapsed the caret after it;
    // PM then commits the composed text at the caret.
    const caret = view.state.selection.from;
    view.dispatch(view.state.tr.insertText("世界", caret, caret));
    domEvents.compositionend(view);
    await Promise.resolve();
    await Promise.resolve();

    // Redline preserved: the replaced selection is struck, the composed text inserted.
    expect(deletionText(view.state)).toEqual(["World"]);
    expect(insertionText(view.state)).toEqual(["世界"]);
    expect(view.state.doc.textContent).toBe("Hello World世界");
  });

  test("the catch-all resumes for non-composition input after composing ends", async () => {
    const { view, domEvents } = setup("Hello");

    domEvents.compositionstart(view);
    view.dispatch(view.state.tr.insertText("あ", 6, 6));
    domEvents.compositionend(view);
    await Promise.resolve();
    await Promise.resolve();

    // A later plain insertion (paste-like), away from the composed run so it
    // can't merely inherit the adjacent mark, is tracked by the catch-all.
    view.dispatch(view.state.tr.insertText("X", 1, 1));
    expect(insertionText(view.state)).toContain("X");
  });
});
