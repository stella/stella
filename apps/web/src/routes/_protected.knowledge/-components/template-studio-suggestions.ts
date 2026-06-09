/**
 * Spec → in-document AISuggestion mapping for the Template Studio chat.
 *
 * Turns (literal -> replacement) specs — derived from
 * `apply-active-docx-edits` tool operations — into one AISuggestion per
 * occurrence of each literal. Occurrences and their context windows come
 * from the same positional-text model the staleness resolver searches
 * (`buildPositionalText`, blocks joined with "\n") — contexts built any
 * other way fail to re-anchor after the first edit and the suggestions
 * all go stale. One suggestion per span: first spec wins per occupied
 * range.
 */

import type { Node as PMNode } from "prosemirror-model";

import { buildPositionalText } from "@stll/folio";
import type { AISuggestion } from "@stll/folio";
import { isFieldPath } from "@stll/template-conditions";

/** Chars of surrounding text recorded so suggestions survive document edits
 *  (the host re-anchors stale ranges via contextBefore/After). */
const CONTEXT_CHARS = 24;

export type ReplacementSpec = {
  /** Caller identity (the tool operation id) — echoed in `placedSpecIds`. */
  id: string;
  literalText: string;
  suggestedText: string;
  topic: string;
  rationale: string;
  /** Badges describing the suggestion's payload (field flow only). */
  display?: AISuggestion["display"];
  /** Registers metadata for each created suggestion id (field flow only). */
  registerMeta?: (suggestionId: string) => void;
  /**
   * Plain text of the snapshot block the operation targeted. When it can
   * be located in the live document, the literal search is confined to
   * that region (mirrors `replaceInBlock` semantics); otherwise the whole
   * document is searched.
   */
  scopeText?: string;
};

export type BuildReplacementSuggestionsResult = {
  suggestions: AISuggestion[];
  /** Ids of specs that produced at least one in-document suggestion. */
  placedSpecIds: Set<string>;
};

export const buildReplacementSuggestions = (
  doc: PMNode,
  specs: readonly ReplacementSpec[],
): BuildReplacementSuggestionsResult => {
  const positional = buildPositionalText(doc);
  const haystack = positional.text;
  const suggestions: AISuggestion[] = [];
  const placedSpecIds = new Set<string>();
  const occupied: { from: number; to: number }[] = [];

  for (const spec of specs) {
    if (spec.literalText.length === 0) {
      continue;
    }

    let regionStart = 0;
    let regionEnd = haystack.length;
    if (spec.scopeText !== undefined && spec.scopeText.length > 0) {
      const scopeIdx = haystack.indexOf(spec.scopeText);
      if (scopeIdx !== -1) {
        regionStart = scopeIdx;
        regionEnd = scopeIdx + spec.scopeText.length;
      }
    }

    let idx = haystack.indexOf(spec.literalText, regionStart);
    while (idx !== -1 && idx + spec.literalText.length <= regionEnd) {
      const from = positional.pmPositionAt(idx);
      const to = positional.pmPositionAt(idx + spec.literalText.length - 1) + 1;
      const overlaps = occupied.some((r) => from < r.to && to > r.from);
      if (!overlaps) {
        occupied.push({ from, to });
        const id = crypto.randomUUID();
        spec.registerMeta?.(id);
        placedSpecIds.add(spec.id);
        const suggestion: AISuggestion = {
          id,
          topic: spec.topic,
          severity: "substantive",
          range: { from, to },
          originalText: spec.literalText,
          suggestedText: spec.suggestedText,
          contextBefore: haystack.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
          contextAfter: haystack.slice(
            idx + spec.literalText.length,
            idx + spec.literalText.length + CONTEXT_CHARS,
          ),
          rationale: spec.rationale,
          status: "pending",
        };
        if (spec.display !== undefined) {
          suggestion.display = spec.display;
        }
        suggestions.push(suggestion);
      }
      idx = haystack.indexOf(spec.literalText, idx + spec.literalText.length);
    }
  }

  return {
    suggestions: suggestions.toSorted((a, b) => a.range.from - b.range.from),
    placedSpecIds,
  };
};

/**
 * Field metadata recovered for a replacement whose `replace` text is a
 * single `{{field.path}}` marker, joined from the latest
 * `suggest_template_fields` tool output.
 */
export type SuggestedFieldMeta = {
  path: string;
  inputType?: string | undefined;
  label?: string | undefined;
  aiPrompt?: string | undefined;
};

/**
 * The field path when `text` is exactly one `{{path}}` marker (the shape
 * the model is told to use when wrapping a literal as a field), else null.
 * Path validity defers to the marker grammar's `isFieldPath`.
 */
export const extractFieldMarkerPath = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) {
    return null;
  }
  const inner = trimmed.slice(2, -2).trim();
  return isFieldPath(inner) ? inner : null;
};

/** Mirrors the Studio inspector's who-fills derivation: a drafting prompt
 *  means AI fills the value, else a person does. (The chat tool does not
 *  propose person+AI adaptation; that stays a manual setting.) */
export const filledByForFieldMeta = (
  meta: SuggestedFieldMeta,
): NonNullable<NonNullable<AISuggestion["display"]>["filledBy"]> =>
  meta.aiPrompt === undefined ? "person" : "ai";
