import type { Element, Root, RootContent } from "hast";

import { CHAT_LINK_ATTRIBUTES } from "./link";
import { detectChatLinks } from "./link-detection";

const SKIPPED_ELEMENTS = new Set(["a", "code", "pre", "stll-anon"]);

/** Run after sanitization and source-offset anchoring; existing links keep their renderer contract. */
export const rehypeChatLinks = () => (tree: Root) => {
  const visit = (parent: Root | Element) => {
    if (parent.type === "element" && SKIPPED_ELEMENTS.has(parent.tagName)) {
      return;
    }
    const children: RootContent[] = [];
    for (const child of parent.children) {
      if (child.type === "element") {
        visit(child);
      }
      if (child.type !== "text") {
        children.push(child);
        continue;
      }
      const links = detectChatLinks(child.value);
      if (!links.length) {
        children.push(child);
        continue;
      }
      let offset = 0;
      for (const link of links) {
        if (link.start > offset) {
          children.push({
            type: "text",
            value: child.value.slice(offset, link.start),
          });
        }
        children.push({
          type: "element",
          tagName: "a",
          properties: {
            href: link.href,
            target: CHAT_LINK_ATTRIBUTES.target,
            rel: CHAT_LINK_ATTRIBUTES.rel.split(" "),
          },
          children: [{ type: "text", value: link.text }],
        });
        offset = link.end;
      }
      if (offset < child.value.length) {
        children.push({ type: "text", value: child.value.slice(offset) });
      }
    }
    if (parent.type === "root") {
      parent.children = children;
    } else {
      parent.children = children.filter((child) => child.type !== "doctype");
    }
  };
  visit(tree);
};
