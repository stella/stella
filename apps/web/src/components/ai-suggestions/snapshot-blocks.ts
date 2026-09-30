import { panic } from "better-result";

import type { FolioAIEditSnapshot } from "@stll/folio-react";

/**
 * Snapshot blocks as sent to the model: each carries folio's normalized text
 * hash so the model can echo it as `precondition.blockTextHash` on a
 * `suggest_changes` operation. folio then skips an edit whose block changed
 * between this snapshot and the apply instead of landing it on other text.
 */
export const withBlockTextHashes = (snapshot: FolioAIEditSnapshot) =>
  snapshot.blocks.flatMap((block) => {
    const { kind } = block;
    switch (kind) {
      case "diagnostic":
        // Opaque carriers are read-only and cannot be addressed by edit tools.
        return [];
      case "heading":
      case "listItem":
      case "paragraph": {
        const textHash = snapshot.anchors[block.id]?.textHash;
        return [
          textHash === undefined
            ? { ...block, kind }
            : { ...block, kind, blockTextHash: textHash },
        ];
      }
      default:
        kind satisfies never;
        return panic(`Unhandled snapshot block kind: ${String(kind)}`);
    }
  });
