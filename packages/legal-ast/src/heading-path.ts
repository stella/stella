import type { Block as DocumentBlock } from "./document-ast.js";

export type HeadingPathEntry = {
  readonly anchorId: string;
  readonly title: string;
};

/** Verbatim enclosing headings; a heading's own anchor excludes itself. */
export const headingPathsByAnchor = (
  blocks: readonly DocumentBlock[],
): ReadonlyMap<string, readonly HeadingPathEntry[]> => {
  const paths = new Map<string, readonly HeadingPathEntry[]>();
  const headings: { level: number; entry: HeadingPathEntry }[] = [];
  for (const block of blocks) {
    if (block.type !== "heading") {
      paths.set(
        block.anchorId,
        headings.map(({ entry }) => entry),
      );
      continue;
    }
    let parent = headings.at(-1);
    while (parent !== undefined && parent.level >= block.level) {
      headings.pop();
      parent = headings.at(-1);
    }
    paths.set(
      block.anchorId,
      headings.map(({ entry }) => entry),
    );
    headings.push({
      level: block.level,
      entry: { anchorId: block.anchorId, title: block.plainText },
    });
  }
  return paths;
};
