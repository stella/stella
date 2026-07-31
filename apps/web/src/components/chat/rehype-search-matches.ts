import type { Element, ElementContent, Root, RootContent, Text } from "hast";

import { findSearchTextMatches } from "@/lib/document-search";
import type { SearchTextQuery } from "@/lib/search-text";

const skipsSearchHighlight = (tagName: string): boolean =>
  tagName === "script" || tagName === "style";

const isElement = (node: ElementContent | RootContent): node is Element =>
  node.type === "element";

const isText = (node: ElementContent | RootContent): node is Text =>
  node.type === "text";

type SearchMatchPluginOptions = {
  maxMatches: number;
  searchText: SearchTextQuery;
};

export function rehypeSearchMatches(
  this: unknown,
  { maxMatches, searchText }: SearchMatchPluginOptions,
) {
  return (tree: Root) => {
    let remainingMatches = Math.max(0, Math.floor(maxMatches));
    const splitTextNode = (text: Text): ElementContent[] => {
      if (remainingMatches <= 0) {
        return [text];
      }
      const matches = findSearchTextMatches(text.value, searchText, {
        maxMatches: remainingMatches,
      });
      remainingMatches -= matches.length;
      if (matches.length === 0) {
        return [text];
      }

      const result: ElementContent[] = [];
      let offset = 0;
      for (const match of matches) {
        if (match.start > offset) {
          result.push({
            type: "text",
            value: text.value.slice(offset, match.start),
          });
        }
        result.push({
          type: "element",
          tagName: "mark",
          properties: { "data-search-match": "true" },
          children: [
            { type: "text", value: text.value.slice(match.start, match.end) },
          ],
        });
        offset = match.end;
      }
      if (offset < text.value.length) {
        result.push({ type: "text", value: text.value.slice(offset) });
      }
      return result;
    };

    const walkElement = (parent: Element) => {
      const next: ElementContent[] = [];
      for (const child of parent.children) {
        if (isText(child)) {
          next.push(
            ...(skipsSearchHighlight(parent.tagName)
              ? [child]
              : splitTextNode(child)),
          );
          continue;
        }
        if (isElement(child) && !skipsSearchHighlight(child.tagName)) {
          walkElement(child);
        }
        next.push(child);
      }
      parent.children = next;
    };

    const next: RootContent[] = [];
    for (const child of tree.children) {
      if (isText(child)) {
        next.push(...splitTextNode(child));
        continue;
      }
      if (isElement(child) && !skipsSearchHighlight(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    tree.children = next;
    return tree;
  };
}
