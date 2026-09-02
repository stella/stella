import type { FolioAIEditSnapshot } from "@stll/folio-react";

/**
 * Snapshot blocks as sent to the model: each carries folio's normalized text
 * hash so the model can echo it as `precondition.blockTextHash` on a
 * `suggest_changes` operation. folio then skips an edit whose block changed
 * between this snapshot and the apply instead of landing it on other text.
 */
export const withBlockTextHashes = (snapshot: FolioAIEditSnapshot) =>
  snapshot.blocks.map((block) => {
    const textHash = snapshot.anchors[block.id]?.textHash;
    return textHash === undefined
      ? block
      : { ...block, blockTextHash: textHash };
  });
