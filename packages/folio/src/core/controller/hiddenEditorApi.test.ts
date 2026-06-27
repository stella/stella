import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";
import type { Command, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../prosemirror/schema";
import {
  createHiddenEditorApi,
  type HiddenEditorApiDeps,
} from "./hiddenEditorApi";

// The API only touches a handful of EditorView members; a structural stub
// keeps the tests free of a real DOM-backed view (the repo convention).
type StubView = Pick<EditorView, "state" | "dispatch" | "hasFocus">;

type StubViewOptions = {
  focused?: boolean;
  onDispatch?: (tr: Transaction) => void;
};

const makeStubView = (options: StubViewOptions = {}): StubView => ({
  state: EditorState.create({ schema }),
  dispatch: (tr: Transaction) => {
    options.onDispatch?.(tr);
  },
  hasFocus: () => options.focused ?? false,
});

// SAFETY: the API under test only reads `state`, `dispatch`, and `hasFocus`,
// all present on the structural stub; a real DOM-backed EditorView cannot be
// constructed in this headless test environment.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const asView = (view: StubView): EditorView => view as EditorView;

const makeDeps = (
  view: StubView | null,
  isDestroying = false,
): HiddenEditorApiDeps => ({
  getView: () => (view === null ? null : asView(view)),
  getDocumentContext: () => null,
  isDestroying: () => isDestroying,
});

describe("createHiddenEditorApi", () => {
  test("getState returns the view's state", () => {
    const view = makeStubView();
    const api = createHiddenEditorApi(makeDeps(view));
    expect(api.getState()).toBe(view.state);
  });

  test("getState returns null without a view", () => {
    const api = createHiddenEditorApi(makeDeps(null));
    expect(api.getState()).toBeNull();
  });

  test("getView passes the view through", () => {
    const view = makeStubView();
    const api = createHiddenEditorApi(makeDeps(view));
    expect(api.getView()).toBe(asView(view));
    expect(createHiddenEditorApi(makeDeps(null)).getView()).toBeNull();
  });

  test("getDocument returns null when the context document is null", () => {
    const api = createHiddenEditorApi(makeDeps(makeStubView()));
    expect(api.getDocument()).toBeNull();
  });

  test("isFocused reflects hasFocus()", () => {
    expect(
      createHiddenEditorApi(
        makeDeps(makeStubView({ focused: true })),
      ).isFocused(),
    ).toBe(true);
    expect(
      createHiddenEditorApi(
        makeDeps(makeStubView({ focused: false })),
      ).isFocused(),
    ).toBe(false);
    expect(createHiddenEditorApi(makeDeps(null)).isFocused()).toBe(false);
  });

  test("dispatch forwards to the view when not destroying", () => {
    let dispatched = 0;
    const view = makeStubView({
      onDispatch: () => {
        dispatched += 1;
      },
    });
    const api = createHiddenEditorApi(makeDeps(view));
    api.dispatch(view.state.tr);
    expect(dispatched).toBe(1);
  });

  test("dispatch is a no-op while destroying", () => {
    let dispatched = 0;
    const view = makeStubView({
      onDispatch: () => {
        dispatched += 1;
      },
    });
    const api = createHiddenEditorApi(makeDeps(view, true));
    api.dispatch(view.state.tr);
    expect(dispatched).toBe(0);
  });

  test("executeCommand returns false without a view", () => {
    const api = createHiddenEditorApi(makeDeps(null));
    const command: Command = () => true;
    expect(api.executeCommand(command)).toBe(false);
  });

  test("scrollToSelection is a no-op that does not throw", () => {
    const api = createHiddenEditorApi(makeDeps(makeStubView()));
    expect(() => {
      api.scrollToSelection();
    }).not.toThrow();
  });
});
