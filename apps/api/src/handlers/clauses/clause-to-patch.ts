import type { RichRun, RichPatchValue } from "@/api/handlers/docx/types";

import type { ClauseListKind, ClauseParagraph, ClauseBody } from "./types";

const NESTED_INDENT = "    ";

// NOTE: The rich-patch DOCX layer fills a flat run of `w:p` paragraphs cloned
// from the host marker's pPr; it has no path to emit real `w:numPr` numbering
// without injecting numbering.xml definitions and threading a numId through
// every paragraph-producing branch. Rather than destabilize that fill path (or
// silently drop the list), list items are rendered as ordinary paragraphs whose
// first run carries a textual marker ("• " for bullets; "1." / "a." / "i." by
// level for ordered lists) plus indentation. This mirrors the path already
// flattening heading styles to plain runs, so the list text survives injection
// readably. See clause-editor for the structured model that the read view and
// editor render as true nested <ul>/<ol>.
const ROMAN = [
  "i",
  "ii",
  "iii",
  "iv",
  "v",
  "vi",
  "vii",
  "viii",
  "ix",
  "x",
] as const;

const orderedLabel = (level: number, ordinal: number): string => {
  // 1-based ordinal; cycle marker style by depth: 1. → a. → i. → 1. …
  const style = level % 3;
  if (style === 1) {
    const letter = String.fromCodePoint(
      "a".codePointAt(0) + ((ordinal - 1) % 26),
    );
    return `${letter}.`;
  }
  if (style === 2) {
    return `${ROMAN[(ordinal - 1) % ROMAN.length] ?? String(ordinal)}.`;
  }
  return `${ordinal}.`;
};

const listMarker = (
  kind: ClauseListKind,
  level: number,
  ordinal: number,
): string => {
  const indent = NESTED_INDENT.repeat(level);
  if (kind === "bullet") {
    return `${indent}• `;
  }
  return `${indent}${orderedLabel(level, ordinal)} `;
};

const prefixRuns = (runs: RichRun[], prefix: string): RichRun[] => {
  const [first, ...rest] = runs;
  if (!first) {
    return [{ text: prefix }];
  }
  return [{ ...first, text: `${prefix}${first.text}` }, ...rest];
};

const paragraphRuns = (p: ClauseParagraph): RichRun[] =>
  p.runs ?? [{ text: p.text }];

/**
 * Convert a ClauseBody into a RichPatchValue suitable for DOCX template
 * filling. Block directives are filtered out; list items are flattened to
 * marker-prefixed paragraphs (see NOTE above); every other paragraph maps to
 * its runs.
 */
export const clauseBodyToRichPatch = (body: ClauseBody): RichPatchValue => {
  // Per-level ordinal counters for ordered lists; reset when the list breaks
  // (a non-list paragraph) or a level is left and re-entered.
  const counters = new Map<number, number>();

  const paragraphs = body
    .filter((p) => !p.isDirective)
    .map((p) => {
      if (!p.listKind) {
        counters.clear();
        return { runs: paragraphRuns(p) };
      }

      const level = Math.max(0, p.listLevel ?? 0);
      // Leaving a deeper level invalidates its counter for a fresh restart.
      for (const key of counters.keys()) {
        if (key > level) {
          counters.delete(key);
        }
      }
      const ordinal = (counters.get(level) ?? 0) + 1;
      counters.set(level, ordinal);

      return {
        runs: prefixRuns(
          paragraphRuns(p),
          listMarker(p.listKind, level, ordinal),
        ),
      };
    });

  return { paragraphs };
};

/**
 * Flatten a ClauseBody to plain text (one line per paragraph) for
 * version diffing. Directive paragraphs are kept: a changed `{{#if}}`
 * condition alters fill behaviour and must show up in the diff.
 */
export const clauseBodyToPlainText = (body: ClauseBody): string =>
  body.map((p) => p.text).join("\n");
