import { panic } from "better-result";

import type { DocumentAst } from "./document-ast.js";

/** Structural counterpart of the API contract range, kept dependency-free. */
export type ParagraphRange = {
  readonly from: number;
  readonly to: number;
};

export type DecisionParagraphRangeResolution =
  | {
      readonly type: "found";
      readonly anchorIds: readonly string[];
      readonly firstAnchorId: string;
    }
  | { readonly type: "not-found"; readonly missing: readonly number[] };

/**
 * Resolve court paragraph numbers against the AST. A repeated number is
 * resolved to its first paragraph, matching the order the decision is read.
 */
export const resolveDecisionParagraphRange = (
  ast: DocumentAst,
  { from, to }: ParagraphRange,
): DecisionParagraphRangeResolution => {
  if (
    !Number.isSafeInteger(from) ||
    from < 1 ||
    !Number.isSafeInteger(to) ||
    to < from
  ) {
    return panic("Decision paragraph range must be a valid inclusive range");
  }

  const firstAnchorByNumber = new Map<number, string>();
  for (const block of ast.blocks) {
    if (
      block.type !== "paragraph" ||
      block.number === undefined ||
      !Number.isSafeInteger(block.number) ||
      block.number <= from ||
      block.number > to ||
      firstAnchorByNumber.has(block.number)
    ) {
      continue;
    }
    firstAnchorByNumber.set(block.number, block.anchorId);
  }

  const anchorIds: string[] = [];
  const missing: number[] = [];
  for (let number = from; number <= to; number += 1) {
    const anchorId = firstAnchorByNumber.get(number);
    if (anchorId === undefined) {
      missing.push(number);
    } else {
      anchorIds.push(anchorId);
    }
  }

  if (missing.length > 0) {
    return { type: "not-found", missing };
  }
  const firstAnchorId = anchorIds.at(0);
  if (firstAnchorId === undefined) {
    return panic(
      "A valid inclusive paragraph range must contain a paragraph number",
    );
  }
  return { type: "found", anchorIds, firstAnchorId };
};
