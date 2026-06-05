/**
 * Autocomplete Suggestion Plugin
 *
 * Headless ProseMirror plugin for inline ghost-text autocomplete.
 * Mirrors the anonymization plugin shape: this module owns the
 * "what" (a single in-flight suggestion anchored at a doc
 * position) and {@link AutocompleteCaretOverlay} owns the paint.
 *
 * Lifecycle:
 *   idle ──setSuggestionStart──▶ streaming ──appendToken*──▶ shown
 *      ◀──clearSuggestion──────────────────────────────────────┘
 *
 * The document is never mutated while the suggestion is shown;
 * the ghost text and "stella" caret are projected onto the page
 * via {@link AutocompleteCaretOverlay} reading this plugin's
 * state and a single inline widget decoration carrying the
 * anchor position.
 *
 * On accept (Tab/⌘→), call {@link acceptAutocompleteSuggestion}
 * to commit the suggestion as a real text insertion in a single
 * transaction. On dismiss (Esc, edit, blur), call
 * {@link clearAutocompleteSuggestion}.
 */

import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, PluginSpec, Transaction } from "prosemirror-state";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export type AutocompleteSuggestionStatus = "idle" | "streaming" | "shown";

export type AutocompleteSuggestionState =
  | { status: "idle"; anchor: null; text: ""; requestId: null }
  | {
      status: "streaming" | "shown";
      anchor: number;
      text: string;
      requestId: string;
    };

const IDLE: AutocompleteSuggestionState = {
  status: "idle",
  anchor: null,
  text: "",
  requestId: null,
};

type StartMeta = { type: "start"; anchor: number; requestId: string };
type TokenMeta = { type: "token"; requestId: string; delta: string };
type FinishMeta = { type: "finish"; requestId: string };
type ConsumeMeta = { type: "consume"; requestId: string; consumed: string };
type ClearMeta = { type: "clear" };
type Meta = StartMeta | TokenMeta | FinishMeta | ConsumeMeta | ClearMeta;

// Pinned PluginKey, same trick as anonymizationDecorations: Vite's
// dev server occasionally evaluates this module twice and a fresh
// `new PluginKey()` per evaluation would mean the overlay can't
// read the plugin's state by key identity. `Symbol.for` lookup
// deduplicates across all module instances.
const KEY_HOLDER_SYMBOL = Symbol.for("stll.folio.autocompleteSuggestionKey");
type KeyHolder = {
  [KEY_HOLDER_SYMBOL]?: PluginKey<AutocompleteSuggestionPluginState>;
};
const keyHolder = globalThis as unknown as KeyHolder;
export const autocompleteSuggestionKey: PluginKey<AutocompleteSuggestionPluginState> =
  keyHolder[KEY_HOLDER_SYMBOL] ??
  (keyHolder[KEY_HOLDER_SYMBOL] =
    new PluginKey<AutocompleteSuggestionPluginState>("autocompleteSuggestion"));

type AutocompleteSuggestionPluginState = {
  suggestion: AutocompleteSuggestionState;
  decorations: DecorationSet;
};

export type AutocompleteSuggestionPluginOptions = {
  /**
   * When `true`, the plugin paints the ghost text and the
   * "stella" caret as a single inline widget decoration. Use
   * this in standard (non-paged) ProseMirror views where PM
   * decorations reach the visible DOM.
   *
   * When `false` (default), the plugin emits an invisible
   * zero-width anchor widget only; the visible ghost text is
   * painted by {@link AutocompleteCaretOverlay} reading the
   * plugin state from outside the editor. This is the path
   * folio's hidden-PM + paged-painter editor uses.
   */
  renderInline?: boolean;
  /**
   * When `true`, the plugin intercepts keys via
   * `props.handleKeyDown`:
   *   - Tab            → accept full suggestion (only if shown)
   *   - Mod-ArrowRight → accept the next word
   *   - Escape         → dismiss
   * Handlers return `false` (i.e. don't consume the event) when
   * no suggestion is active, so existing keymap entries — list
   * indentation on Tab, etc. — continue to work unchanged.
   *
   * The plugin must sit early in the editor's plugin array for
   * its `handleKeyDown` to run before competing keymap plugins.
   */
  keymap?: boolean;
};

