import type { Block as DocumentBlock } from "./document-ast.js";

/** Verbatim enclosing titles; a heading's own anchor includes that heading. */
export const headingPathsByAnchor = (
  blocks: readonly DocumentBlock[],
): ReadonlyMap<string, readonly string[]> => {
  const paths = new Map<string, readonly string[]>();
  const headings: { level: number; title: string }[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      let parent = headings.at(-1);
      while (parent !== undefined && parent.level >= block.level) {
        headings.pop();
        parent = headings.at(-1);
      }
      headings.push({ level: block.level, title: block.plainText });
    }
    paths.set(
      block.anchorId,
      headings.map(({ title }) => title),
    );
  }
  return paths;
};
