/**
 * Which blocks one provision owns, and which of them a citation shows.
 *
 * The rule lives here rather than beside a reader because two runtimes apply
 * it to the same document: the API narrows a stored AST down to a preview
 * payload, and the statute reader narrows the document it already holds.
 */
import {
  resolveDocumentAnchor,
  resolveDocumentHeadingAnchor,
} from "./document-ast.js";
import type { Block, HeadingBlock } from "./document-ast.js";

const blocksOwnedByHeading = (
  blocks: readonly Block[],
  heading: HeadingBlock,
): Block[] | null => {
  const start = blocks.indexOf(heading);
  if (start === -1) {
    return null;
  }

  const owned: Block[] = [heading];
  for (const block of blocks.slice(start + 1)) {
    if (block.type === "heading" && block.level <= heading.level) {
      break;
    }
    owned.push(block);
  }
  return owned;
};

/**
 * The blocks a cited subdivision owns: itself, plus the subdivisions nested
 * under it.
 *
 * Statute subdivisions are not headings, so their nesting lives in the anchor
 * path rather than in a level: `par_3-odst_2` owns `par_3-odst_2-pism_a`,
 * which in turn owns `par_3-odst_2-pism_d-bod_1`. Descendants follow their
 * parent contiguously, so the range ends at the first block that is not one —
 * a cited paragraph therefore stops before the next paragraph. The separator
 * is part of the test, or `odst_2` would swallow `odst_20`.
 */
const blocksNestedUnder = (blocks: readonly Block[], cited: Block): Block[] => {
  const start = blocks.indexOf(cited);
  if (start === -1) {
    return [cited];
  }

  const owned: Block[] = [cited];
  for (const block of blocks.slice(start + 1)) {
    if (!block.anchorId.startsWith(`${cited.anchorId}-`)) {
      break;
    }
    owned.push(block);
  }
  return owned;
};

/** The complete block range owned by one provision heading. */
export const provisionBlocks = (
  blocks: readonly Block[],
  anchorId: string,
): Block[] | null => {
  const heading = resolveDocumentHeadingAnchor(blocks, anchorId);
  return heading === null ? null : blocksOwnedByHeading(blocks, heading);
};

/**
 * The narrowest truthful wording for a citation preview: the cited unit and
 * everything it owns. A cited paragraph shows its letters and their points, a
 * cited letter shows its points, a cited point shows itself, and a cited
 * nested heading keeps its owned text. A provision-level citation shows the
 * provision body.
 */
export const provisionPreviewBlocks = (
  blocks: readonly Block[],
  provisionAnchorId: string,
  citedAnchorId: string | undefined,
): Block[] | null => {
  const provision = provisionBlocks(blocks, provisionAnchorId);
  if (provision === null) {
    return null;
  }

  const cited = resolveDocumentAnchor(
    provision,
    citedAnchorId ?? provisionAnchorId,
  );
  if (cited === null || cited.anchorId === provision.at(0)?.anchorId) {
    return provision.slice(1);
  }
  if (cited.type !== "heading") {
    return blocksNestedUnder(provision, cited);
  }
  return blocksOwnedByHeading(provision, cited);
};

/**
 * The heading a cited subdivision belongs to: `par_90-odst_5` is filed, cited
 * and versioned under `par_90`. The subdivision stays the highlight target.
 */
export const provisionHeadingAnchor = (anchor: string): string =>
  anchor.split("-")[0] ?? anchor;

/**
 * The headings a provision sits under, outermost first, without the
 * provision's own heading: the part, title and division a reader needs to
 * place a section quoted out of its statute.
 */
export const provisionHeadingChain = (
  blocks: readonly Block[],
  anchorId: string,
): HeadingBlock[] | null => {
  const heading = resolveDocumentHeadingAnchor(blocks, anchorId);
  if (heading === null) {
    return null;
  }

  const start = blocks.indexOf(heading);
  if (start === -1) {
    return null;
  }

  const chain: HeadingBlock[] = [];
  let depth = heading.level;
  for (let index = start - 1; index >= 0 && depth > 1; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "heading" || block.level >= depth) {
      continue;
    }
    chain.push(block);
    depth = block.level;
  }

  return chain.toReversed();
};
