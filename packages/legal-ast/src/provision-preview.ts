/**
 * Which blocks one provision owns, and which of them a citation shows.
 *
 * The rule lives here rather than beside a reader because two runtimes apply
 * it to the same document: the API narrows a stored AST down to a preview
 * payload, and the statute reader narrows the document it already holds.
 */
import { panic } from "better-result";

import {
  resolveDocumentAnchor,
  resolveDocumentHeadingAnchor,
} from "./document-ast.js";
import type { Block, HeadingBlock } from "./document-ast.js";
import { anchorWithin } from "./statute-anchor-scheme.js";
import type {
  StatuteAnchorNesting,
  StatuteBlocks,
} from "./statute-anchor-scheme.js";

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
 * which in turn owns `par_3-odst_2-pism_d-bod_1`, as `paragraf-3.odsek-2`
 * owns `paragraf-3.odsek-2.pismeno-a`. Descendants follow their parent
 * contiguously, so the range ends at the first block that is not one — a
 * cited paragraph therefore stops before the next paragraph.
 */
export const blocksNestedUnder = <T extends Pick<Block, "anchorId">>(
  { blocks, scheme }: StatuteBlocks<T>,
  cited: T,
): T[] => {
  const start = blocks.indexOf(cited);
  if (start === -1) {
    return [cited];
  }

  const owned: T[] = [cited];
  for (const block of blocks.slice(start + 1)) {
    if (
      !anchorWithin(scheme, {
        ancestor: cited.anchorId,
        anchor: block.anchorId,
      })
    ) {
      break;
    }
    owned.push(block);
  }
  return owned;
};

/** The complete block range owned by one provision heading. */
export const provisionBlocks = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): Block[] | null => {
  const heading = resolveDocumentHeadingAnchor(statute, anchorId);
  return heading === null
    ? null
    : blocksOwnedByHeading(statute.blocks, heading);
};

type ProvisionPreviewTarget = {
  provisionAnchorId: string;
  citedAnchorId: string | undefined;
};

/**
 * The narrowest truthful wording for a citation preview: the cited unit and
 * everything it owns. A cited paragraph shows its letters and their points, a
 * cited letter shows its points, a cited point shows itself, and a cited
 * nested heading keeps its owned text. A provision-level citation shows the
 * provision body.
 */
export const provisionPreviewBlocks = (
  statute: StatuteBlocks<Block>,
  { provisionAnchorId, citedAnchorId }: ProvisionPreviewTarget,
): Block[] | null => {
  const provision = provisionBlocks(statute, provisionAnchorId);
  if (provision === null) {
    return null;
  }

  const owned = { blocks: provision, scheme: statute.scheme };
  const cited = resolveDocumentAnchor(
    owned,
    citedAnchorId ?? provisionAnchorId,
  );
  if (cited === null || cited.anchorId === provision.at(0)?.anchorId) {
    return provision.slice(1);
  }
  if (cited.type !== "heading") {
    return blocksNestedUnder(owned, cited);
  }
  return blocksOwnedByHeading(provision, cited);
};

/**
 * The heading a cited subdivision belongs to: `par_90-odst_5` is filed, cited
 * and versioned under `par_90`, `s1983/a/1` under `s1983`. The separator is
 * the citing country's scheme's, because a section number may itself carry
 * another one (`s2000e-2/a`). A flat scheme files every anchor under itself.
 * The subdivision stays the highlight target.
 */
export const provisionHeadingAnchor = (
  anchor: string,
  nesting: StatuteAnchorNesting,
): string => {
  switch (nesting.type) {
    case "nested":
      return anchor.split(nesting.separator)[0] ?? anchor;
    case "flat":
      return anchor;
    default:
      nesting satisfies never;
      return panic("Unhandled statute anchor nesting");
  }
};

/**
 * The heading in a statute an anchor is nested under: the longest heading
 * anchor the anchor continues in the publisher's scheme. Read off the
 * document, for a reader that holds the statute but not the citation that
 * named the anchor. Null when the anchor continues no heading.
 */
export const enclosingHeadingAnchor = (
  { blocks, scheme }: StatuteBlocks<Block>,
  anchor: string,
): string | null => {
  let enclosing: string | null = null;
  for (const block of blocks) {
    if (
      block.type === "heading" &&
      anchorWithin(scheme, { ancestor: block.anchorId, anchor }) &&
      (enclosing === null || block.anchorId.length > enclosing.length)
    ) {
      enclosing = block.anchorId;
    }
  }
  return enclosing;
};

/**
 * The headings a provision sits under, outermost first, without the
 * provision's own heading: the part, title and division a reader needs to
 * place a section quoted out of its statute.
 */
export const provisionHeadingChain = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): HeadingBlock[] | null => {
  const heading = resolveDocumentHeadingAnchor(statute, anchorId);
  if (heading === null) {
    return null;
  }

  const { blocks } = statute;
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
