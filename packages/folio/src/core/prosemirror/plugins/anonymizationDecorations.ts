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

export const anonymizationDecorationsKey =
  new PluginKey<AnonymizationDecorationState>("anonymizationDecorations");

const SET_META = "set";

type AnonymizationDecorationState = {
  terms: readonly AnonymizationTerm[];
  matches: readonly AnonymizationMatch[];
};

export const slugAnonymizationLabel = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

type CompiledTerm = {
  regex: RegExp;
  term: AnonymizationTerm;
};

const buildMatcher = (
  terms: readonly AnonymizationTerm[],
): CompiledTerm[] => {
  const escapeChar = (value: string): string =>
    value.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  // Build the regex for a single surface so each "word" in a
  // multi-word term gets its own trailing-suffix slot. That way
  // a term like "First Last" matches "Firstem Lastou" (Czech /
  // Slovak / German declension on each word independently), not
  // only inflection on the last word.
  const SUFFIX = "[\\p{L}\\p{M}\\p{N}]*";
  const surfaceToPattern = (surface: string): string =>
    surface
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => `${escapeChar(word)}${SUFFIX}`)
      .join("\\s+");

  // One regex per term (canonical + variants combined). Letting
  // every term carry its own pattern keeps the lookup direct —
  // each match comes with its term object — at the cost of a
  // few extra RegExp instances per workspace.
  const compiled: CompiledTerm[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const surfaces = [term.canonical, ...(term.variants ?? [])].filter(
      (surface) => surface.length > 0,
    );
    if (surfaces.length === 0) continue;
    // Sort longest first so the alternation prefers the most
    // specific surface inside its own term.
    surfaces.sort((a, b) => b.length - a.length);
    const key = surfaces.join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const alternation = surfaces.map(surfaceToPattern).join("|");
    compiled.push({
      term,
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${alternation})`,
        "giu",
      ),
    });
  }
  return compiled;
};

const buildMatches = (
  doc: PMNode,
  terms: readonly AnonymizationTerm[],
): AnonymizationMatch[] => {
  const compiled = buildMatcher(terms);
  if (compiled.length === 0) return [];
  const matches: AnonymizationMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return true;
    const text = node.text;
    for (const { regex, term } of compiled) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null = regex.exec(text);
      while (match !== null) {
        const from = pos + match.index;
        const to = from + match[0].length;
        matches.push({
          from,
          to,
          label: term.label,
          canonical: term.canonical,
        });
        if (regex.lastIndex === match.index) {
          regex.lastIndex += 1;
        }
        match = regex.exec(text);
      }
    }
    return true;
  });
  // De-duplicate overlapping matches: shorter spans nested inside
  // longer ones get dropped so a single occurrence of "First Last"
  // does not paint twice (once for the full name, once for the
  // canonical word inside it).
  matches.sort((a, b) =>
    a.from !== b.from ? a.from - b.from : b.to - a.to,
  );
  const result: AnonymizationMatch[] = [];
  let cursor = -1;
  for (const m of matches) {
    if (m.from < cursor) continue;
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
export const createAnonymizationDecorationsPlugin =
  (): Plugin<AnonymizationDecorationState> =>
    new Plugin<AnonymizationDecorationState>({
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
    });

export const setAnonymizationTermsMeta = (
  terms: readonly AnonymizationTerm[],
): {
  key: PluginKey<AnonymizationDecorationState>;
  payload: { type: typeof SET_META; terms: readonly AnonymizationTerm[] };
} => ({
  key: anonymizationDecorationsKey,
  payload: { type: SET_META, terms },
});
