import { isApparatusRole } from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";

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

/** The blocks the reader folds behind the head-matter disclosure. */
export const apparatusBlockIds = (
  blocks: readonly Block[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === "paragraph" && isApparatusRole(block.role)) {
      ids.add(block.id);
    }
  }
  return ids;
};

const footnoteParagraph = (block: Block | undefined): ParagraphBlock | null =>
  block?.type === "paragraph" && block.note?.type === "footnote" ? block : null;

/**
 * Whether `block` continues the footnote `previous` opened: the two are
 * adjacent parts of one note when both are footnote paragraphs sharing a
 * `noteId`. A footnote paragraph without one is complete by itself, so it
 * neither continues its neighbour nor is continued by it.
 */
const continuesFootnote = (
  previous: Block | undefined,
  block: Block | undefined,
): boolean => {
  const noteId = footnoteParagraph(previous)?.note?.noteId;
  return (
    noteId !== undefined && footnoteParagraph(block)?.note?.noteId === noteId
  );
};

/**
 * Where each footnote begins and ends, by block id.
 *
 * A footnote printed over several paragraphs is several adjacent
 * paragraphs sharing one `noteId`; the reader draws the note's mark once
 * at the start and the return arrow once at the end, the way the printed
 * page does, instead of repeating both on every part.
 */
export type FootnoteParts = {
  headIds: ReadonlySet<string>;
  lastIds: ReadonlySet<string>;
};

export const footnoteParts = (blocks: readonly Block[]): FootnoteParts => {
  const headIds = new Set<string>();
  const lastIds = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (footnoteParagraph(block) === null) {
      continue;
    }
    if (!continuesFootnote(blocks[index - 1], block)) {
      headIds.add(block.id);
    }
    if (!continuesFootnote(block, blocks[index + 1])) {
      lastIds.add(block.id);
    }
  }
  return { headIds, lastIds };
};
