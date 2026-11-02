import type { Block } from "@stll/legal-ast/document-ast";
import { resolveDocumentAnchor } from "@stll/legal-ast/document-ast";
import {
  enclosingHeadingAnchor,
  provisionBlocks,
  provisionPreviewBlocks,
} from "@stll/legal-ast/provision-preview";
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
 * The text one anchor owns.
 *
 * A provision heading (`par_1729`) owns its heading plus every block that
 * follows until a heading at the same or a shallower level opens the next
 * provision. Nested subdivisions stay inside, which is what a reader
 * comparing two consolidations of a section expects to see.
 *
 * A subdivision (`par_1729-odst_1`, `paragraf-36.pismeno-a`) owns itself and
 * the subdivisions nested under it. Both spellings are addressable because
 * both are what a citation names. The narrowing rule and the anchor grammar
 * are the shared ones in `@stll/legal-ast`, read through the publisher's
 * scheme, rather than a second reading of the path here.
 *
 * Returns null when the consolidation carries no such anchor, which is how an
 * unknown anchor is told apart from a provision that exists and is empty. An
 * anchor in another publisher's grammar continues no heading, so it reads as
 * absent too.
 */
export const extractProvisionText = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): string | null => {
  // A provision heading first, because that is what the anchor usually is and
  // a heading anchor may itself contain a separator (`sec-1-a`): the anchor
  // grammar is not a reliable way to tell the two apart, but the document is.
  const owned =
    provisionBlocks(statute, anchorId) ??
    subdivisionBlocks(statute, {
      provisionAnchorId: enclosingHeadingAnchor(statute, anchorId) ?? anchorId,
      citedAnchorId: anchorId,
    });
  if (owned === null) {
    return null;
  }

  return owned
    .map((block) => block.plainText.trim())
    .filter((part) => part.length > 0)
    .join("\n");
};