const buildAnchorWidget = (): HTMLElement => {
  const el = document.createElement("span");
  el.dataset["folioAutocompleteAnchor"] = "true";
  el.style.cssText = "display:inline-block;width:0;height:0;";
  return el;
};

const buildInlineGhost = (text: string, isStreaming: boolean): HTMLElement => {
  const ghost = document.createElement("span");
  ghost.className = "folio-autocomplete-ghost";
  ghost.append(document.createTextNode(text));
  const caret = document.createElement("span");
  caret.className = isStreaming
    ? "folio-autocomplete-caret folio-autocomplete-caret--streaming"
    : "folio-autocomplete-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.append(document.createTextNode("stella"));
  ghost.append(caret);
  return ghost;
};

const buildDecorations = (
  state: AutocompleteSuggestionState,
  doc: PMNode,
  options: Required<AutocompleteSuggestionPluginOptions>,
): DecorationSet => {
  if (state.status === "idle") {
    return DecorationSet.empty;
  }
  const anchor = Math.max(0, Math.min(state.anchor, doc.content.size));
  const isStreaming = state.status === "streaming";
  // The widget rebuilds on every transaction that touches plugin
  // state, so each streamed token replaces the prior DOM node and
  // PM never tries to diff a stale instance.
  const render = options.renderInline
    ? () => buildInlineGhost(state.text, isStreaming)
    : buildAnchorWidget;
  return DecorationSet.create(doc, [
    Decoration.widget(anchor, render, {
      side: 1,
      ignoreSelection: true,
      key: `stll-autocomplete:${state.text.length}:${state.requestId}`,
    }),
  ]);
};

const reduce = (
  prev: AutocompleteSuggestionState,
  meta: Meta,
): AutocompleteSuggestionState => {
  if (meta.type === "clear") {
    return IDLE;
  }
  if (meta.type === "start") {
    return {
      status: "streaming",
      anchor: meta.anchor,
      text: "",
      requestId: meta.requestId,
    };
  }
  if (meta.type === "token") {
    if (prev.status === "idle" || prev.requestId !== meta.requestId) {
      return prev;
    }
    return { ...prev, status: "streaming", text: prev.text + meta.delta };
  }
  if (meta.type === "consume") {
    if (prev.status === "idle" || prev.requestId !== meta.requestId) {
      return prev;
    }
    if (meta.consumed.length >= prev.text.length) {
      return IDLE;
    }
    return {
      ...prev,
      anchor: prev.anchor + meta.consumed.length,
      text: prev.text.slice(meta.consumed.length),
    };
  }
  // finish
  if (prev.status === "idle" || prev.requestId !== meta.requestId) {
    return prev;
  }
  if (prev.text.length === 0) {
    return IDLE;
  }
  return { ...prev, status: "shown" };
};

export const autocompleteSuggestionPlugin = (
  options: AutocompleteSuggestionPluginOptions = {},
): Plugin<AutocompleteSuggestionPluginState> => {
  const resolved: Required<AutocompleteSuggestionPluginOptions> = {
    renderInline: options.renderInline ?? false,
    keymap: options.keymap ?? false,
  };
  const spec: PluginSpec<AutocompleteSuggestionPluginState> = {
    key: autocompleteSuggestionKey,
    state: {
      init: (_config, instance) => ({
        suggestion: IDLE,
        decorations: buildDecorations(IDLE, instance.doc, resolved),
      }),
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(autocompleteSuggestionKey) as Meta | undefined;
        if (!meta) {
          // Any doc-changing transaction dismisses an in-flight or
          // shown suggestion — the anchor would no longer match the
          // text the model just completed and stale ghost text is
          // worse than no ghost text. Selection moves alone do not
          // invalidate.
          if (tr.docChanged && value.suggestion.status !== "idle") {
            return {
              suggestion: IDLE,
              decorations: DecorationSet.empty,
            };
          }
          return value;
        }
        const nextSuggestion = reduce(value.suggestion, meta);
        return {
          suggestion: nextSuggestion,
          decorations: buildDecorations(nextSuggestion, newState.doc, resolved),
        };
      },
    },
    props: {
      decorations(state) {
        return autocompleteSuggestionKey.getState(state)?.decorations ?? null;
      },
      ...(resolved.keymap
        ? {
            handleKeyDown: (view, event) => {
              const current =
                autocompleteSuggestionKey.getState(view.state)?.suggestion ??
                IDLE;
              if (
                current.status !== "shown" &&
                current.status !== "streaming"
              ) {
                return false;
              }
              const isMod = event.metaKey || event.ctrlKey;
              if (event.key === "Tab" && !event.shiftKey && !isMod) {
                const result = acceptAutocompleteSuggestion(
                  view.state,
                  view.dispatch,
                );
                if (result.accepted) {
                  event.preventDefault();
                  return true;
                }
                return false;
              }
              if (event.key === "ArrowRight" && isMod && !event.shiftKey) {
                const result = acceptAutocompleteWord(
                  view.state,
                  view.dispatch,
                );
                if (result.accepted) {
                  event.preventDefault();
                  return true;
                }
                return false;
              }
              if (event.key === "Escape" && !isMod && !event.shiftKey) {
                view.dispatch(clearAutocompleteSuggestion(view.state.tr));
                event.preventDefault();
                return true;
              }
              return false;
            },
          }
        : {}),
    },
  };
  return new Plugin(spec);
};

