import type { Block, HeadingBlock } from "@stll/legal-ast/document-ast";
import type { OutlineItem } from "@stll/ui/components/outline-rail";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";

/**
 * Outline over a document's own headings, for the shared rail.
 *
 * The rail nests by `level`, and it wants a dense depth rather than the AST's
 * 1..6: a document that uses only levels 1, 2 and 6 has three tiers, not six,
 * and indenting the third one five steps in would read as a broken tree. The
 * levels present are therefore mapped onto 0, 1, 2 in order.
 */

/**
 * Depth from which a statute outline starts folded. The top two container
 * tiers stay open as the map of the act; everything under them is one entry
 * per section, which is thousands of rows for a code, so it unfolds along the
 * chain the reader is actually in.
 */
export const STATUTE_OUTLINE_COLLAPSE_LEVEL = 2;

/**
 * The two lines a publisher states for one heading: the designation that
 * names the division, and the title that says what it contains. They arrive
 * as one heading split by a line break, in whichever order the parser read
 * them, so the first line leads and the second annotates.
 */
type HeadingLines = {
  label: string;
  secondary: string | undefined;
};

const headingLines = (block: HeadingBlock): HeadingLines | null => {
  const lines = inlinesToPlainText(block.inlines)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [label, ...rest] = lines;

  if (label === undefined) {
    return null;
  }

  const secondary = rest.join(" ");

  return { label, secondary: secondary.length > 0 ? secondary : undefined };
};

export const outlineFromHeadings = (
  blocks: readonly Block[],
): OutlineItem[] => {
  const headings = blocks.filter((block) => block.type === "heading");
  const depthByLevel = new Map(
    [...new Set(headings.map((heading) => heading.level))]
      .sort((a, b) => a - b)
      .map((level, depth) => [level, depth]),
  );
  const items: OutlineItem[] = [];

  for (const heading of headings) {
    const lines = headingLines(heading);
    const depth = depthByLevel.get(heading.level);

    if (lines === null || depth === undefined) {
      continue;
    }

    items.push({
      id: heading.anchorId,
      label: lines.label,
      level: depth,
      ...(lines.secondary === undefined ? {} : { meta: lines.secondary }),
    });
  }

  return items;
};

/**
 * The members of a scroll container an anchor jump needs. Narrower than
 * `HTMLElement` so the arithmetic below can be exercised without a DOM.
 */
type ClientTop = { top: number };

export type AnchorScrollContainer = {
  querySelector: (
    selector: string,
  ) => { getBoundingClientRect: () => ClientTop } | null;
  getBoundingClientRect: () => ClientTop;
  scrollTop: number;
  scrollHeight: number;
  scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void;
};

const offsetWithin = (
  anchorId: string,
  container: AnchorScrollContainer,
): number | null => {
  const target = container.querySelector(`#${CSS.escape(anchorId)}`);

  if (target === null) {
    return null;
  }

  return (
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
};

/** Vertical position of an anchored block, as the rail's 0-100 percentage. */
export const resolveAnchorPct = (
  anchorId: string,
  container: AnchorScrollContainer,
): number | null => {
  if (container.scrollHeight <= 0) {
    return null;
  }

  const top = offsetWithin(anchorId, container);

  return top === null
    ? null
    : Math.min(99, Math.max(1, (top / container.scrollHeight) * 100));
};

/**
 * Scroll an anchored block into view and put its anchor in the URL.
 *
 * The hash is set first and by assignment, not `replaceState`: it is what
 * makes `:target` fire and what the reader copies out of the address bar, so
 * a jump and a followed permalink leave the page in the same state. The
 * container scroll then overrides whatever the browser did with the hash.
 */
export const jumpToAnchor = (
  anchorId: string,
  container: AnchorScrollContainer,
): void => {
  const top = offsetWithin(anchorId, container);

  if (top === null) {
    return;
  }

  window.location.hash = anchorId;
  container.scrollTo({ top, behavior: "instant" });
};
