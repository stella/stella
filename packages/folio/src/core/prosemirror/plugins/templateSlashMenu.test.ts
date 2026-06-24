import { describe, expect, test } from "bun:test";
import { EditorState, TextSelection } from "prosemirror-state";
import type {
  EditorState as PMEditorState,
  Transaction,
} from "prosemirror-state";

import { schema } from "../schema";
import { createTemplateDirectivesPlugin } from "./templateDirectives";
import {
  clearTemplateSlashMenu,
  consumeTemplateSlashQuery,
  getTemplateSlashMenu,
  resetTemplateSlashQuery,
  templateSlashMenuKey,
  templateSlashMenuPlugin,
} from "./templateSlashMenu";
import type { TemplateSlashMenuKeyAction } from "./templateSlashMenu";

/** A single-paragraph doc with `text`, caret parked at `caret` (a parent
 *  offset, converted to the absolute PM position by the leading "+1"). */
const stateWith = (text: string, caret: number): PMEditorState => {
  const doc = schema.node("doc", null, [
    schema.node(
      "paragraph",
      null,
      text === "" ? undefined : [schema.text(text)],
    ),
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

/** Type `text` one character at a time at the caret (doc-changing transactions),
 *  the way real keystrokes drive the plugin. The query is caret-bounded and only
 *  updates on doc changes, so building it up via real inserts is how a query
 *  becomes active. */
const typeChars = (state: PMEditorState, text: string): PMEditorState => {
  let next = state;
  for (const char of text) {
    next = next.apply(next.tr.insertText(char, next.selection.from));
  }
  return next;
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

  test("typing a query stays open when prose follows the caret (bug: live filter)", () => {
    // Regression for the live bug where typing to filter dismissed the menu: the
    // query is caret-bounded, so existing prose AFTER the caret must NOT be
    // swallowed into the query nor trip the terminator check. Open before "lord"
    // (as if `/` was typed inside "Landlord") and type "field".
    let state = stateWith("Fee lord", 4); // caret after "Fee "
    state = state.apply(
      state.tr
        .insertText("/", 5)
        .setMeta(templateSlashMenuKey, { type: "open", from: 5, query: "" }),
    );
    // Doc is now "Fee /lord" with the caret right after the `/` (before "lord").
    state = typeChars(state, "field");
    const open = getTemplateSlashMenu(state);
    expect(open.active).toBe(true);
    // Query is exactly what was typed — the trailing "lord" is not part of it.
    expect(open.active && open.query).toBe("field");
    expect(state.doc.textContent).toBe("Fee /fieldlord");
  });

  test("a space after the slash closes the menu (ends the query)", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = state.apply(state.tr.insertText(" ", state.selection.from));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("punctuation right after the query closes the menu", () => {
    // `/field,` — the comma typed into the range ends the command just like a
    // space, so the menu stops capturing arrows/Enter once back in prose.
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = typeChars(state, "field");
    expect(getTemplateSlashMenu(state).active).toBe(true);
    state = state.apply(state.tr.insertText(",", state.selection.from));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("deleting the slash closes the menu", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    // Remove the "/" itself.
    state = state.apply(state.tr.delete(1, 2));
    expect(getTemplateSlashMenu(state).active).toBe(false);
  });

  test("a collapsed caret move does NOT close the menu", () => {
    // Closing is gated on explicit signals (range select, `/` deleted,
    // terminator typed), never the collapsed caret position — so any caret move
    // (a click, or a selection-only transaction) leaves the menu open. The host
    // popover owns click-away dismissal.
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = typeChars(state, "fi");
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );
    const open = getTemplateSlashMenu(state);
    expect(open.active).toBe(true);
    expect(open.active && open.query).toBe("fi");
  });

  test("a deliberate range selection closes the menu", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = typeChars(state, "fi");
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 3)),
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
    // Start with "Fee " (caret at end), insert the `/` + open meta the way the
    // keydown opener does, then type the query so it becomes active.
    let state = stateWith("Fee ", 4);
    state = state.apply(
      state.tr
        .insertText("/", 5)
        .setMeta(templateSlashMenuKey, { type: "open", from: 5, query: "" }),
    );
    state = typeChars(state, "field");
    expect(
      getTemplateSlashMenu(state).active && getTemplateSlashMenu(state).query,
    ).toBe("field");
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

  test("consumes the whole /query even when the caret sits inside it", () => {
    // Build an active `/field`, then move the caret back inside it (between
    // "/fi" and "eld"): the whole `/field` must still be removed, not just up to
    // the caret, or the trailing "eld" is orphaned next to the inserted marker.
    let state = stateWith("Fee ", 4);
    state = state.apply(
      state.tr
        .insertText("/", 5)
        .setMeta(templateSlashMenuKey, { type: "open", from: 5, query: "" }),
    );
    state = typeChars(state, "field");
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 8)),
    );
    expect(getTemplateSlashMenu(state).active).toBe(true);
    const result = consumeTemplateSlashQuery(state);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.from).toBe(5);
    expect(result.to).toBe(11);
    const after = state.apply(result.tr);
    expect(after.doc.textContent).toBe("Fee ");
  });

  test("returns null when no trigger is active", () => {
    const state = stateWith("plain prose", 5);
    expect(consumeTemplateSlashQuery(state)).toBeNull();
  });
});

