/**
 * Diff-based paragraph editing for AI workflows.
 *
 * The AI rewrites full paragraph text; this module diffs old vs
 * new to produce precise DocxEdit operations. Uses word-level
 * tokenization so tracked changes align to word boundaries.
 */

import { diffArrays } from "diff";

import type {
  DiffResult,
  DiffStats,
  DocxEdit,
  ExtractedDocument,
  ParagraphRewrite,
} from "./types";

type Diff = {
  kind: "delete" | "insert" | "equal";
  text: string;
};

// Short “glue” between adjacent delete/insert pairs that we may fuse.
// Restrict to horizontal whitespace only: `\s` matches `\n` and other
// line/paragraph separators, which must not disappear from insert text.
const SHORT_NEUTRAL_EQUALITY_RE = /^[\t \u00A0()[\]{}.,;:/-]{1,3}$/u;

// ── Word-level diffing ───────────────────────────────────

/** Splits on Unicode word boundaries (letters, digits, underscore). */
const WORD_TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;

export const tokenize = (text: string): string[] =>
  text.match(WORD_TOKEN_RE) ?? [];

const WORD_ONLY_RE = /[\p{L}\p{N}_]+/gu;

const countWords = (text: string): number =>
  text.match(WORD_ONLY_RE)?.length ?? 0;

const mergeAdjacentWordChanges = (diffs: readonly Diff[]): Diff[] => {
  const merged: Diff[] = [];

  for (let i = 0; i < diffs.length; i++) {
    const current = diffs[i];
    const next = diffs.at(i + 1);
    const equality = diffs.at(i + 2);
    const afterEquality = diffs.at(i + 3);
    const final = diffs.at(i + 4);

    if (
      current?.kind === "delete" &&
      next?.kind === "insert" &&
      equality?.kind === "equal" &&
      SHORT_NEUTRAL_EQUALITY_RE.test(equality.text) &&
      afterEquality?.kind === "delete" &&
      final?.kind === "insert"
    ) {
      merged.push({
        kind: "delete",
        text: current.text + equality.text + afterEquality.text,
      });
      merged.push({
        kind: "insert",
        text: next.text + equality.text + final.text,
      });
      i += 4;
      continue;
    }

    if (current) {
      merged.push(current);
    }
  }

  return merged;
};

/**
 * Word-level diff: tokenizes both texts, diffs the token
 * arrays, then merges adjacent small changes.
 */
const wordDiff = (oldText: string, newText: string): Diff[] => {
  const rawDiffs = diffArrays(tokenize(oldText), tokenize(newText)).map(
    (change): Diff => ({
      kind: (() => {
        if (change.added) {
          return "insert";
        }
        if (change.removed) {
          return "delete";
        }
        return "equal";
      })(),
      text: change.value.join(""),
    }),
  );

  return mergeAdjacentWordChanges(rawDiffs);
};

// ── Diff → DocxEdit conversion ───────────────────────────

const diffSingleParagraph = (
  paragraphIndex: number,
  oldText: string,
  newText: string,
): DocxEdit[] => {
  const diffs = wordDiff(oldText, newText);
  const edits: DocxEdit[] = [];
  let charOffset = 0;

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i];
    if (!diff) {
      continue;
    }
    const { kind, text } = diff;

    if (kind === "equal") {
      charOffset += text.length;
      continue;
    }

    if (kind === "delete") {
      // DELETE followed by INSERT = REPLACE
      const next = diffs.at(i + 1);
      if (next?.kind === "insert") {
        edits.push({
          kind: "replace",
          paragraphIndex,
          charOffset,
          length: text.length,
          text: next.text,
        });
        charOffset += text.length;
        i++; // skip the INSERT
      } else {
        edits.push({
          kind: "delete",
          paragraphIndex,
          charOffset,
          length: text.length,
        });
        charOffset += text.length;
      }
      continue;
    }

    // INSERT (standalone, not preceded by DELETE)
    if (kind === "insert") {
      edits.push({
        kind: "insert",
        paragraphIndex,
        charOffset,
        text,
      });
      // INSERT doesn't advance offset in the original text
    }
  }

  return edits;
};

// ── Public API ───────────────────────────────────────────

/** Convert AI paragraph rewrites into precise DocxEdit operations. */
export const diffParagraphs = (
  extracted: ExtractedDocument,
  rewrites: ParagraphRewrite[],
): DiffResult => {
  const edits: DocxEdit[] = [];
  const skippedRewrites: number[] = [];
  const stats: DiffStats = { wordsAdded: 0, wordsRemoved: 0 };

  for (const rewrite of rewrites) {
    const para = extracted.paragraphs.find(
      (p) => p.index === rewrite.paragraphIndex,
    );
    if (!para) {
      skippedRewrites.push(rewrite.paragraphIndex);
      continue;
    }

    if (para.text === rewrite.newText) {
      continue;
    }

    // Count word-level changes from the raw diff
    const diffs = wordDiff(para.text, rewrite.newText);
    for (const d of diffs) {
      if (d.kind === "insert") {
        stats.wordsAdded += countWords(d.text);
      } else if (d.kind === "delete") {
        stats.wordsRemoved += countWords(d.text);
      }
    }

    edits.push(
      ...diffSingleParagraph(
        rewrite.paragraphIndex,
        para.text,
        rewrite.newText,
      ),
    );
  }

  return { edits, skippedRewrites, stats };
};
