/**
 * Anonymization Decorations Plugin
 *
 * Paints a subtle inline highlight over every text occurrence of a
 * workspace anonymization term so the lawyer can see which strings
 * in the open document are already on the workspace's PII list.
 *
 * Unlike the AI suggestion plugin which gets pre-resolved ranges,
 * this one is fed *terms* (canonical + variants) and scans text
 * nodes itself. The host pushes the term list via the
 * `setAnonymizationTermsMeta` meta whenever the workspace catalog
 * changes; the document itself is never mutated.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export type AnonymizationTerm = {
  /** Canonical surface form, displayed in the title tooltip. */
  canonical: string;
  /** Label slug (e.g. "person", "organization"); used as a CSS modifier. */
  label: string;
  /** Optional alternate surface forms also matched verbatim. */
  variants?: readonly string[];
};

export const anonymizationDecorationsKey =
  new PluginKey<AnonymizationDecorationState>("anonymizationDecorations");

const SET_META = "set";

type AnonymizationDecorationState = {
  terms: readonly AnonymizationTerm[];
  decorationSet: DecorationSet;
};

const slugLabel = (label: string): string =>
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
  if (entries.length === 0) {
    return null;
  }
  // Longest first so a variant that's a substring of another doesn't
  // shadow the longer match.
  entries.sort((a, b) => b.surface.length - a.surface.length);
  const bySurface = new Map<string, AnonymizationTerm>();
  for (const { surface, term } of entries) {
    const key = surface.toLowerCase();
    if (!bySurface.has(key)) {
      bySurface.set(key, term);
    }
  }
  const escape = (value: string): string =>
    value.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const alternation = entries.map(({ surface }) => escape(surface)).join("|");
  // 'gi' so we walk every match and ignore case; lookarounds keep
  // matches at word-character boundaries on ASCII so we don't paint
  // a highlight inside a longer unrelated word.
  return {
    regex: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "giu"),
    bySurface,
  };
};

const buildDecorationSet = (
  doc: PMNode,
  terms: readonly AnonymizationTerm[],
): DecorationSet => {
  const matcher = buildMatcher(terms);
  if (!matcher) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) {
      return true;
    }
    const text = node.text;
    // Fresh exec loop per text node so global-regex state can't
    // leak across nodes.
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null = matcher.regex.exec(text);
    while (match !== null) {
      const surfaceKey = match[0].toLowerCase();
      const term = matcher.bySurface.get(surfaceKey);
      if (term) {
        const from = pos + match.index;
        const to = from + match[0].length;
        decorations.push(
          Decoration.inline(from, to, {
            class: [
              "folio-anonymization-term",
              `folio-anonymization-term--${slugLabel(term.label)}`,
            ].join(" "),
            "data-folio-anonymization-canonical": term.canonical,
            "data-folio-anonymization-label": term.label,
            title: `Anonymized: ${term.canonical}`,
          }),
        );
      }
      if (matcher.regex.lastIndex === match.index) {
        matcher.regex.lastIndex += 1;
      }
      match = matcher.regex.exec(text);
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
};

/**
 * ProseMirror plugin that renders workspace anonymization terms as
 * inline decorations. Always installed; renders nothing until a
 * non-empty term list is pushed in via {@link setAnonymizationTermsMeta}.
 */
export const createAnonymizationDecorationsPlugin =
  (): Plugin<AnonymizationDecorationState> =>
    new Plugin<AnonymizationDecorationState>({
      key: anonymizationDecorationsKey,
      state: {
        init(_, state): AnonymizationDecorationState {
          return {
            terms: [],
            decorationSet: buildDecorationSet(state.doc, []),
          };
        },
        apply(tr, prev, _oldState, newState): AnonymizationDecorationState {
          const setMeta = tr.getMeta(anonymizationDecorationsKey) as
            | { type: typeof SET_META; terms: readonly AnonymizationTerm[] }
            | undefined;

          if (setMeta?.type === SET_META) {
            return {
              terms: setMeta.terms,
              decorationSet: buildDecorationSet(newState.doc, setMeta.terms),
            };
          }

          if (tr.docChanged) {
            // Rebuild from scratch on doc change rather than map: the
            // matcher is regex-based so a typing keystroke that breaks
            // or creates a match needs a re-scan; the cost is
            // proportional to doc size and runs on each keystroke,
            // which is acceptable for a single decoration set on
            // documents this editor already handles.
            return {
              terms: prev.terms,
              decorationSet: buildDecorationSet(newState.doc, prev.terms),
            };
          }
          return prev;
        },
      },
      props: {
        decorations(state) {
          return (
            anonymizationDecorationsKey.getState(state)?.decorationSet ?? null
          );
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
