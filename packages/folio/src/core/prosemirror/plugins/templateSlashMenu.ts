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
  | { active: false; from: null; to: null; query: "" }
  | { active: true; from: number; to: number; query: string };

const IDLE: TemplateSlashMenuState = {
  active: false,
  from: null,
  to: null,
  query: "",
};

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
 * The query the author has typed, read from the tracked trigger RANGE
 * `[from, to]` rather than the caret. `to` is carried through every transaction
 * by position mapping (it grows as the author types at the query end), so the
 * query is immune to the paged editor's relayout selection churn — the caret can
 * momentarily land anywhere without affecting it. Because the range only ever
 * grows with typed input, it never swallows prose that already followed the `/`.
 *
 * Returns the query string, or `null` when the span contains a terminator (a
 * typed space or punctuation) — the command is over.
 */
const readRangeQuery = (
  state: EditorState,
  from: number,
  to: number,
): string | null => {
  const start = from + 1;
  if (to <= start) {
    return "";
  }
  const text = state.doc.textBetween(start, to, "\n", "\n");
  for (const char of text) {
    if (!QUERY_CHAR.test(char)) {
      return null;
    }
  }
  return text;
};

const sameState = (
  a: TemplateSlashMenuState,
  b: TemplateSlashMenuState,
): boolean => a.active === b.active && a.from === b.from && a.query === b.query;

/**
 * Open the trigger at the collapsed caret if the guards pass: insert the `/`
 * and dispatch the open meta in one transaction (so the slash and the anchor
 * share one undo step), and return `true`. Shared by the keydown opener (the
 * path that fires in folio's paged hidden-view input pipeline) and the
 * `handleTextInput` opener (plain ProseMirror views / playground). Both guard
 * on the menu not already being active, so they never double-open or double
 * insert the `/`.
 */
const tryOpenTrigger = (view: SlashEditorView): boolean => {
  if (getTemplateSlashMenu(view.state).active) {
    return false;
  }
  const { from } = view.state.selection;
  if (
    !view.state.selection.empty ||
    !atTriggerBoundary(view.state, from) ||
    insideDirective(view.state, from)
  ) {
    return false;
  }
  const tr = view.state.tr.insertText("/", from);
  tr.setMeta(templateSlashMenuKey, {
    type: "open",
    from,
    query: "",
  } satisfies OpenMeta);
  view.dispatch(tr);
  return true;
};

/** The slice of EditorView the open helper needs (state + dispatch), so it can
 *  be unit-tested with a fake view. */
type SlashEditorView = {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
};

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
          // The query span starts empty: `to` sits just after the `/` and grows
          // as the author types (carried by the position mapping below).
          return {
            active: true,
            from: meta.from,
            to: meta.from + 1,
            query: meta.query,
          };
        }
        if (!value.active) {
          return value;
        }
        // Carry the trigger range through the transaction by POSITION MAPPING,
        // not the live caret: `from` stays at the `/` (assoc -1) and `to` grows
        // with inserts at the query end (assoc +1). The caret is never the source
        // of truth for the query span (the standard suggestion-plugin model), so
        // the query stays correct regardless of where the selection sits.
        // ProseMirror `Mapping.map(pos, assoc)`: the second arg is the map bias
        // (which side of an insertion the position sticks to), not an Array
        // `thisArg` — the unicorn rule mis-detects the shape.
        // eslint-disable-next-line unicorn/no-array-method-this-argument -- PM Mapping.map bias arg, not Array thisArg
        const from = tr.mapping.map(value.from, -1);
        // eslint-disable-next-line unicorn/no-array-method-this-argument -- PM Mapping.map bias arg, not Array thisArg
        const to = tr.mapping.map(value.to, 1);
        // The `/` itself being deleted closes the menu.
        if (!slashStillAt(newState, from)) {
          return IDLE;
        }
        // Close on a deliberate range selection only. A collapsed caret move
        // never closes the menu: closing is gated on explicit signals (`/`
        // deleted, terminator typed, range select), not the caret position.
        // Click-away dismissal is the host popover's responsibility.
        if (tr.selectionSet && !newState.selection.empty) {
          return IDLE;
        }
        // A terminator (space/punctuation) typed inside the range ends it.
        const query = readRangeQuery(newState, from, to);
        if (query === null) {
          return IDLE;
        }
        return { active: true, from, to, query };
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
      // Fallback opener for plain ProseMirror views (playground) where native
      // text input flows through `handleTextInput`. In folio's paged editor the
      // hidden view does NOT route typed chars here, so the keydown opener below
      // is what actually fires; both share `tryOpenTrigger` and guard on
      // not-already-active so they never double-insert the `/`.
      handleTextInput: (view, _from, _to, text) => {
        if (text !== "/") {
          return false;
        }
        return tryOpenTrigger(view);
      },
      handleKeyDown: (view, event) => {
        const current = templateSlashMenuKey.getState(view.state) ?? IDLE;
        // OPEN PATH (folio paged editor). Typed chars are not routed through
        // `props.handleTextInput` in the hidden-view pipeline, but keydown IS
        // bridged to the plugin chain (see PagedEditor's hidden-view key
        // handler). `event.key` is the resolved char, so this is layout-safe
        // (e.g. Shift+7 → "/"); only command modifiers block it. `tryOpenTrigger`
        // inserts the `/` and opens, and we consume the event so the native
        // insert cannot also add a second `/`.
        if (
          !current.active &&
          event.key === "/" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          if (tryOpenTrigger(view)) {
            event.preventDefault();
            return true;
          }
          return false;
        }
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
  const queryEnd = current.to;
  if (queryEnd <= queryStart) {
    return null;
  }
  return state.tr.delete(queryStart, queryEnd);
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
  // The tracked range end IS the end of the `/query` span (mapped through every
  // edit), so deleting [from, to] removes the `/` and the whole typed query even
  // when the caret sits inside it (e.g. clicking after `/cli` in `/client`).
  const to = current.to;
  const tr = state.tr.delete(from, to);
  clearTemplateSlashMenu(tr);
  return { tr, from, to };
};
