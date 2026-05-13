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

const buildMatcher = (
  terms: readonly AnonymizationTerm[],
): { regex: RegExp; bySurface: Map<string, AnonymizationTerm> } | null => {
  const entries: Array<{ surface: string; term: AnonymizationTerm }> = [];
  for (const term of terms) {
    if (term.canonical.length > 0) {
      entries.push({ surface: term.canonical, term });
    }
    for (const variant of term.variants ?? []) {
      if (variant.length > 0) {
        entries.push({ surface: variant, term });
      }
    }
  }
  if (entries.length === 0) return null;
  // Longest first so a shorter variant nested inside a canonical
  // doesn't shadow the longer match.
  entries.sort((a, b) => b.surface.length - a.surface.length);
  const normalizeKey = (value: string): string =>
    value.replaceAll(/\s+/g, " ").toLowerCase();
  const bySurface = new Map<string, AnonymizationTerm>();
  for (const { surface, term } of entries) {
    const key = normalizeKey(surface);
    if (!bySurface.has(key)) {
      bySurface.set(key, term);
    }
  }
  const escape = (value: string): string =>
    value
      .replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&")
      // Treat any whitespace run as `\s+` so a term typed with
      // regular spaces still matches the non-breaking spaces and
      // typographic spaces real DOCX content often uses between
      // titles, names, and units.
      .replaceAll(/\s+/g, "\\s+");
  const alternation = entries.map(({ surface }) => escape(surface)).join("|");
  // Leading word boundary stays strict so a term doesn't match
  // inside an unrelated longer word. Trailing boundary is open:
  // we consume any word-character suffix so a single nominative
  // entry matches the declined forms that show up in Czech /
  // Slovak / German texts without the user having to enter each
  // case explicitly. Capture group 1 carries the surface for
  // the lookup; the full match is what gets highlighted.
  return {
    regex: new RegExp(
      `(?<![\\p{L}\\p{N}])(${alternation})[\\p{L}\\p{M}\\p{N}]*`,
      "giu",
    ),
    bySurface,
  };
};

const buildMatches = (
  doc: PMNode,
  terms: readonly AnonymizationTerm[],
): AnonymizationMatch[] => {
  const matcher = buildMatcher(terms);
  if (!matcher) return [];
  const matches: AnonymizationMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return true;
    const text = node.text;
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null = matcher.regex.exec(text);
    while (match !== null) {
      // Capture group 1 is the surface (one of the alternation
      // entries); match[0] is that surface plus an optional
      // declensional suffix the matcher swept up.
      const surface = match[1] ?? "";
      const surfaceKey = surface.replaceAll(/\s+/g, " ").toLowerCase();
      const term = matcher.bySurface.get(surfaceKey);
      if (term) {
        const from = pos + match.index;
        const to = from + match[0].length;
        matches.push({
          from,
          to,
          label: term.label,
          canonical: term.canonical,
        });
      }
      if (matcher.regex.lastIndex === match.index) {
        matcher.regex.lastIndex += 1;
      }
      match = matcher.regex.exec(text);
    }
    return true;
  });
  return matches;
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
