import type { Block } from "@stll/legal-ast/document-ast";
import { provisionBlocks } from "@stll/legal-ast/provision-preview";

/**
 * The text one provision owns: its heading, plus every block that follows
 * until a heading at the same or a shallower level opens the next provision.
 * Nested subdivisions stay inside, which is what a reader comparing two
 * consolidations of a section expects to see.
 *
 * Returns null when no heading carries the anchor, which is how an unknown
 * anchor is told apart from a provision that exists and is empty.
 */
export const extractProvisionText = (
  blocks: readonly Block[],
  anchorId: string,
): string | null => {
  const owned = provisionBlocks(blocks, anchorId);
  if (owned === null) {
    return null;
  }

  return owned
    .map((block) => block.plainText.trim())
    .filter((part) => part.length > 0)
    .join("\n");
};
