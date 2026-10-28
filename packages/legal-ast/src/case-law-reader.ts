import { panic } from "better-result";

import { normalizeCaseLawDecisionAst } from "./case-law-normalize.js";
import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionPrimaryReferenceType,
} from "./decision-identifier.js";
import {
  type Block,
  type DocumentAst,
  type ParagraphBlock,
  parseUsableDocumentAst,
  plainTextOf,
  tableCellPieceId,
} from "./document-ast.js";
import { leadingSourceContentsBlockIds } from "./source-contents.js";

/** Parse persisted case-law content and apply every read-time structural repair. */
export const parseCaseLawDecisionAst = (raw: unknown): DocumentAst | null => {
  const ast = parseUsableDocumentAst(raw);
  return ast === null ? null : normalizeCaseLawDecisionAst(ast);
};

/** A run of words the reader renders under its own `data-anchor`. */
type ReaderAnchorPiece = { anchorId: string; text: string };

/**
 * The anchored pieces a reader selection can land in, each with the text
 * its offsets index. A table is anchored per cell, an image not at all.
 */
export const readerAnchorPiecesOf = (block: Block): ReaderAnchorPiece[] => {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [{ anchorId: block.anchorId, text: plainTextOf(block.inlines) }];
    case "table":
      return block.rows.flatMap((row, rowIndex) =>
        row.map((cell, columnIndex) => ({
          anchorId: tableCellPieceId({
            blockId: block.id,
            columnIndex,
            rowIndex,
          }),
          text: plainTextOf(cell.inlines),
        })),
      );
    case "image":
      return [];
    default:
      block satisfies never;
      return panic(`Unhandled block type: ${String(block)}`);
  }
};

/** A decision stored as flat text, one paragraph per blank-line-separated run. */
export const buildFulltextParagraphBlocks = (text: string): ParagraphBlock[] =>
  text.split(/\n{2,}/u).map((paragraph, index) => ({
    id: `fulltext:${index}`,
    anchorId: `fulltext:${index}`,
    type: "paragraph",
    plainText: paragraph,
    inlines: [{ text: paragraph, type: "text" }],
  }));

/**
 * Remove structural metadata that the reader renders elsewhere. Content is
 * never hidden by matching its words: a court's title and constitutional
 * formula are part of the decision and remain visible as AST headings. The
 * case-number header is the reference line only for a docket primary; under
 * any other primary it is the docket, which nothing else shows, so it stays.
 * A publisher's leading table of contents is navigation the reader draws from
 * the headings itself, so its lines are left out of the view; storage keeps
 * them.
 */
export const visibleDecisionBlocks = (
  ast: DocumentAst | null,
  caseNumberType: DecisionPrimaryReferenceType,
  fulltext?: string | null,
): Block[] => {
  const docketIsReferenceLine =
    caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  const sourceContents = leadingSourceContentsBlockIds(ast?.blocks ?? []);
  const visible: Block[] = [];
  for (const block of ast?.blocks ?? []) {
    if (
      sourceContents.has(block.id) ||
      (docketIsReferenceLine &&
        block.type === "paragraph" &&
        block.role === "case-number") ||
      (block.type === "table" && block.role === "related-proceedings")
    ) {
      continue;
    }
    visible.push(block);
  }
  if (visible.length > 0 || !fulltext) {
    return visible;
  }
  return buildFulltextParagraphBlocks(fulltext);
};

/**
 * The pieces of a decision's AST the reader shows and lets someone select.
 * The reader's check before Explain and every server read of a decision for
 * Explain or for a mark use this one list, so the server never accepts or
 * cites text the reader hides.
 */
export const visibleReaderAnchorPiecesOf = (
  ast: DocumentAst | null,
  caseNumberType: DecisionPrimaryReferenceType,
): ReaderAnchorPiece[] =>
  visibleDecisionBlocks(ast, caseNumberType).flatMap(readerAnchorPiecesOf);

/** One span of a selection, stored as offsets into one anchored piece. */
type ReaderSelectionSpan = {
  anchorId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
};

/**
 * Whether `spans` is a selection the reader offers: at least one span, each
 * exactly the text at its offsets in one of `pieces`, the pieces in reading
 * order without repeats. The reader checks a selection before sending it and
 * the server checks it again on receipt, so both refuse the same selections.
 * The decision's own text bounds a selection, so there is no length cap.
 */
export const readerSelectionMatches = (
  pieces: readonly ReaderAnchorPiece[],
  spans: readonly ReaderSelectionSpan[],
): boolean => {
  const indexById = new Map(
    pieces.map(({ anchorId }, index) => [anchorId, index] as const),
  );
  let previous = -1;
  for (const { anchorId, startOffset, endOffset, quote } of spans) {
    const index = indexById.get(anchorId);
    const text = index === undefined ? undefined : pieces[index]?.text;
    if (
      index === undefined ||
      text === undefined ||
      index <= previous ||
      startOffset < 0 ||
      endOffset > text.length ||
      endOffset <= startOffset ||
      text.slice(startOffset, endOffset) !== quote
    ) {
      return false;
    }
    previous = index;
  }
  return spans.length > 0;
};
