/**
 * Template slash-menu trigger plugin.
 *
 * Watches the template editor for a `/` typed at a marker boundary (start of a
 * text block or right after whitespace) and tracks the query the author types
 * after it. The plugin owns only the *trigger* state — `{active, from, query}` —
 * and the keyboard contract while active; the floating menu UI and the actual
 * marker insertion live in the host (template-studio), which subscribes via
 * {@link TemplateSlashMenuPluginOptions.onChange} and resolves keys via
 * {@link TemplateSlashMenuPluginOptions.onKeyAction}.
 *
 * The trigger guard is deliberately strict so the menu never misfires inside
 * ordinary legal prose: dates (`30/06`), `and/or`, and URLs all have a non-space
 * char before the `/`, so only a leading or post-whitespace `/` opens the menu.
 *
 * Insertion is host-driven: a doc-changing transaction the host dispatches to
 * insert the marker carries a `clear` meta so the plugin tears down without the
 * generic doc-change reset racing the host's selection move.
 */

import type { EditorState, PluginSpec, Transaction } from "prosemirror-state";
import { Plugin, PluginKey } from "prosemirror-state";

export type TemplateSlashMenuState =
  | { active: false; from: null; query: "" }
  | { active: true; from: number; query: string };

const IDLE: TemplateSlashMenuState = { active: false, from: null, query: "" };

/**
 * Keyboard intents the plugin forwards to the host while the menu is open. The
 * host owns the highlighted row and the menu list, so it decides whether each
 * key is consumed; returning `true` lets the plugin `preventDefault` the event.
 */
export type TemplateSlashMenuKeyAction =
  | "up"
  | "down"
  | "forward"
  | "back"
  | "commit"
  | "dismiss";

export type TemplateSlashMenuPluginOptions = {
  /** Fires whenever the trigger state changes (open, query edit, close). */
  onChange?: (state: TemplateSlashMenuState) => void;
  /**
   * Resolve a navigation/commit key while the menu is open. Returns `true` when
   * the host consumed it (so the plugin swallows the event).
   *  - `up`/`down`    move the highlighted row.
   *  - `forward`      ArrowRight: enter a submenu row.
   *  - `back`         ArrowLeft: step out of a submenu.
   *  - `commit`       Enter: the host inserts the marker, then dispatches a
   *                   clearing transaction; the plugin does not mutate the doc.
   *  - `dismiss`      Escape: the host backs out of a submenu and returns `true`
   *                   to keep the menu open, or returns `false` to let the
   *                   plugin tear the trigger down.
   */
  onKeyAction?: (action: TemplateSlashMenuKeyAction) => boolean;
};

type OpenMeta = { type: "open"; from: number; query: string };
type ClearMeta = { type: "clear" };
type Meta = OpenMeta | ClearMeta;

// Letters, digits, and the marker-name connectors. A `/` query keeps matching
// while the author types a field name; a space or any other char ends it. Mirror
// the field-path grammar (`isFieldPath`) so the live query is always a candidate
// new field name.
const QUERY_CHAR = /[\p{L}\p{N}_.-]/u;

const KEY_HOLDER_SYMBOL = Symbol.for("stll.folio.templateSlashMenuKey");
type KeyHolder = {
  [KEY_HOLDER_SYMBOL]?: PluginKey<TemplateSlashMenuState>;
};
const keyHolder = globalThis as unknown as KeyHolder;
export const templateSlashMenuKey: PluginKey<TemplateSlashMenuState> =
  keyHolder[KEY_HOLDER_SYMBOL] ??
  (keyHolder[KEY_HOLDER_SYMBOL] = new PluginKey<TemplateSlashMenuState>(
    "templateSlashMenu",
  ));

/** Whether the char immediately before `pos` is a marker boundary (start of the
 *  text block or whitespace). This is the misfire guard: a `/` mid-token (dates,
 *  URLs, and/or) has a word char before it and never opens the menu. */
const atTriggerBoundary = (state: EditorState, pos: number): boolean => {
  const $pos = state.doc.resolve(pos);
  const offset = $pos.parentOffset;
  if (offset === 0) {
    return true;
  }
  const before = $pos.parent.textBetween(offset - 1, offset, "\n", "\n");
  return before === "" || /\s/u.test(before);
};

/** Re-read the trigger from the live caret: the `/` at `from` plus the run of
 *  query chars up to the caret. Returns null when the trigger no longer holds
 *  (caret moved before the `/`, the `/` was deleted, a non-query char appeared,
 *  or the selection is no longer an empty caret). */
const readTrigger = (
  state: EditorState,
  from: number,
): { from: number; query: string } | null => {
  const sel = state.selection;
  if (!sel.empty) {
    return null;
  }
  const caret = sel.from;
  if (caret <= from) {
    return null;
  }
  const $from = state.doc.resolve(from);
  if ($from.parentOffset === 0) {
    if ($from.parent.textBetween(0, 1, "\n", "\n") !== "/") {
      return null;
    }
  } else {
    const slash = $from.parent.textBetween(
      $from.parentOffset,
      $from.parentOffset + 1,
      "\n",
      "\n",
    );
    if (slash !== "/") {
      return null;
    }
  }
  const $caret = state.doc.resolve(caret);
  if (!$from.sameParent($caret)) {
    return null;
  }
  const query = $from.parent.textBetween(
    $from.parentOffset + 1,
    $caret.parentOffset,
    "\n",
    "\n",
  );
  for (const char of query) {
    if (!QUERY_CHAR.test(char)) {
      return null;
    }
  }
  return { from, query };
};

