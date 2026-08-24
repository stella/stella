import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

/**
 * Remove structural metadata that the reader renders elsewhere. Content is
 * never hidden by matching its words: a court's title and constitutional
 * formula are part of the decision and remain visible as AST headings.
 */
export const visibleDecisionBlocks = (ast: DocumentAst | null): Block[] => {
  if (ast === null) {
    return [];
  }

  return ast.blocks.filter(
    (block) =>
      !(block.type === "paragraph" && block.role === "case-number") &&
      !(block.type === "table" && block.role === "related-proceedings"),
  );
};
