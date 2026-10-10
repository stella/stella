import type { Element, Root, Text } from "hast";

import { markdownTextLeaves } from "@/components/chat/markdown-selection.logic";

/** Anchor text spans independently of renderers that may drop element props.
 * Link and code children stay strings to preserve citation renderer contracts. */
export const rehypeMarkdownSourceOffsets =
  () => (tree: Root, file: { value: unknown }) => {
    if (typeof file.value !== "string") {
      return;
    }
    const leaves = new Map(
      markdownTextLeaves(file.value).map((leaf) => [leaf.sourceStart, leaf]),
    );
    const textLeaf = (child: Text, parent: Root | Element) => {
      if (!child.value) {
        return undefined;
      }
      const position = child.position ?? parent.position;
      const start = position?.start.offset;
      const end = position?.end.offset;
      if (start === undefined || end === undefined) {
        return undefined;
      }
      const leaf = leaves.get(start);
      return leaf && leaf.text === child.value && leaf.sourceEnd === end
        ? leaf
        : undefined;
    };
    const propertiesFor = (leaf: NonNullable<ReturnType<typeof textLeaf>>) => ({
      "data-src-start": leaf.offsets.at(0),
      "data-src-end": leaf.offsets.at(-1),
      "data-src-offsets": leaf.offsets.join(","),
    });
    const visit = (parent: Root | Element): Element | undefined => {
      if (parent.type === "element") {
        // Source markup cannot supply selection anchors; only this pass owns
        // them, after parsing and sanitization have completed.
        parent.properties = Object.fromEntries(
          Object.entries(parent.properties).filter(
            ([property]) => !/^data(?:-src-|Src)/u.test(property),
          ),
        );
        const onlyChild =
          parent.children.length === 1 ? parent.children.at(0) : undefined;
        const leaf =
          onlyChild?.type === "text" ? textLeaf(onlyChild, parent) : undefined;
        if (leaf) {
          if (parent.tagName === "a") {
            return {
              type: "element",
              tagName: "span",
              properties: propertiesFor(leaf),
              children: [parent],
            };
          }
          if (parent.tagName === "code") {
            parent.properties = {
              ...parent.properties,
              ...propertiesFor(leaf),
            };
            return;
          }
        }
      }
      for (const [index, child] of parent.children.entries()) {
        if (child.type === "doctype" || child.type === "raw") {
          continue;
        }
        if (child.type === "element") {
          const anchored = visit(child);
          if (anchored) {
            parent.children[index] = anchored;
          }
          continue;
        }
        if (child.type !== "text") {
          continue;
        }
        const leaf = textLeaf(child, parent);
        if (!leaf) {
          continue;
        }
        parent.children[index] = {
          type: "element",
          tagName: "span",
          properties: propertiesFor(leaf),
          children: [child],
        } satisfies Element;
      }
    };
    visit(tree);
  };
