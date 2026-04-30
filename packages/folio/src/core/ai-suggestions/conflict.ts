/**
 * Conflict / staleness detection for AI suggestions.
 *
 * A suggestion is generated against a snapshot of the document. By the
 * time the user accepts it, the underlying text may have moved or
 * changed. We never rewrite text we did not author — if the anchor no
 * longer matches, the suggestion is marked stale and surfaced for
 * manual review instead.
 */

import type { Node as PMNode } from "prosemirror-model";

import { buildPositionalText } from "./text-positions";
import type { AISuggestion } from "./types";

const ANCHOR_SEARCH_WINDOW_PM = 2000;

export type ResolvedAnchor = {
  from: number;
  to: number;
};

/**
 * Resolve the current PM range of a suggestion's original text.
 *
 * Strategy:
 * 1. If the recorded range still contains the originalText verbatim, use it.
 * 2. Otherwise, search a bounded window of the document for a unique
 *    match of `contextBefore + originalText + contextAfter`.
 * 3. If the match is missing or ambiguous, return null — the caller
 *    treats null as a stale suggestion.
 */
export function resolveSuggestionAnchor(
  doc: PMNode,
  suggestion: AISuggestion,
): ResolvedAnchor | null {
  const docSize = doc.content.size;
  const { from, to } = suggestion.range;

  if (
    from >= 0 &&
    to <= docSize &&
    to - from === suggestion.originalText.length
  ) {
    const slice = doc.textBetween(from, to, "\n", "\n");
    if (slice === suggestion.originalText) {
      return { from, to };
    }
  }

  const windowStart = Math.max(0, from - ANCHOR_SEARCH_WINDOW_PM);
  const windowEnd = Math.min(docSize, to + ANCHOR_SEARCH_WINDOW_PM);
  const positional = buildPositionalText(doc, windowStart, windowEnd);
  const needle =
    suggestion.contextBefore +
    suggestion.originalText +
    suggestion.contextAfter;

  const firstHit = positional.text.indexOf(needle);
  if (firstHit === -1) {
    return null;
  }
  const secondHit = positional.text.indexOf(needle, firstHit + 1);
  if (secondHit !== -1) {
    return null;
  }

  const originalTextStart = firstHit + suggestion.contextBefore.length;
  const originalTextEnd = originalTextStart + suggestion.originalText.length;
  if (suggestion.originalText.length === 0) {
    const point = positional.pmPositionAt(originalTextStart);
    return { from: point, to: point };
  }
  const anchorFrom = positional.pmPositionAt(originalTextStart);
  const anchorTo = positional.pmPositionAt(originalTextEnd - 1) + 1;
  return { from: anchorFrom, to: anchorTo };
}

export function isSuggestionStale(
  doc: PMNode,
  suggestion: AISuggestion,
): boolean {
  return resolveSuggestionAnchor(doc, suggestion) === null;
}
