import { collapseSpacedLetters } from "@stll/text-normalize";

import { caseLawSectionHeading } from "./case-law-heading.js";
import type { Block, DocumentAst } from "./document-ast.js";

const REASONING_HEADING = /^Odůvodnění\s*:?$/iu;

/**
 * Repair structure shared by every case-law consumer, including decisions
 * stored before parsers learned to preserve same-line Roman section titles.
 */
export const normalizeCaseLawDecisionAst = (ast: DocumentAst): DocumentAst => {
  const blocks: Block[] = [];
  let changed = false;
  let inReasoning = false;
  for (const block of ast.blocks) {
    if (
      block.type === "heading" &&
      REASONING_HEADING.test(collapseSpacedLetters(block.plainText))
    ) {
      inReasoning = true;
    }
    if (inReasoning && block.type === "paragraph" && block.role === undefined) {
      const heading = caseLawSectionHeading(block.plainText);
      if (heading !== null) {
        blocks.push({
          anchorId: block.anchorId,
          id: block.id,
          inlines: block.inlines,
          level: heading.level,
          plainText: block.plainText,
          type: "heading",
        });
        changed = true;
        continue;
      }
    }
    blocks.push(block);
  }
  return changed ? { ...ast, blocks } : ast;
};