describe("resetTemplateSlashQuery", () => {
  test("clears the typed query but keeps the slash and the trigger active", () => {
    let state = stateWith("/", 1);
    state = openAt(state, 0);
    state = typeChars(state, "clause");
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
    schema.node(
      "paragraph",
      null,
      text === "" ? undefined : [schema.text(text)],
    ),
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
  const props = plugin.props as unknown as {
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

  test('"/" inside an existing directive does not open the menu', () => {
    // `{{#if cond}}` with the caret after "#if " (a whitespace boundary, so the
    // generic guard would open). Opening here would nest markers
    // (`{{#if {{field}}}}`), which the fill grammar cannot parse, so the
    // directive-range guard must reject it.
    const text = "{{#if cond}}";
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(text)]),
    ]);
    const caretAfterIf = text.indexOf("#if ") + "#if ".length; // parent offset
    const slash = templateSlashMenuPlugin();
    const view: FakeView = {
      state: EditorState.create({
        doc,
        plugins: [slash, createTemplateDirectivesPlugin()],
        selection: TextSelection.create(doc, caretAfterIf + 1),
      }),
      dispatch: (tr) => {
        view.state = view.state.apply(tr);
      },
    };
    const handleTextInput = (
      slash.props as {
        handleTextInput: (
          v: FakeView,
          from: number,
          to: number,
          text: string,
        ) => boolean;
      }
    ).handleTextInput;
    const at = view.state.selection.from;
    expect(handleTextInput(view, at, at, "/")).toBe(false);
    expect(getTemplateSlashMenu(view.state).active).toBe(false);
  });

  test("driving chars through handleTextInput extends the live query", () => {
    // The live filter bug: each typed char must grow the active query (which the
    // host reads to filter the visible rows). Drive the chars exactly as the
    // paged editor does — handleTextInput returns false for non-slash chars, PM
    // inserts via its default transaction, and the plugin re-derives the query.
    const { view, props } = makePluginHarness("/", 1);
    view.state = openAt(view.state, 0);
    for (const char of "name") {
      const at = view.state.selection.from;
      expect(props.handleTextInput(view, at, at, char)).toBe(false);
      view.state = view.state.apply(view.state.tr.insertText(char, at));
    }
    const open = getTemplateSlashMenu(view.state);
    expect(open.active).toBe(true);
    expect(open.active && open.query).toBe("name");
  });
});

describe("templateSlashMenu handleKeyDown", () => {
  test('typing "/" via keydown opens the menu (folio paged-editor path)', () => {
    // Folio's hidden view does not route typed chars through handleTextInput,
    // so the `/` that opens the menu must be detected in keydown. This drives
    // the key the way the paged editor's bridged hidden-view key handler does.
    const { view, props } = makePluginHarness("", 0);
    const event = keyEvent("/");
    expect(props.handleKeyDown(view, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe("/");
    expect(getTemplateSlashMenu(view.state).active).toBe(true);
  });

  test('keydown "/" mid-word does not open the menu', () => {
    const { view, props } = makePluginHarness("a", 1);
    const event = keyEvent("/");
    expect(props.handleKeyDown(view, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(getTemplateSlashMenu(view.state).active).toBe(false);
  });

  test('keydown "/" does not double-open when already active', () => {
    const { view, props } = makePluginHarness("/", 1);
    view.state = openAt(view.state, 0);
    const event = keyEvent("/");
    // Already active → the open branch is skipped; "/" is not a nav action, so
    // keyToAction returns null and the key falls through (returns true only for
    // recognized nav keys). Either way the menu stays singular/active.
    props.handleKeyDown(view, event);
    expect(getTemplateSlashMenu(view.state).active).toBe(true);
  });

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
