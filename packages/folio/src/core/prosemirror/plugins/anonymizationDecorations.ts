/**
 * Anonymization Match Plugin
 *
 * Owns the "what to highlight" half of the anonymization
 * overlay: the host pushes a list of terms via the
 * `setAnonymizationTermsMeta` meta, this plugin scans text
 * nodes for each surface form, and exposes the resulting
 * match ranges through its state.
 *
 * The plugin does **not** produce ProseMirror decorations.
 * Folio's editor lives off-screen (HiddenProseMirror) and PM
 * decorations never reach the visible paged DOM. The visible
 * highlights are painted by {@link AnonymizationRectsOverlay},
 * which reads the match ranges from this plugin's state and
 * projects them through `selectionToRects` to coordinates on
 * the paged canvas. Single source of truth for the ranges,
 * one painter.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, PluginSpec } from "prosemirror-state";

export type AnonymizationTerm = {
  /** Canonical surface form, displayed in tooltips. */
  canonical: string;
  /** Label slug (e.g. "person", "organization"). */
  label: string;
  /** Optional alternate surface forms also matched verbatim. */
  variants?: readonly string[];
};

export type AnonymizationMatch = {
  /** Inclusive PM doc position of the match start. */
  from: number;
  /** Exclusive PM doc position of the match end. */
  to: number;
  label: string;
  canonical: string;
};

const SET_META = "set";

type AnonymizationDecorationState = {
  terms: readonly AnonymizationTerm[];
  matches: readonly AnonymizationMatch[];
};

// Pin the PluginKey to a process-wide symbol on `globalThis` so
// every module evaluation resolves to the *same* key instance.
// Vite's dev server occasionally serves this file twice — once
// to the bundle that registers the plugin (Folio's relative
// import path) and once to an external consumer (`@stll/folio`
// re-export). A fresh `new PluginKey()` per evaluation would mean
// the host can't read the plugin's state by key identity, even
// though both copies of the file look identical. The `Symbol.for`
// lookup deduplicates across all module instances; the key string
// "anonymizationDecorations" is metadata for the PM debug name.
const KEY_HOLDER_SYMBOL = Symbol.for("stll.folio.anonymizationDecorationsKey");
type KeyHolder = {
  [KEY_HOLDER_SYMBOL]?: PluginKey<AnonymizationDecorationState>;
};
const keyHolder = globalThis as unknown as KeyHolder;
export const anonymizationDecorationsKey: PluginKey<AnonymizationDecorationState> =
  keyHolder[KEY_HOLDER_SYMBOL] ??
  (keyHolder[KEY_HOLDER_SYMBOL] = new PluginKey<AnonymizationDecorationState>(
    "anonymizationDecorations",
  ));

export const slugAnonymizationLabel = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/gu, "-");

type CompiledTerm = {
  regex: RegExp;
  term: AnonymizationTerm;
};

