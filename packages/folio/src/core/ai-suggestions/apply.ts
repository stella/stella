/**
 * Apply AI suggestions to the document.
 *
 * Two modes:
 *  - "direct": replace text in place.
 *  - "tracked-changes": insertion + deletion marks, attributed to the
 *    configured author. Reuses the editor's existing tracked-change
 *    schema and resolution commands.
 *
 * Apply is always preceded by anchor resolution; stale suggestions are
 * skipped and reported back to the caller.
 */

import type { EditorView } from "prosemirror-view";

import { resolveSuggestionAnchor } from "./conflict";
import type { AISuggestion, AISuggestionApplyMode } from "./types";

export type ApplyResult = {
  applied: string[];
  stale: string[];
};

type ApplyOptions = {
  view: EditorView;
  suggestions: AISuggestion[];
  mode: AISuggestionApplyMode;
  author: string;
};

export function applySuggestions(options: ApplyOptions): ApplyResult {
  const { view, suggestions, mode, author } = options;
  const applied: string[] = [];
  const stale: string[] = [];

  if (suggestions.length === 0) {
    return { applied, stale };
  }

  const resolved: { suggestion: AISuggestion; from: number; to: number }[] = [];
  for (const suggestion of suggestions) {
    const anchor = resolveSuggestionAnchor(view.state.doc, suggestion);
    if (!anchor) {
      stale.push(suggestion.id);
      continue;
    }
    resolved.push({ suggestion, from: anchor.from, to: anchor.to });
  }

  if (resolved.length === 0) {
    return { applied, stale };
  }

  resolved.sort((a, b) => b.from - a.from);

  const tr = view.state.tr;
  if (mode === "direct") {
    for (const { suggestion, from, to } of resolved) {
      tr.insertText(suggestion.suggestedText, from, to);
      applied.push(suggestion.id);
    }
  } else {
    const insertionType = view.state.schema.marks["insertion"];
    const deletionType = view.state.schema.marks["deletion"];
    if (!insertionType || !deletionType) {
      return {
        applied,
        stale: [...stale, ...resolved.map((r) => r.suggestion.id)],
      };
    }
    const date = new Date().toISOString();
    let revisionSeed = Date.now();

    for (const { suggestion, from, to } of resolved) {
      const revisionId = revisionSeed++;
      const attrs = { revisionId, author, date };

      if (suggestion.suggestedText.length > 0) {
        tr.insertText(suggestion.suggestedText, to, to);
        tr.addMark(
          to,
          to + suggestion.suggestedText.length,
          insertionType.create(attrs),
        );
      }
      if (to > from) {
        tr.addMark(from, to, deletionType.create(attrs));
      }
      applied.push(suggestion.id);
    }
  }

  if (tr.docChanged) {
    view.dispatch(tr);
  }
  return { applied, stale };
}
