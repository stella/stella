import type { Element, ElementContent, Root, RootContent, Text } from "hast";

import { findSearchTextMatches } from "@/lib/document-search";

const SKIP_PARENT_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "pre",
  "script",
  "style",
]);

const isElement = (node: ElementContent | RootContent): node is Element =>
  node.type === "element";

const isText = (node: ElementContent | RootContent): node is Text =>
  node.type === "text";

type SearchMatchPluginOptions = {
  searchText: string;
};

export function rehypeSearchMatches(
  this: unknown,
  { searchText }: SearchMatchPluginOptions,
) {
  const splitTextNode = (text: Text): ElementContent[] => {
    const matches = findSearchTextMatches(text.value, searchText);
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
          ...(SKIP_PARENT_TAGS.has(parent.tagName)
            ? [child]
            : splitTextNode(child)),
        );
        continue;
      }
      if (isElement(child) && !SKIP_PARENT_TAGS.has(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    parent.children = next;
  };

  return (tree: Root) => {
    const next: RootContent[] = [];
    for (const child of tree.children) {
      if (isText(child)) {
        next.push(...splitTextNode(child));
        continue;
      }
      if (isElement(child) && !SKIP_PARENT_TAGS.has(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    tree.children = next;
    return tree;
  };
}
