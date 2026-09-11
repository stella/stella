import { caseLawSectionHeading } from "@stll/legal-ast/case-law-heading";
import { isApparatusRole } from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";

export type EditorialSupplementBlock = {
  end: number;
  start: number;
  text: string;
  type: "heading" | "paragraph";
};

type AnnotationOffsetSpan = {
  endOffset: number;
  startOffset: number;
};

type TextOffsetSpan = {
  end: number;
  start: number;
};

/**
 * The reader keeps links interactive inside a marked passage. Every mark
 * intersecting the link must therefore be painted inside the link as well;
 * otherwise the citation cuts a white hole through one continuous mark.
 */
export const annotationsOverlappingTextSpan = <T extends AnnotationOffsetSpan>(
  annotations: readonly T[],
  span: TextOffsetSpan,
): T[] =>
  annotations.filter(
    (annotation) =>
      annotation.startOffset < span.end && span.start < annotation.endOffset,
  );

const EDITORIAL_BLOCK_BOUNDARY_RE =
  /(?<=[.!?])(?=\p{Lu})|(?<=[\p{Ll}])(?=\p{Lu})/gu;
const EXPLICIT_EDITORIAL_BLOCK_BREAK_RE = /\n[\t ]*\n+/gu;
const EDITORIAL_HEADING_MAX_CHARS = 120;
const TERMINAL_PUNCTUATION_RE = /[.!?][”’"']?$/u;

const editorialBlock = (
  source: string,
  rawStart: number,
  rawEnd: number,
): EditorialSupplementBlock | null => {
  const raw = source.slice(rawStart, rawEnd);
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const start = rawStart + leadingWhitespace;
  const end = start + text.length;
  const type =
    text.length <= EDITORIAL_HEADING_MAX_CHARS &&
    !TERMINAL_PUNCTUATION_RE.test(text)
      ? "heading"
      : "paragraph";
  return { end, start, text, type };
};

/**
 * Render publisher-preserved blank lines as authoritative block boundaries.
 * The adjacency inference only supports rows projected before the CZ-US raw
 * replay path existed; remove it after those rows have been reprocessed.
 * Offsets remain on the untouched source string so reader search highlights
 * still land on the correct characters.
 */
export const editorialSupplementBlocks = (
  source: string,
): EditorialSupplementBlock[] => {
  const explicitBreaks = [
    ...source.matchAll(EXPLICIT_EDITORIAL_BLOCK_BREAK_RE),
  ];
  if (explicitBreaks.length > 0) {
    const explicitBlocks: EditorialSupplementBlock[] = [];
    let explicitStart = 0;
    for (const match of explicitBreaks) {
      const block = editorialBlock(source, explicitStart, match.index);
      if (block !== null) {
        explicitBlocks.push(block);
      }
      explicitStart = match.index + match[0].length;
    }
    const finalBlock = editorialBlock(source, explicitStart, source.length);
    if (finalBlock !== null) {
      explicitBlocks.push(finalBlock);
    }
    return explicitBlocks;
  }

  const boundaries: number[] = [];
  let start = 0;
  for (const match of source.matchAll(EDITORIAL_BLOCK_BOUNDARY_RE)) {
    const index = match.index;
    const previous = source[index - 1];
    const candidate = source.slice(start, index).trim();
    const candidateWords = candidate.split(/\s+/u);
    const lastCandidateWord = candidateWords.at(-1) ?? "";
    const sentenceBoundary = previous !== undefined && /[.!?]/u.test(previous);
    const headingBoundary =
      candidate.length <= EDITORIAL_HEADING_MAX_CHARS &&
      candidateWords.length >= 2 &&
      /^\p{Ll}{2,}$/u.test(lastCandidateWord) &&
      !TERMINAL_PUNCTUATION_RE.test(candidate);
    if (!sentenceBoundary && !headingBoundary) {
      continue;
    }
    boundaries.push(index);
    start = index;
  }

  const blocks: EditorialSupplementBlock[] = [];
  let blockStart = 0;
  for (const boundary of [...boundaries, source.length]) {
    const block = editorialBlock(source, blockStart, boundary);
    if (block !== null) {
      blocks.push(block);
    }
    blockStart = boundary;
  }
  return blocks;
};

/**
 * Remove structural metadata that the reader renders elsewhere. Content is
 * never hidden by matching its words: a court's title and constitutional
 * formula are part of the decision and remain visible as AST headings.
 */
export const visibleDecisionBlocks = (ast: DocumentAst | null): Block[] => {
  if (ast === null) {
    return [];
  }

  const visible: Block[] = [];
  let inReasoning = false;
  for (const block of ast.blocks) {
    if (
      (block.type === "paragraph" && block.role === "case-number") ||
      (block.type === "table" && block.role === "related-proceedings")
    ) {
      continue;
    }
    if (
      block.type === "heading" &&
      /^Odůvodnění\s*:?$/iu.test(block.plainText)
    ) {
      inReasoning = true;
    }
    if (inReasoning && block.type === "paragraph" && block.role === undefined) {
      const heading = caseLawSectionHeading(block.plainText);
      if (heading !== null) {
        visible.push({
          anchorId: block.anchorId,
          id: block.id,
          inlines: block.inlines,
          level: heading.level,
          plainText: block.plainText,
          type: "heading",
        });
        continue;
      }
    }
    visible.push(block);
  }
  return visible;
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
  /**
   * The footnote's head anchor, keyed by the id of its last block: the
   * return arrow sits on the last part but jumps back from the head, which
   * is the anchor the in-text reference points at.
   */
  backJumpAnchorByLastId: ReadonlyMap<string, string>;
};

export const footnoteParts = (blocks: readonly Block[]): FootnoteParts => {
  const headIds = new Set<string>();
  const backJumpAnchorByLastId = new Map<string, string>();
  let headAnchor: string | null = null;
  for (const [index, block] of blocks.entries()) {
    if (footnoteParagraph(block) === null) {
      continue;
    }
    if (!continuesFootnote(blocks[index - 1], block)) {
      headIds.add(block.id);
      headAnchor = block.anchorId;
    }
    if (!continuesFootnote(block, blocks[index + 1])) {
      backJumpAnchorByLastId.set(block.id, headAnchor ?? block.anchorId);
    }
  }
  return { headIds, backJumpAnchorByLastId };
};
