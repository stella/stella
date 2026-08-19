import type { Block } from "@stll/legal-ast/document-ast";

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
  const start = blocks.findIndex(
    (block) => block.type === "heading" && block.anchorId === anchorId,
  );

  if (start === -1) {
    return null;
  }

  const heading = blocks.at(start);

  if (heading?.type !== "heading") {
    return null;
  }

  const parts: string[] = [heading.plainText];

  for (const block of blocks.slice(start + 1)) {
    if (block.type === "heading" && block.level <= heading.level) {
      break;
    }

    parts.push(block.plainText);
  }

  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
};
