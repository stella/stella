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

import { getTemplateDirectives } from "./templateDirectives";

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

/** Whether `pos` falls strictly inside an existing template directive. The
 *  slash activations insert markers as raw text rather than going through
 *  `insertInline`'s overlap guard, so opening here would nest markers — e.g. a
 *  `/` typed after `#if ` inside `{{#if condition}}` could produce
 *  `{{#if {{field}}}}`, which the scanner/fill grammar cannot interpret.
 *  Boundaries are exclusive: a caret right before `{{` or after `}}` is fine. */
const insideDirective = (state: EditorState, pos: number): boolean =>
  getTemplateDirectives(state).some(
    (range) => pos > range.from && pos < range.to,
  );

/** Whether the `/` that opened the trigger is still present at `from`. */
const slashStillAt = (state: EditorState, from: number): boolean => {
  if (from < 0 || from > state.doc.content.size) {
    return false;
  }
  const $from = state.doc.resolve(from);
  if ($from.parentOffset >= $from.parent.content.size) {
    return false;
  }
  return (
    $from.parent.textBetween(
      $from.parentOffset,
      $from.parentOffset + 1,
      "\n",
      "\n",
    ) === "/"
  );
};

/**
 * The query is the contiguous run of query-grammar chars right after the `/`,
 * read from the DOCUMENT (not the caret). Anchoring the query to the text — not
 * the selection — keeps it stable across the paged editor's relayout selection
 * churn, which would otherwise momentarily report a caret outside the trigger
 * and tear the menu down mid-type. A non-query char (space, etc.) ends the run.
 */
const readQueryRun = (state: EditorState, from: number): string => {
  const $from = state.doc.resolve(from);
  const rest = $from.parent.textBetween(
    $from.parentOffset + 1,
    $from.parent.content.size,
    "\n",
    "\n",
  );
  let query = "";
  for (const char of rest) {
    if (!QUERY_CHAR.test(char)) {
      break;
    }
    query += char;
  }
  return query;
};

/** Whether the caret sits within the trigger span `[from, from + 1 + query]`,
 *  i.e. the user is still editing the trigger rather than having clicked away. */
const caretInTrigger = (
  state: EditorState,
  from: number,
  queryLength: number,
): boolean => {
  const sel = state.selection;
  return sel.empty && sel.from >= from && sel.from <= from + 1 + queryLength;
};

/** Whether a non-query char sits right after the `/query` run — the user typed
 *  something that breaks out of the command (a space, but also punctuation like
 *  `,` or `;`). `readQueryRun` already stops at the first non-query char, so any
 *  non-empty char at this offset is a terminator: dismiss rather than keep
 *  capturing arrows/Enter while the caret is back in ordinary prose. */
const queryEnded = (
  state: EditorState,
  from: number,
  queryLength: number,
): boolean => {
  const $from = state.doc.resolve(from);
  const offset = $from.parentOffset + 1 + queryLength;
  if (offset >= $from.parent.content.size) {
    return false;
  }
  const char = $from.parent.textBetween(offset, offset + 1, "\n", "\n");
  return char !== "" && !QUERY_CHAR.test(char);
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
        // Keep the trigger pinned to its `/` across edits before it.
        const from = tr.mapping.map(value.from);
        // The `/` itself being deleted always closes the menu.
        if (!slashStillAt(newState, from)) {
          return IDLE;
        }
        // The query is derived from the document text after the `/`, so it stays
        // correct through the paged editor's relayout selection churn (which can
        // momentarily move the caret). Only a genuine caret move OUT of the
        // trigger on a selection-only transaction closes the menu — typing
        // (doc-changing) never closes on caret grounds, since the caret rides at
        // the end of the query.
        const query = readQueryRun(newState, from);
        // Any non-query char right after the `/query` ends the command — a
        // space, but also punctuation such as `,` — so the menu does not keep
        // capturing keys once the caret is back in ordinary prose.
        if (queryEnded(newState, from, query.length)) {
          return IDLE;
        }
        // Only a genuine caret move OUT of the trigger on a selection-only
        // transaction closes the menu — typing (doc-changing) never closes on
        // caret grounds, since the caret rides at the end of the query.
        if (
          !tr.docChanged &&
          tr.selectionSet &&
          !caretInTrigger(newState, from, query.length)
        ) {
          return IDLE;
        }
        return { active: true, from, query };
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
        if (insideDirective(view.state, from)) {
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
        const handledByHost = options.onKeyAction?.(action) ?? false;
        // Escape is the only key that can fall through to dismiss: when the host
        // does not consume it (already at the root level), tear the trigger
        // down. Every other navigation key is swallowed while the menu is open
        // so the document caret never moves out from under it, even when the
        // host treats the key as a no-op (e.g. ArrowRight on a non-submenu row).
        if (action === "dismiss" && !handledByHost) {
          view.dispatch(clearTemplateSlashMenu(view.state.tr));
        }
        event.preventDefault();
        return true;
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
  // Consume the whole `/query` span — `/` plus every query char — not just up
  // to the caret. The caret may sit inside the query (the user clicked after
  // `/cli` in `/client`); deleting to the caret would strip `/cli` and orphan
  // the `ent` suffix in the document.
  const to = from + 1 + current.query.length;
  const tr = state.tr.delete(from, to);
  clearTemplateSlashMenu(tr);
  return { tr, from, to };
};
