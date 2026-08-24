import type { Block } from "@stll/legal-ast/document-ast";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";
import type { CitedDecision } from "@/features/case-law/citation-treatment";

/** A resolved citation: the text as the decision wrote it, and its target. */
export type CitationAnchorSource = {
  citationText: string;
  decision: CitedDecision;
  id: string;
};

export type CitationAnchorSpan = {
  end: number;
  source: CitationAnchorSource;
  start: number;
};

/**
 * Citations whose text is long enough to locate without false hits. A very
 * short case number would match inside longer ones and inside dates.
 */
const MIN_ANCHOR_TEXT_LENGTH = 5;

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Overlapping spans keep the earlier, longer one. Shared by every kind of
 * inline anchor so two locators cannot hand the renderer nested links.
 */
export const dropOverlappingSpans = <T extends { end: number; start: number }>(
  spans: readonly T[],
): T[] => {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: T[] = [];
  let lastEnd = -1;
  for (const span of sorted) {
    if (span.start < lastEnd) {
      continue;
    }
    kept.push(span);
    lastEnd = span.end;
  }
  return kept;
};

/**
 * A pattern for the citation as the text may print it: the extractor stored
 * the verbatim match, which can carry a wrapped line or a double space where
 * the rendered paragraph has one, so whitespace runs match any whitespace.
 */
const patternFor = (citationText: string): RegExp | null => {
  const trimmed = citationText.trim();
  if (trimmed.length < MIN_ANCHOR_TEXT_LENGTH) {
    return null;
  }
  const source = trimmed
    .split(/\s+/u)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
  // Citation-safe boundaries, not `\b`: a case number ends in a digit and
  // may be followed by a page suffix ("-493") or a period, both fine, but
  // "II CSK 123/20" must not match inside "II CSK 123/201", and a number
  // must not start in the middle of a word or a longer number.
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}/])`, "gu");
};

/**
 * Where each cited decision is named in each block, keyed by block id.
 *
 * One citation row stands for every mention of its case in the decision,
 * so every occurrence links. Overlapping hits keep the earlier, longer one;
 * a table is skipped because its text is split across cell pieces.
 */
export const locateCitationAnchors = ({
  blocks,
  citations,
}: {
  blocks: readonly Block[];
  citations: readonly CitationAnchorSource[];
}): Record<string, CitationAnchorSpan[]> => {
  const patterns: { pattern: RegExp; source: CitationAnchorSource }[] = [];
  for (const source of citations) {
    const pattern = patternFor(source.citationText);
    if (pattern !== null) {
      patterns.push({ pattern, source });
    }
  }
  if (patterns.length === 0) {
    return {};
  }

  const result: Record<string, CitationAnchorSpan[]> = {};
  for (const block of blocks) {
    if (block.type === "table") {
      continue;
    }
    // The reader renders and highlights over the inline flattening, not
    // `block.plainText`, which the pipeline may have normalised; offsets
    // must come from the same characters the renderer walks.
    const text = inlinesToPlainText(block.inlines);
    const hits: CitationAnchorSpan[] = [];
    for (const { pattern, source } of patterns) {
      pattern.lastIndex = 0;
      for (
        let match = pattern.exec(text);
        match !== null;
        match = pattern.exec(text)
      ) {
        hits.push({
          end: match.index + match[0].length,
          source,
          start: match.index,
        });
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
        }
      }
    }
    if (hits.length === 0) {
      continue;
    }

    result[block.id] = dropOverlappingSpans(hits);
  }

  return result;
};
