import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import {
  dispatchEditorTextInput,
  isDeferredEditorKeyDown,
} from "./PagedEditor";

type KeyDownOptions = {
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
};

const keyEvent = (key: string, options: KeyDownOptions = {}) => ({
  altKey: false,
  ctrlKey: options.ctrlKey === true,
  key,
  metaKey: options.metaKey === true,
  nativeEvent: {
    isComposing: options.isComposing === true,
  },
});

type FakeTextInputHandler = (
  view: FakeTextInputView,
  from: number,
  to: number,
  text: string,
  defaultTransaction: () => Transaction,
) => unknown;

type FakeTextInputView = {
  dispatch(tr: Transaction): void;
  someProp(
    propName: "handleTextInput",
    f: (handler: FakeTextInputHandler) => unknown,
  ): unknown;
  state: EditorState;
};

const schema = new Schema({
  marks: {},
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
});

const createState = (text: string): EditorState => {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);

  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, text.length + 1),
  });
};

const createFakeTextInputView = (
  handler?: FakeTextInputHandler,
): FakeTextInputView => {
  const view: FakeTextInputView = {
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
    someProp(propName, f) {
      expect(propName).toBe("handleTextInput");
      if (!handler) {
        return undefined;
      }

      return f(handler);
    },
    state: createState("Hi"),
  };

  return view;
};

describe("deferred editor keydown detection", () => {
  test("replays edit and navigation keys while the hidden editor is deferred", () => {
    expect(isDeferredEditorKeyDown(keyEvent("Backspace"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Delete"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Enter"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("ArrowLeft"))).toBe(true);
    expect(isDeferredEditorKeyDown(keyEvent("Tab"))).toBe(true);
  });

  test("replays editor modifier shortcuts while the hidden editor is deferred", () => {
    expect(isDeferredEditorKeyDown(keyEvent("a", { metaKey: true }))).toBe(
      true,
    );
    expect(isDeferredEditorKeyDown(keyEvent("A", { ctrlKey: true }))).toBe(
      true,
    );
    expect(isDeferredEditorKeyDown(keyEvent("z", { metaKey: true }))).toBe(
      true,
    );
  });

  test("does not claim unrelated browser modifier shortcuts", () => {
    expect(isDeferredEditorKeyDown(keyEvent("p", { metaKey: true }))).toBe(
      false,
    );
    expect(isDeferredEditorKeyDown(keyEvent("s", { ctrlKey: true }))).toBe(
      false,
    );
  });

  test("replays composition key events", () => {
    expect(
      isDeferredEditorKeyDown(keyEvent("Process", { isComposing: true })),
    ).toBe(true);
  });
});

describe("deferred editor text replay", () => {
  test("routes text through handleTextInput hooks before dispatching fallback insertion", () => {
    let fallbackText: string | null = null;
    const view = createFakeTextInputView(
      (handlerView, from, to, text, defaultTransaction) => {
        expect(handlerView).toBe(view);
        expect(from).toBe(3);
        expect(to).toBe(3);
        expect(text).toBe("x");

        fallbackText = defaultTransaction().doc.textContent;
        handlerView.dispatch(
          handlerView.state.tr.insertText(`[${text}]`, from, to),
        );
        return true;
      },
    );

    dispatchEditorTextInput(view, "x");

    expect(fallbackText).toBe("Hix");
    expect(view.state.doc.textContent).toBe("Hi[x]");
  });

  test("falls back to ProseMirror text insertion when no text hook handles input", () => {
    const view = createFakeTextInputView();

    dispatchEditorTextInput(view, "x");

    expect(view.state.doc.textContent).toBe("Hix");
  });
});
