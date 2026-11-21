import type { Element, ElementContent, Root, Text } from "hast";

import { trimAnchoredTextWhitespace } from "@/components/chat/rehype-markdown-source-offsets";
import { LEAD_IN_MAX_LENGTH } from "@/components/references/citation-lead-in.logic";

/**
 * The link property carrying the prose just before a link, which an inline
 * citation reads to tell whether the answer already named its court
 * (`leadInNamesCourt`). React receives it as `data-lead-in`.
 */
const CITATION_LEAD_IN_PROPERTY = "dataLeadIn";
export const CITATION_LEAD_IN_ATTRIBUTE = "data-lead-in";

// Elements a sentence runs through; anything else (a paragraph, a list item,
// a cell, a heading) ends the prose a link can be introduced by.
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "del",
  "em",
  "i",
  "ins",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["code", "pre"]);

type Parent = Root | Element;

const textOf = (node: ElementContent): string => {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type !== "element") {
    return "";
  }
  return node.children.map(textOf).join("");
};

const isInline = (parent: Parent): parent is Element =>
  parent.type === "element" && INLINE_ELEMENTS.has(parent.tagName);

/** The prose before `node` inside its sentence's block, closest last. */
const leadInOf = (node: ElementContent, ancestors: readonly Parent[]) => {
  let text = "";
  let current: ElementContent = node;
  for (let level = ancestors.length - 1; level >= 0; level -= 1) {
    const parent = ancestors[level];
    if (parent === undefined) {
      break;
    }
    const index = parent.children.indexOf(current);
    for (let sibling = index - 1; sibling >= 0; sibling -= 1) {
      const child = parent.children[sibling];
      if (child === undefined || child.type === "doctype") {
        continue;
      }
      text = `${textOf(child)}${text}`;
      if (text.length >= LEAD_IN_MAX_LENGTH) {
        return text.slice(-LEAD_IN_MAX_LENGTH);
      }
    }
    if (!isInline(parent)) {
      break;
    }
    current = parent;
  }
  return text;
};

type TextSite = { text: Text; parent: Parent };

/** The text node right next to `node` on one side, within its block. */
const adjacentText = (
  node: ElementContent,
  ancestors: readonly Parent[],
  side: "before" | "after",
): TextSite | undefined => {
  const edgeText = (child: ElementContent, parent: Parent): TextSite | null => {
    if (child.type === "text") {
      return { text: child, parent };
    }
    if (child.type !== "element" || !INLINE_ELEMENTS.has(child.tagName)) {
      return null;
    }
    const inner =
      side === "before" ? child.children.at(-1) : child.children.at(0);
    return inner === undefined ? null : edgeText(inner, child);
  };
  let current: ElementContent = node;
  for (let level = ancestors.length - 1; level >= 0; level -= 1) {
    const parent = ancestors[level];
    if (parent === undefined) {
      return undefined;
    }
    const index = parent.children.indexOf(current);
    const neighbour =
      side === "before"
        ? parent.children[index - 1]
        : parent.children[index + 1];
    if (neighbour !== undefined && neighbour.type !== "doctype") {
      return edgeText(neighbour, parent) ?? undefined;
    }
    if (!isInline(parent)) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
};

const OPENS_PARENTHESIS = /\(\s*$/u;
const CLOSES_PARENTHESIS = /^\s*\)/u;

/**
 * A link written inside parentheses keeps them tight: "( [§ 240](…) )" reads
 * "(§ 240)". Only whitespace goes, and only between a bracket and the link,
 * so the answer's words and punctuation stay as written.
 */
const tightenParentheses = (link: Element, ancestors: readonly Parent[]) => {
  const before = adjacentText(link, ancestors, "before");
  const after = adjacentText(link, ancestors, "after");
  if (
    before === undefined ||
    after === undefined ||
    !OPENS_PARENTHESIS.test(before.text.value) ||
    !CLOSES_PARENTHESIS.test(after.text.value)
  ) {
    return;
  }
  trimAnchoredTextWhitespace(before.text, before.parent, "end");
  trimAnchoredTextWhitespace(after.text, after.parent, "start");
};

/**
 * Gives every link the prose that introduces it and tightens the parentheses
 * around it. Runs after the source-offset pass, whose anchors it keeps.
 */
export const rehypeCitationLeadIn = () => (tree: Root) => {
  const visit = (parent: Parent, ancestors: readonly Parent[]) => {
    const chain = [...ancestors, parent];
    for (const child of parent.children) {
      if (child.type !== "element" || SKIPPED_ELEMENTS.has(child.tagName)) {
        continue;
      }
      if (child.tagName === "a") {
        tightenParentheses(child, chain);
        const leadIn = leadInOf(child, chain);
        child.properties = {
          ...child.properties,
          [CITATION_LEAD_IN_PROPERTY]: leadIn,
        };
        continue;
      }
      visit(child, chain);
    }
  };
  visit(tree, []);
};
