import type { Element, ElementData, Root, RootContent } from "hast";

type NumberedLinkData = ElementData & {
  /** The link's place among the links of the tree it was parsed in. */
  answerLinkOrdinal: number;
};

/**
 * Numbers the links of one parsed tree in document order. The number rides on
 * the node's `data`, which never reaches the DOM; the answer's link renderer
 * reads it (`answerLinkOrdinal`) to name the link's ids. A streamed answer
 * parses each block on its own, so a number is unique within its block, and a
 * settled answer parses once, so it is unique within the answer. Run last,
 * after every plugin that adds links.
 *
 * A `function` declaration keeps a stable plugin name for Streamdown's
 * processor cache.
 */
export function rehypeNumberAnswerLinks() {
  return (tree: Root) => {
    let ordinal = 0;
    const visit = (nodes: readonly RootContent[]) => {
      for (const node of nodes) {
        if (node.type !== "element") {
          continue;
        }
        if (node.tagName === "a") {
          const data: NumberedLinkData = {
            ...node.data,
            answerLinkOrdinal: ordinal,
          };
          node.data = data;
          ordinal += 1;
        }
        visit(node.children);
      }
    };
    visit(tree.children);
  };
}

/** The number `rehypeNumberAnswerLinks` gave a link, if it ran. */
export const answerLinkOrdinal = (
  link: Element | undefined,
): number | undefined => {
  const data = link?.data;
  return data !== undefined &&
    "answerLinkOrdinal" in data &&
    typeof data.answerLinkOrdinal === "number"
    ? data.answerLinkOrdinal
    : undefined;
};
