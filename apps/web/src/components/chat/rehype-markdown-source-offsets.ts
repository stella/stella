import type { Element, Root } from "hast";

import { markdownTextLeaves } from "@/components/chat/markdown-selection.logic";

/** Stamp existing leaf elements and wrap only mixed text siblings. Keeping link
 * and code children as strings preserves their custom renderer contracts. */
export const rehypeMarkdownSourceOffsets =
  () => (tree: Root, file: { value: unknown }) => {
    if (typeof file.value !== "string") {
      return;
    }
    const leaves = new Map(
      markdownTextLeaves(file.value).map((leaf) => [leaf.sourceStart, leaf]),
    );
    const textLeaf = (
      child: Root["children"][number],
      parent: Root | Element,
    ) => {
      if (child.type !== "text" || !child.value) {
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
    const visit = (parent: Root | Element) => {
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
        const leaf = onlyChild ? textLeaf(onlyChild, parent) : undefined;
        if (leaf) {
          parent.properties = { ...parent.properties, ...propertiesFor(leaf) };
          return;
        }
      }
      parent.children = parent.children.map((child) => {
        if (child.type === "element") {
          visit(child);
          return child;
        }
        const leaf = textLeaf(child, parent);
        if (!leaf) {
          return child;
        }
        return {
          type: "element",
          tagName: "span",
          properties: propertiesFor(leaf),
          children: [child],
        } satisfies Element;
      });
    };
    visit(tree);
  };
