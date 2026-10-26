// parser-output-unchanged: moved unchanged from shared-inlines.ts; the visible-text walk and excluded tags are the same.
import type * as cheerio from "cheerio";
import { type AnyNode, hasChildren, isTag, isText } from "domhandler";

const EXCLUDED_HTML_TAGS = ["script", "style"];

/** Selector for removing the same non-content elements before a DOM walk. */
export const EXCLUDED_HTML_SELECTOR = "script, style";

/** Content outside the decision text axis. */
export const isExcludedHtmlTag = (tag: string): boolean =>
  EXCLUDED_HTML_TAGS.includes(tag);

/**
 * Read text without mutating the source DOM or retaining non-content tags.
 *
 * A walk rather than clone-and-remove: cheerio's `.find()` dedupes its
 * context of N children pairwise, which is quadratic on a wrapper holding
 * tens of thousands of paragraphs.
 */
export const visibleHtmlText = (el: cheerio.Cheerio<AnyNode>): string => {
  let text = "";
  const pending = el.toArray().toReversed();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isText(node)) {
      text += node.data;
      continue;
    }
    if (!hasChildren(node) || (isTag(node) && isExcludedHtmlTag(node.name))) {
      continue;
    }
    for (const child of node.children.toReversed()) {
      pending.push(child);
    }
  }
  return text;
};