const buildMatcher = (terms: readonly AnonymizationTerm[]): CompiledTerm[] => {
  const escapeChar = (value: string): string =>
    value
      .replaceAll(/[\\^$.*+?()[\]{}|]/gu, "\\$&")
      // A typed whitespace run matches the non-breaking, narrow
      // no-break and figure spaces typography commonly inserts —
      // purely a normalisation concern, not language logic.
      .replaceAll(/\s+/gu, "\\s+");

  // One regex per term (canonical + variants). The plugin only
  // does literal, word-bounded matching; morphology and other
  // form expansion belong upstream in the anonymisation package
  // (variants on the gazetteer entry).
  const compiled: CompiledTerm[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const surfaces = [term.canonical, ...(term.variants ?? [])].filter(
      (surface) => surface.length > 0,
    );
    if (surfaces.length === 0) {
      continue;
    }
    surfaces.sort((a, b) => b.length - a.length);
    const key = surfaces.join("|").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const alternation = surfaces.map(escapeChar).join("|");
    compiled.push({
      term,
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`,
        "giu",
      ),
    });
  }
  return compiled;
};

type TextChunk = {
  text: string;
  /** PM doc position where this chunk's first char lives. */
  start: number;
};

/**
 * Collect every block-level node's text content as a single joined
 * string plus a mapping from joined-string offsets back to PM doc
 * positions. We need this because PM splits text across nodes at
 * every formatting boundary (e.g. a bold-only prefix produces a
 * separate text node), and a regex run per text node misses any
 * surface form that straddles that boundary.
 */
const collectBlockChunks = (doc: PMNode): TextChunk[][] => {
  const blocks: TextChunk[][] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const chunks: TextChunk[] = [];
      node.descendants((child, offset) => {
        if (child.isText && child.text !== undefined) {
          // pos is the textblock's PM position; +1 accounts for the
          // textblock's opening token, +offset is the position of
          // this text node inside the textblock.
          chunks.push({ text: child.text, start: pos + 1 + offset });
        }
        return true;
      });
      if (chunks.length > 0) {
        blocks.push(chunks);
      }
      return false;
    }
    return true;
  });
  return blocks;
};

/** Map a joined-string offset back to its PM doc position. */
const offsetToDocPos = (chunks: TextChunk[], offset: number): number => {
  let consumed = 0;
  for (const chunk of chunks) {
    if (offset <= consumed + chunk.text.length) {
      return chunk.start + (offset - consumed);
    }
    consumed += chunk.text.length;
  }
  // Past the end: clamp to the final chunk's last position.
  const last = chunks.at(-1);
  return last ? last.start + last.text.length : 0;
};

const buildMatches = (
  doc: PMNode,
  terms: readonly AnonymizationTerm[],
): AnonymizationMatch[] => {
  const compiled = buildMatcher(terms);
  if (compiled.length === 0) {
    return [];
  }
  const matches: AnonymizationMatch[] = [];
  for (const chunks of collectBlockChunks(doc)) {
    const joined = chunks.map((c) => c.text).join("");
    for (const { regex, term } of compiled) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null = regex.exec(joined);
      while (match !== null) {
        const from = offsetToDocPos(chunks, match.index);
        const to = offsetToDocPos(chunks, match.index + match[0].length);
        matches.push({
          from,
          to,
          label: term.label,
          canonical: term.canonical,
        });
        if (regex.lastIndex === match.index) {
          regex.lastIndex += 1;
        }
        match = regex.exec(joined);
      }
    }
  }
  // De-duplicate overlapping matches: shorter spans nested inside
  // longer ones get dropped so a single occurrence of "First Last"
  // does not paint twice (once for the full name, once for the
  // canonical word inside it).
  matches.sort((a, b) => (a.from !== b.from ? a.from - b.from : b.to - a.to));
  const result: AnonymizationMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.from < cursor) {
      continue;
    }
    result.push(m);
    cursor = m.to;
  }
  return result;
};

/**
 * Plugin that keeps a list of anonymization-term match ranges
 * synced with the document. Host pushes terms via
 * {@link setAnonymizationTermsMeta}; the paged-editor reads
 * the matches and paints the overlay.
 */
export type AnonymizationPluginOptions = {
  /**
   * Push-side bridge for hosts that need to mirror the current
   * match list outside the PM state tree (e.g. an inspector
   * facet showing a "N highlighted" counter, or per-doc analytics).
   * Called on plugin init, after every transaction that changes
   * the match set, and on plugin teardown (with an empty list).
   * The same list is reachable via `getAnonymizationMatches`;
   * use the callback when you need updates without polling.
   */
  onMatchesChange?: (matches: readonly AnonymizationMatch[]) => void;
};

export const createAnonymizationDecorationsPlugin = ({
  onMatchesChange,
}: AnonymizationPluginOptions = {}): Plugin<AnonymizationDecorationState> => {
  const spec: PluginSpec<AnonymizationDecorationState> = {
    key: anonymizationDecorationsKey,
    state: {
      init(): AnonymizationDecorationState {
        return { terms: [], matches: [] };
      },
      apply(tr, prev, _oldState, newState): AnonymizationDecorationState {
        const setMeta = tr.getMeta(anonymizationDecorationsKey) as
          | { type: typeof SET_META; terms: readonly AnonymizationTerm[] }
          | undefined;

        if (setMeta?.type === SET_META) {
          return {
            terms: setMeta.terms,
            matches: buildMatches(newState.doc, setMeta.terms),
          };
        }

        if (tr.docChanged) {
          // Doc edits move text around; rebuild ranges from scratch
          // rather than try to map regex matches through a mapping.
          return {
            terms: prev.terms,
            matches: buildMatches(newState.doc, prev.terms),
          };
        }
        return prev;
      },
    },
  };
  if (onMatchesChange) {
    spec.view = (view) => {
      // Emit the initial match list (init() ran above with the
      // empty doc-and-terms baseline; for restored sessions
      // matches may already be populated).
      let last = anonymizationDecorationsKey.getState(view.state)?.matches;
      if (last) {
        onMatchesChange(last);
      }
      return {
        update(updatedView) {
          const next = anonymizationDecorationsKey.getState(
            updatedView.state,
          )?.matches;
          if (next && next !== last) {
            last = next;
            onMatchesChange(next);
          }
        },
        destroy() {
          onMatchesChange([]);
        },
      };
    };
  }
  return new Plugin<AnonymizationDecorationState>(spec);
};

export const setAnonymizationTermsMeta = (
  terms: readonly AnonymizationTerm[],
): {
  key: PluginKey<AnonymizationDecorationState>;
  payload: { type: typeof SET_META; terms: readonly AnonymizationTerm[] };
} => ({
  key: anonymizationDecorationsKey,
  payload: { type: SET_META, terms },
});

/**
 * Read the plugin's current match list out of a Folio editor
 * view. Lives inside the same module as the plugin key so a host
 * that imports it via `@stll/folio` gets the *same* key instance
 * as the plugin registration — bypassing the dev-HMR hazard
 * where re-evaluating the plugin module would create a second
 * PluginKey and break key-based lookups.
 */
export const getAnonymizationMatches = (
  state: EditorState,
): readonly AnonymizationMatch[] =>
  anonymizationDecorationsKey.getState(state)?.matches ?? [];
