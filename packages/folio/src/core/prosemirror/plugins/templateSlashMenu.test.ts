import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import type {
  EditorState as PMEditorState,
  Transaction,
} from "prosemirror-state";

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

// These exercise the plugin's `props.handleKeyDown` / `props.handleTextInput`
// against a fake view (no DOM): the live keyboard/input path the paged editor
// drives, which the state-machine tests above never touch. A bug here passes
// those tests but breaks live, so the contract is pinned directly.
type FakeView = {
  state: PMEditorState;
  dispatch: (tr: Transaction) => void;
};

const makePluginHarness = (
  text: string,
  caret: number,
  onKeyAction?: (action: TemplateSlashMenuKeyAction) => boolean,
) => {
  const plugin = onKeyAction
    ? templateSlashMenuPlugin({ onKeyAction })
    : templateSlashMenuPlugin();
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text === "" ? null : [schema.text(text)]),
  ]);
  const view: FakeView = {
    state: EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, caret + 1),
    }),
    dispatch: (tr) => {
      view.state = view.state.apply(tr);
    },
  };
  const props = plugin.props as {
    handleKeyDown: (view: FakeView, event: KeyEventLike) => boolean;
    handleTextInput: (
      view: FakeView,
      from: number,
      to: number,
      text: string,
    ) => boolean;
  };
  return { view, props };
};

type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
};

const keyEvent = (
  key: string,
): KeyEventLike & { defaultPrevented: boolean } => {
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
};

describe("templateSlashMenu handleTextInput", () => {
  test('typing "/" at a boundary opens the menu and inserts the slash', () => {
    const { view, props } = makePluginHarness("", 0);
    const handled = props.handleTextInput(view, 1, 1, "/");
    expect(handled).toBe(true);
    expect(view.state.doc.textContent).toBe("/");
    expect(getTemplateSlashMenu(view.state).active).toBe(true);
  });

  test('"/" mid-word (no boundary) does not open the menu', () => {
    // Caret after "a"; the char before the caret is a word char.
    const { view, props } = makePluginHarness("a", 1);
    const handled = props.handleTextInput(view, 2, 2, "/");
    expect(handled).toBe(false);
    expect(getTemplateSlashMenu(view.state).active).toBe(false);
  });

  test("a non-slash char falls through so PM inserts and the query extends", () => {
    const { view, props } = makePluginHarness("/", 1);
    view.state = openAt(view.state, 0);
    // A regular char must NOT be consumed here; PM inserts it, and the state
    // machine extends the query on the resulting transaction.
    expect(props.handleTextInput(view, 2, 2, "f")).toBe(false);
    view.state = view.state.apply(view.state.tr.insertText("f", 2));
    const open = getTemplateSlashMenu(view.state);
    expect(open.active).toBe(true);
    expect(open.active && open.query).toBe("f");
  });
});

describe("templateSlashMenu handleKeyDown", () => {
  test("consumes ArrowDown/ArrowUp while open and drives onKeyAction", () => {
    const actions: TemplateSlashMenuKeyAction[] = [];
    const { view, props } = makePluginHarness("/", 1, (action) => {
      actions.push(action);
      return true;
    });
    view.state = openAt(view.state, 0);

    const down = keyEvent("ArrowDown");
    expect(props.handleKeyDown(view, down)).toBe(true);
    expect(down.defaultPrevented).toBe(true);

    const up = keyEvent("ArrowUp");
    expect(props.handleKeyDown(view, up)).toBe(true);
    expect(up.defaultPrevented).toBe(true);

    expect(actions).toEqual(["down", "up"]);
  });

  test("consumes Enter/ArrowRight/ArrowLeft while open", () => {
    const actions: TemplateSlashMenuKeyAction[] = [];
    const { view, props } = makePluginHarness("/", 1, (action) => {
      actions.push(action);
      return action !== "back"; // host treats back as a no-op here
    });
    view.state = openAt(view.state, 0);

    for (const key of ["Enter", "ArrowRight", "ArrowLeft"]) {
      const event = keyEvent(key);
      // Every navigation key is swallowed so the caret never escapes the menu,
      // even when the host treats it as a no-op (ArrowLeft → "back" → false).
      expect(props.handleKeyDown(view, event)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(actions).toEqual(["commit", "forward", "back"]);
  });

  test("passes keys through when the menu is closed", () => {
    const { view, props } = makePluginHarness("hello", 5);
    const event = keyEvent("ArrowDown");
    expect(props.handleKeyDown(view, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test("Escape the host does not consume tears the trigger down", () => {
    const { view, props } = makePluginHarness("/", 1, () => false);
    view.state = openAt(view.state, 0);
    const event = keyEvent("Escape");
    expect(props.handleKeyDown(view, event)).toBe(true);
    expect(getTemplateSlashMenu(view.state).active).toBe(false);
  });
});