const sameState = (
  a: TemplateSlashMenuState,
  b: TemplateSlashMenuState,
): boolean => a.active === b.active && a.from === b.from && a.query === b.query;

export const templateSlashMenuPlugin = (
  options: TemplateSlashMenuPluginOptions = {},
): Plugin<TemplateSlashMenuState> => {
  const spec: PluginSpec<TemplateSlashMenuState> = {
    key: templateSlashMenuKey,
    state: {
      init: () => IDLE,
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(templateSlashMenuKey) as Meta | undefined;
        if (meta?.type === "clear") {
          return IDLE;
        }
        if (meta?.type === "open") {
          return { active: true, from: meta.from, query: meta.query };
        }
        if (!value.active) {
          return value;
        }
        // While open, re-derive from the live caret. The mapped anchor keeps the
        // trigger pinned to its `/` across edits before it; a broken trigger
        // (caret moved off, `/` deleted, space typed) closes the menu.
        const mappedFrom = tr.mapping.map(value.from);
        const next = readTrigger(newState, mappedFrom);
        if (next === null) {
          return IDLE;
        }
        return { active: true, from: next.from, query: next.query };
      },
    },
    view: () => ({
      update: (editorView, prevState) => {
        const prev = templateSlashMenuKey.getState(prevState) ?? IDLE;
        const curr = templateSlashMenuKey.getState(editorView.state) ?? IDLE;
        if (!sameState(prev, curr)) {
          options.onChange?.(curr);
        }
      },
    }),
    props: {
      handleTextInput: (view, _from, _to, text) => {
        if (text !== "/") {
          return false;
        }
        const { from } = view.state.selection;
        if (!view.state.selection.empty) {
          return false;
        }
        if (!atTriggerBoundary(view.state, from)) {
          return false;
        }
        // Let PM insert the `/` itself, then open anchored at it on the next
        // tick. Dispatching the open meta on the already-applied insert keeps
        // the anchor and the typed `/` in one undo step.
        const tr = view.state.tr.insertText("/", from);
        tr.setMeta(templateSlashMenuKey, {
          type: "open",
          from,
          query: "",
        } satisfies OpenMeta);
        view.dispatch(tr);
        return true;
      },
      handleKeyDown: (view, event) => {
        const current = templateSlashMenuKey.getState(view.state) ?? IDLE;
        if (!current.active) {
          return false;
        }
        const isMod = event.metaKey || event.ctrlKey || event.altKey;
        if (isMod || event.shiftKey) {
          return false;
        }
        const action = keyToAction(event.key);
        if (action === null) {
          return false;
        }
        const consumed = options.onKeyAction?.(action) ?? false;
        if (consumed) {
          event.preventDefault();
          return true;
        }
        // Escape that the host did not consume (no submenu to back out of)
        // tears the trigger down; other unconsumed keys fall through to the
        // editor so cursor movement and submit still work when no menu logic
        // claims them.
        if (action === "dismiss") {
          view.dispatch(clearTemplateSlashMenu(view.state.tr));
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  };
  return new Plugin(spec);
};

const keyToAction = (key: string): TemplateSlashMenuKeyAction | null => {
  if (key === "ArrowUp") {
    return "up";
  }
  if (key === "ArrowDown") {
    return "down";
  }
  if (key === "ArrowRight") {
    return "forward";
  }
  if (key === "ArrowLeft") {
    return "back";
  }
  if (key === "Enter") {
    return "commit";
  }
  if (key === "Escape") {
    return "dismiss";
  }
  return null;
};

// -- Public read / command API -------------------------------------

export const getTemplateSlashMenu = (
  state: EditorState,
): TemplateSlashMenuState => templateSlashMenuKey.getState(state) ?? IDLE;

/** Clear the trigger. Set on the host's marker-insert transaction so the
 *  insertion and the teardown commit together. */
export const clearTemplateSlashMenu = (tr: Transaction): Transaction =>
  tr.setMeta(templateSlashMenuKey, { type: "clear" } satisfies ClearMeta);

/** Delete just the query chars typed after `/`, keeping the `/` and the trigger
 *  active so a submenu can start its own search from a blank query. No-op (and
 *  returns the unmodified state) when no trigger is active or the query is
 *  already empty. */
export const resetTemplateSlashQuery = (
  state: EditorState,
): Transaction | null => {
  const current = getTemplateSlashMenu(state);
  if (!current.active) {
    return null;
  }
  const queryStart = current.from + 1;
  const caret = state.selection.from;
  if (caret <= queryStart) {
    return null;
  }
  return state.tr.delete(queryStart, caret);
};

/** Delete the `/query` the author typed, returning the PM range it occupied so
 *  the host can insert a marker in its place. Returns null when no trigger is
 *  active. The returned transaction also clears the trigger state. */
export const consumeTemplateSlashQuery = (
  state: EditorState,
): { tr: Transaction; from: number; to: number } | null => {
  const current = getTemplateSlashMenu(state);
  if (!current.active) {
    return null;
  }
  const from = current.from;
  const to = state.selection.from;
  if (to < from) {
    return null;
  }
  const tr = state.tr.delete(from, to);
  clearTemplateSlashMenu(tr);
  return { tr, from, to };
};
