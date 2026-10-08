import { panic } from "better-result";

import type { Block as DocumentBlock } from "./document-ast.js";
import type { StatuteBlock } from "./statute-ast.js";

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
  let currentPath: readonly HeadingPathEntry[] = Object.freeze([]);
  for (const block of blocks) {
    if (block.type !== "heading") {
      paths.set(block.anchorId, currentPath);
      continue;
    }
    const previousDepth = headings.length;
    let parent = headings.at(-1);
    while (parent !== undefined && parent.level >= block.level) {
      headings.pop();
      parent = headings.at(-1);
    }
    if (headings.length !== previousDepth) {
      currentPath = Object.freeze(headings.map(({ entry }) => entry));
    }
    paths.set(block.anchorId, currentPath);
    headings.push({
      level: block.level,
      entry: Object.freeze({
        anchorId: block.anchorId,
        title: block.plainText,
      }),
    });
    currentPath = Object.freeze(headings.map(({ entry }) => entry));
  }
  return paths;
};

/** Explicit provision ancestry; provision anchors exclude themselves. */
export const statuteHeadingPathsByAnchor = (
  blocks: readonly StatuteBlock[],
): ReadonlyMap<string, readonly HeadingPathEntry[]> => {
  const paths = new Map<string, readonly HeadingPathEntry[]>();
  const visit = (
    children: readonly StatuteBlock[],
    ancestors: readonly HeadingPathEntry[],
  ) => {
    for (const block of children) {
      switch (block.type) {
        case "provision": {
          paths.set(block.anchorId, ancestors);
          const path = Object.freeze([
            ...ancestors,
            Object.freeze({ anchorId: block.anchorId, title: block.plainText }),
          ]);
          visit(block.children, path);
          break;
        }
        case "list":
          paths.set(block.anchorId, ancestors);
          for (const item of block.items) {
            visit(item.children, ancestors);
          }
          break;
        case "paragraph":
        case "table":
          paths.set(block.anchorId, ancestors);
          break;
        case "footnote":
        case "edit":
          break;
        default: {
          block satisfies never;
          return panic("Unhandled statute block");
        }
      }
    }
  };
  visit(blocks, Object.freeze([]));
  return paths;
};
