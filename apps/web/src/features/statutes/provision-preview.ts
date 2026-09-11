import {
  resolveDocumentAnchor,
  resolveDocumentHeadingAnchor,
} from "@stll/legal-ast/document-ast";
import type { Block, HeadingBlock } from "@stll/legal-ast/document-ast";

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

/** The complete block range owned by one provision heading. */
export const provisionBlocks = (
  blocks: readonly Block[],
  anchorId: string,
): Block[] | null => {
  const heading = resolveDocumentHeadingAnchor(blocks, anchorId);
  return heading === null ? null : blocksOwnedByHeading(blocks, heading);
};

/**
 * The narrowest truthful wording for a citation preview. A cited paragraph,
 * letter or point shows only that block; a cited nested heading keeps its
 * owned text. A provision-level citation shows the provision body.
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
    return [cited];
  }
  return blocksOwnedByHeading(provision, cited);
};
