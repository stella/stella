import type { Block } from "@stll/legal-ast/document-ast";
import { resolveDocumentAnchor } from "@stll/legal-ast/document-ast";
import {
  enclosingHeadingAnchor,
  governingWording,
  provisionBlocks,
  provisionPreviewBlocks,
} from "@stll/legal-ast/provision-preview";
import type { GoverningWordingPosition } from "@stll/legal-ast/provision-preview";
import { unfiledAnchor } from "@stll/legal-ast/statute-anchor-scheme";
import type { StatuteBlocks } from "@stll/legal-ast/statute-anchor-scheme";

type SubdivisionTarget = { provisionAnchorId: string; citedAnchorId: string };

/**
 * The blocks one subdivision anchor owns, or null when the provision it is
 * filed under does not carry it.
 *
 * `provisionPreviewBlocks` narrows to the whole provision body when the cited
 * anchor resolves to nothing, which is the right answer for a hover preview
 * and the wrong one for a caller asking for that subdivision: it would return
 * neighbouring text under an anchor the consolidation never had. So the
 * anchor is resolved first, and only a resolved one is narrowed.
 */
const subdivisionBlocks = (
  statute: StatuteBlocks<Block>,
  { provisionAnchorId, citedAnchorId }: SubdivisionTarget,
): readonly Block[] | null => {
  const provision = provisionBlocks(statute, provisionAnchorId);
  if (
    provision === null ||
    resolveDocumentAnchor(
      { blocks: provision, scheme: statute.scheme },
      citedAnchorId,
    ) === null
  ) {
    return null;
  }

  return provisionPreviewBlocks(statute, { provisionAnchorId, citedAnchorId });
};

/**
 * The heading whose range holds a block: the nearest heading above it, since
 * no heading stands between the two to close that range. How a block whose
 * anchor continues no heading's path (an unfiled `frag_…`) is still read
 * under the provision it is printed in.
 */
const headingHolding = (
  statute: StatuteBlocks<Block>,
  block: Block,
): string | null =>
  statute.blocks
    .slice(0, Math.max(statute.blocks.indexOf(block), 0))
    .findLast((candidate) => candidate.type === "heading")?.anchorId ?? null;

/** Where a subdivision's governing wording sits, as a reader states it. */
type ProvisionGoverningText = {
  anchor: string;
  position: GoverningWordingPosition;
  text: string;
};

export type ProvisionReading = {
  text: string;
  /**
   * Wording outside the cited subdivision that governs it: the lead-in of
   * each unit it is nested in and the closing text after their lists. Empty
   * for a whole provision.
   */
  governing: ProvisionGoverningText[];
};

const joinedText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => block.plainText.trim())
    .filter((part) => part.length > 0)
    .join("\n");

/**
 * The text one anchor owns, with the wording that governs it.
 *
 * A provision heading (`par_1729`) owns its heading plus every block that
 * follows until a heading at the same or a shallower level opens the next
 * provision. Nested subdivisions stay inside, which is what a reader
 * comparing two consolidations of a section expects to see.
 *
 * A subdivision (`par_1729-odst_1`, `paragraf-36.pismeno-a`) owns itself, the
 * subdivisions nested under it and, for a subsection, the unnumbered wording
 * that carries it on. Both spellings are addressable because
 * both are what a citation names. The narrowing rule and the anchor grammar
 * are the shared ones in `@stll/legal-ast`, read through the publisher's
 * scheme, rather than a second reading of the path here. A subdivision's
 * reading also carries the wording of the units around it that governs it
 * (`governingWording`), so a read of one letter never silently drops the
 * sentence its parent closes the list with.
 *
 * Every block is readable by its own anchor: unfiled wording, whose anchor
 * continues no heading's path, is read under the heading it is printed in.
 *
 * Returns null when the consolidation carries no such anchor, which is how an
 * unknown anchor is told apart from a provision that exists and is empty. An
 * anchor in another publisher's grammar continues no heading, so it reads as
 * absent too.
 */
export const readProvision = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): ProvisionReading | null => {
  // A provision heading first, because that is what the anchor usually is and
  // a heading anchor may itself contain a separator (`sec-1-a`): the anchor
  // grammar is not a reliable way to tell the two apart, but the document is.
  const whole = provisionBlocks(statute, anchorId);
  if (whole !== null) {
    return { text: joinedText(whole), governing: [] };
  }
  // The block the anchor names, by its own anchor or by a unique tail of it
  // (`frag_6070235` for `par_5-pism_e-frag_6070235`).
  const cited = resolveDocumentAnchor(statute, anchorId);
  if (cited === null) {
    return null;
  }
  const provisionAnchorId =
    enclosingHeadingAnchor(statute, cited.anchorId) ??
    (unfiledAnchor(statute.scheme, cited.anchorId)
      ? headingHolding(statute, cited)
      : null);
  if (provisionAnchorId === null) {
    return null;
  }
  const target = { provisionAnchorId, citedAnchorId: cited.anchorId };
  const owned = subdivisionBlocks(statute, target);
  if (owned === null) {
    return null;
  }
  return {
    text: joinedText(owned),
    governing: governingWording(statute, target).flatMap(
      ({ block, position }) => {
        const text = block.plainText.trim();
        return text === "" ? [] : [{ anchor: block.anchorId, position, text }];
      },
    ),
  };
};

/** The text one anchor owns; see `readProvision`. */
export const extractProvisionText = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): string | null => readProvision(statute, anchorId)?.text ?? null;