// -- Public read API ------------------------------------------------

export const getAutocompleteSuggestion = (
  state: EditorState,
): AutocompleteSuggestionState =>
  autocompleteSuggestionKey.getState(state)?.suggestion ?? IDLE;

// -- Public meta helpers -------------------------------------------

export const startAutocompleteSuggestion = (
  tr: Transaction,
  anchor: number,
  requestId: string,
): Transaction =>
  tr.setMeta(autocompleteSuggestionKey, {
    type: "start",
    anchor,
    requestId,
  } satisfies StartMeta);

export const appendAutocompleteToken = (
  tr: Transaction,
  requestId: string,
  delta: string,
): Transaction =>
  tr.setMeta(autocompleteSuggestionKey, {
    type: "token",
    requestId,
    delta,
  } satisfies TokenMeta);

export const finishAutocompleteSuggestion = (
  tr: Transaction,
  requestId: string,
): Transaction =>
  tr.setMeta(autocompleteSuggestionKey, {
    type: "finish",
    requestId,
  } satisfies FinishMeta);

export const clearAutocompleteSuggestion = (tr: Transaction): Transaction =>
  tr.setMeta(autocompleteSuggestionKey, { type: "clear" } satisfies ClearMeta);

// -- Accept command ------------------------------------------------

export type AcceptAutocompleteResult =
  | { accepted: false }
  | { accepted: true; from: number; to: number; text: string };

/**
 * Commit the current suggestion as a real text insertion at its
 * anchor. Returns metadata so the caller can record the accept
 * event (for telemetry / future training feedback) without
 * re-reading plugin state after the dispatch.
 *
 * Single transaction: insert text + clear suggestion state, so
 * undo restores both the doc and the (now-gone) ghost atomically.
 */
export const acceptAutocompleteSuggestion = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): AcceptAutocompleteResult => {
  const current = getAutocompleteSuggestion(state);
  if (current.status !== "shown" && current.status !== "streaming") {
    return { accepted: false };
  }
  if (current.text.length === 0) {
    return { accepted: false };
  }
  if (dispatch) {
    const tr = state.tr.insertText(current.text, current.anchor);
    clearAutocompleteSuggestion(tr);
    dispatch(tr);
  }
  return {
    accepted: true,
    from: current.anchor,
    to: current.anchor + current.text.length,
    text: current.text,
  };
};

/**
 * Consume the next "word" from the suggestion: insert it at the
 * anchor in a single transaction and shrink the remaining ghost
 * text. Lets the user "graze" through a long suggestion one word
 * at a time with ⌘→ / Ctrl→ instead of accept-all-or-discard.
 *
 * A word here is "leading whitespace + the next non-whitespace
 * run + an optional trailing space" — so successive calls eat the
 * suggestion cleanly without leaving stray spaces. When the
 * remaining suggestion is shorter than one word, this falls
 * through to {@link acceptAutocompleteSuggestion}.
 */
