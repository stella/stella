/**
 * Subordinate headings a publisher marks with a leading dash.
 *
 * A CJEU judgment answers each ground of appeal (or each question) under the
 * same pair of subheadings, `– Arguments of the parties` and `– Findings of
 * the Court`, and marks them as subordinate by the dash alone. Stored at the
 * level of the heading they belong under, they read as siblings of it: the
 * reader's contents list the pair once per ground with nothing to tell the
 * copies apart, and the breadcrumb leaves out which ground is being read. The
 * reader nests each one under the nearest heading before it that has no
 * dash. Storage keeps the levels the source gave.
 */

import type { Block, HeadingLevel } from "./document-ast.js";

/** The dash a publisher sets before a subordinate heading. */
const SUBHEADING_DASH = /^\s*[–—-]\s+\S/u;

const ONE_LEVEL_DEEPER = {
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 6,
} as const satisfies Record<HeadingLevel, HeadingLevel>;

/** Whether a heading's own text marks it as subordinate. */
export const isDashSubheading = (title: string): boolean =>
  SUBHEADING_DASH.test(title);

/**
 * The blocks with every dash-led heading one level below the nearest heading
 * before it that has no dash, where its stored level does not already place
 * it there. Every other block is returned as it is.
 */
export const withDashSubheadingLevels = (blocks: readonly Block[]): Block[] => {
  let parentLevel: HeadingLevel | undefined;
  return blocks.map((block) => {
    if (block.type !== "heading") {
      return block;
    }
    if (!isDashSubheading(block.plainText)) {
      parentLevel = block.level;
      return block;
    }
    if (parentLevel === undefined || block.level > parentLevel) {
      return block;
    }
    return { ...block, level: ONE_LEVEL_DEEPER[parentLevel] };
  });
};
