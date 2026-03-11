/**
 * Diff-based paragraph editing for AI workflows.
 *
 * The AI rewrites full paragraph text; this module diffs old vs
 * new to produce precise DocxEdit operations. Uses word-level
 * tokenization so tracked changes align to word boundaries.
 */

import DiffMatchPatch from "diff-match-patch";

import type {
  DiffResult,
  DocxEdit,
  ExtractedDocument,
  ParagraphRewrite,
} from "./types";

type Diff = [number, string];

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

// ── Word-level diffing ───────────────────────────────────

/** Splits on Unicode word boundaries (letters, digits, underscore). */
const WORD_TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;

export const tokenize = (text: string): string[] =>
  text.match(WORD_TOKEN_RE) ?? [];

/**
 * Word-level diff: maps tokens to single chars, diffs the
 * compressed strings, then decodes back to word boundaries.
 */
const wordDiff = (oldText: string, newText: string): Diff[] => {
  const dmp = new DiffMatchPatch();

  const tokenList: string[] = [];
  const tokenToIndex = new Map<string, number>();

  const encode = (tokens: string[]): string =>
    tokens
      .map((token) => {
        let idx = tokenToIndex.get(token);
        if (idx === undefined) {
          idx = tokenList.length;
          tokenList.push(token);
          tokenToIndex.set(token, idx);
        }
        return String.fromCodePoint(idx);
      })
      .join("");

  const oldEncoded = encode(tokenize(oldText));
  const newEncoded = encode(tokenize(newText));

  const diffs = dmp.diff_main(oldEncoded, newEncoded);
  dmp.diff_cleanupSemantic(diffs);

  return diffs.map(
    ([op, chars]): Diff => [
      op,
      [...chars].map((c) => tokenList[c.codePointAt(0) ?? 0]).join(""),
    ],
  );
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
    const [op, text] = diffs[i];

    if (op === DIFF_EQUAL) {
      charOffset += text.length;
      continue;
    }

    if (op === DIFF_DELETE) {
      // DELETE followed by INSERT = REPLACE
      const next = diffs[i + 1];
      if (next && next[0] === DIFF_INSERT) {
        edits.push({
          kind: "replace",
          paragraphIndex,
          charOffset,
          length: text.length,
          text: next[1],
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
    if (op === DIFF_INSERT) {
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

    edits.push(
      ...diffSingleParagraph(
        rewrite.paragraphIndex,
        para.text,
        rewrite.newText,
      ),
    );
  }

  return { edits, skippedRewrites };
};