export const acceptAutocompleteWord = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): AcceptAutocompleteResult => {
  const current = getAutocompleteSuggestion(state);
  if (current.status !== "shown" && current.status !== "streaming") {
    return { accepted: false };
  }
  if (current.text.length === 0) {
    return { accepted: false };
  }
  const match = /^(\s*\S+\s?)/u.exec(current.text);
  const word = match === null ? current.text : match[1];
  if (word === undefined || word.length === 0) {
    return { accepted: false };
  }
  if (word.length >= current.text.length) {
    return acceptAutocompleteSuggestion(state, dispatch);
  }
  if (dispatch) {
    const tr = state.tr.insertText(word, current.anchor);
    tr.setMeta(autocompleteSuggestionKey, {
      type: "consume",
      requestId: current.requestId,
      consumed: word,
    } satisfies ConsumeMeta);
    dispatch(tr);
  }
  return {
    accepted: true,
    from: current.anchor,
    to: current.anchor + word.length,
    text: word,
  };
};

// -- Trigger gating ------------------------------------------------

export type AutocompleteTriggerSkipReason =
  | "selection-non-empty"
  | "midword"
  | "deadzone"
  | "empty-doc";

export type AutocompleteTriggerCheck =
  | { ok: true }
  | { ok: false; reason: AutocompleteTriggerSkipReason; detail?: string };

/**
 * Node type names that should suppress autocomplete entirely. The
 * defaults cover prose-adjacent zones across ProseMirror schemas
 * we encounter in folio + bare playgrounds. Pass a custom list via
 * options to extend (citations, math, frontmatter, etc.).
 */
export const DEFAULT_AUTOCOMPLETE_DEAD_ZONE_NODES: readonly string[] = [
  "heading",
  "title",
  "code",
  "code_block",
  "codeBlock",
  "horizontal_rule",
  "horizontalRule",
  "math_block",
  "math_inline",
  "inline_math",
  "inlineMath",
  "equation",
  "citation",
  "citationPreview",
  "pendingCitation",
  "image",
  "imageBlock",
];

// Letters, numbers, and a small set of in-word connectors. The
// regex uses Unicode property escapes so accented Czech/German/
// Polish letters count as word chars and don't trip the gate.
const WORD_CONTINUATION_CHAR = /[\p{L}\p{N}_'-]/u;

export type AutocompleteTriggerOptions = {
  /** Additional node type names to treat as dead zones. */
  extraDeadZoneNodes?: readonly string[];
};

/**
 * Decide whether autocomplete should fire at the current cursor.
 * Designed to be called from a debounced trigger in the host app
 * before sending a request to the model. Returns a structured
 * skip reason rather than a bare boolean so callers (and debug
 * UIs) can explain why no suggestion appeared.
 *
 * Gates applied:
 *  - selection must be a collapsed caret (no range selection)
 *  - the cursor must not be inside a dead-zone node (heading,
 *    code, citation, math, etc.) anywhere in the ancestor chain
 *  - the character immediately before the cursor must not be a
 *    word-continuation char — if it is, the model would be
 *    completing a partial token and almost always misreads intent
 */
export const shouldTriggerAutocomplete = (
  state: EditorState,
  options?: AutocompleteTriggerOptions,
): AutocompleteTriggerCheck => {
  const sel = state.selection;
  if (!sel.empty) {
    return { ok: false, reason: "selection-non-empty" };
  }
  if (state.doc.content.size === 0) {
    return { ok: false, reason: "empty-doc" };
  }
  const $cursor = sel.$from;
  const deadZones = new Set([
    ...DEFAULT_AUTOCOMPLETE_DEAD_ZONE_NODES,
    ...(options?.extraDeadZoneNodes ?? []),
  ]);
  for (let depth = $cursor.depth; depth >= 0; depth--) {
    const nodeName = $cursor.node(depth).type.name;
    if (deadZones.has(nodeName)) {
      return { ok: false, reason: "deadzone", detail: nodeName };
    }
  }
  const parentOffset = $cursor.parentOffset;
  if (parentOffset > 0) {
    const before = $cursor.parent.textBetween(
      parentOffset - 1,
      parentOffset,
      "\n",
      "\n",
    );
    if (before.length > 0 && WORD_CONTINUATION_CHAR.test(before)) {
      return { ok: false, reason: "midword", detail: before };
    }
  }
  return { ok: true };
};
