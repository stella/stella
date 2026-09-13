import type { Block } from "@stll/legal-ast/document-ast";
import {
  provisionHeadingChain,
  provisionPreviewBlocks,
} from "@stll/legal-ast/provision-preview";

import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** What a preview needs about the consolidation it was read from. */
type PreviewVersionRow = {
  id: SafeId<"legislationDocument">;
  language: string;
};

type ProvisionPreviewInput = {
  version: PreviewVersionRow;
  blocks: readonly Block[];
  anchor: string;
  citedAnchor: string | undefined;
};

/** The columns a preview response is built from, for a caller's own select. */
export const previewVersionColumns = {
  id: legislationDocuments.id,
  language: legislationDocuments.language,
};

const previewBlock = (block: Block) => ({
  id: block.id,
  anchorId: block.anchorId,
  text: block.plainText,
});

/**
 * One provision's wording, small enough to hover over: the consolidation it
 * was read from, the headings enclosing it, and only the blocks the citation
 * points at. The consolidation's own metadata stays on the reads that address
 * it; a preview carries only the language its text renders in.
 *
 * `blocks` is empty when the consolidation does not carry the anchor, which
 * is a real answer about that version rather than a failure.
 */
export const buildProvisionPreview = ({
  version,
  blocks,
  anchor,
  citedAnchor,
}: ProvisionPreviewInput) => {
  const cited = provisionPreviewBlocks(blocks, anchor, citedAnchor);
  const chain = provisionHeadingChain(blocks, anchor);

  return {
    documentId: version.id,
    language: version.language,
    anchorId: anchor,
    citedAnchorId: citedAnchor ?? null,
    headings:
      chain === null
        ? []
        : chain.map((heading) => ({
            anchorId: heading.anchorId,
            level: heading.level,
            text: heading.plainText,
          })),
    blocks: cited === null ? [] : cited.map(previewBlock),
  };
};

/** The wording one citation preview shows. */
export type ProvisionPreview = ReturnType<typeof buildProvisionPreview>;
