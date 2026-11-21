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
            return undefined;
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
      return undefined;
    };
    visit(tree);
  };

const SOURCE_OFFSETS_PROPERTY = "data-src-offsets";

/**
 * Drops whitespace from one end of a text node that a later pass tidies (the
 * space inside "( [§ 240](…) )"), keeping the anchors of the span this pass
 * stamped around it true: the span's offsets lose the dropped characters, so
 * every rendered character still maps to its own place in the source.
 */
export const trimAnchoredTextWhitespace = (
  text: Text,
  parent: Root | Element,
  side: "start" | "end",
) => {
  const trimmed =
    side === "start" ? text.value.trimStart() : text.value.trimEnd();
  const removed = text.value.length - trimmed.length;
  if (removed === 0) {
    return;
  }
  const raw =
    parent.type === "element"
      ? parent.properties[SOURCE_OFFSETS_PROPERTY]
      : undefined;
  if (parent.type === "element" && raw !== undefined) {
    const offsets = String(raw).split(",").map(Number);
    // Stamped spans hold exactly one text leaf; anything else is not this
    // pass's span and keeps its text.
    if (
      parent.children.length !== 1 ||
      offsets.length !== text.value.length + 1
    ) {
      return;
    }
    const kept =
      side === "start"
        ? offsets.slice(removed)
        : offsets.slice(0, offsets.length - removed);
    parent.properties = {
      ...parent.properties,
      "data-src-start": kept.at(0),
      "data-src-end": kept.at(-1),
      [SOURCE_OFFSETS_PROPERTY]: kept.join(","),
    };
  }
  text.value = trimmed;
};
