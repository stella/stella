/**
 * The element vocabulary of Austria's RIS decision XML, and the one reader
 * of it.
 *
 * RIS spells characters as empty elements (`B<gdash/>VG`, `GmbH <amp/> Co`,
 * `KSV-Rating <lt/> 350`, `1<tab/>Der`), so reading an element's `.text()`
 * drops them silently. Every element the schema prints is listed in
 * {@link RIS_ELEMENTS} with what it contributes, so no element is handled by
 * accident. An element outside the table still contributes its text (a
 * decision missing a paragraph looks complete) and is returned by name, for
 * the caller to report. The retention projection keeps a table of its own on
 * purpose: it is the independent reading this one is checked against.
 */
import { panic } from "better-result";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

import type { DecisionTextFidelity } from "@stll/api-contract/case-law-text-field";
import type { Inline } from "@stll/legal-ast/document-ast";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";

import { sanitizeUrl } from "@/api/lib/sanitize-url";

type RisElementSpec =
  /** Wraps block elements; read child by child. */
  | { type: "container" }
  /** Printed page header or footer: not part of the decision. */
  | { type: "furniture" }
  | { type: "heading" }
  | { type: "paragraph" }
  /** The publisher's own paragraph separator. */
  | { type: "break" }
  /** A list marker (`1.`, `-`): printed, then a space before the item. */
  | { type: "label" }
  | {
      type: "mark";
      mark: "bold" | "italic" | "underline" | "superscript" | "subscript";
    }
  | { type: "link" }
  /** Typography with no inline of its own; its content is the text. */
  | { type: "transparent" }
  /** An empty element the schema prints as a character. */
  | { type: "character"; text: string }
  | { type: "line-break" }
  /** An empty marker (a section change, a docket-sheet placeholder). */
  | { type: "empty" };

export const RIS_ELEMENTS = {
  abschnitt: { type: "container" },
  liste: { type: "container" },
  ziffernliste: { type: "container" },
  strichliste: { type: "container" },
  kzinhalt: { type: "furniture" },
  fzinhalt: { type: "furniture" },
  ueberschrift: { type: "heading" },
  absatz: { type: "paragraph" },
  schluss: { type: "paragraph" },
  listelem: { type: "paragraph" },
  abstand: { type: "break" },
  symbol: { type: "label" },
  b: { type: "mark", mark: "bold" },
  i: { type: "mark", mark: "italic" },
  u: { type: "mark", mark: "underline" },
  super: { type: "mark", mark: "superscript" },
  sup: { type: "mark", mark: "superscript" },
  sub: { type: "mark", mark: "subscript" },
  link: { type: "link" },
  span: { type: "transparent" },
  feld: { type: "transparent" },
  gs: { type: "transparent" },
  gdash: { type: "character", text: "-" },
  amp: { type: "character", text: "&" },
  lt: { type: "character", text: "<" },
  gt: { type: "character", text: ">" },
  tab: { type: "character", text: " " },
  br: { type: "line-break" },
  aw: { type: "empty" },
  wechsel: { type: "empty" },
} as const satisfies Record<string, RisElementSpec>;

const RIS_SPECS = new Map<string, RisElementSpec>(Object.entries(RIS_ELEMENTS));

/** An element's spec, `undefined` for a name outside the vocabulary. */
const specOf = (name: string): RisElementSpec | undefined =>
  RIS_SPECS.get(name);

export const isRisElement = (name: string): boolean => RIS_SPECS.has(name);

/** One printed unit of a decision, in document order. */
export type RisItem =
  | { type: "heading"; inlines: Inline[] }
  | {
      type: "paragraph";
      /** `absatz` (a printed line or paragraph), `schluss` or `listelem`. */
      element: "absatz" | "schluss" | "listelem" | "text";
      contentType: string | undefined;
      /** The publisher's layout class; `pre` keeps its lines. */
      layout: string | undefined;
      inlines: Inline[];
    }
  | { type: "break" };

export type RisReading = {
  items: RisItem[];
  /** Element names outside {@link RIS_ELEMENTS}, in first-seen order. */
  unknownElements: string[];
};

const attr = (element: Element, name: string): string | undefined => {
  const value = element.attribs[name];
  return value === undefined || value === "" ? undefined : value;
};

type Reader = { unknown: Set<string> };

const wrap = (
  mark: Extract<RisElementSpec, { type: "mark" }>["mark"],
  children: Inline[],
): Inline => ({ type: mark, children });

const readInlineNodes = (nodes: readonly AnyNode[], reader: Reader): Inline[] =>
  nodes.flatMap((node): Inline[] => {
    if (isText(node)) {
      return node.data === "" ? [] : [{ type: "text", text: node.data }];
    }
    if (!isTag(node)) {
      return [];
    }
    const spec = specOf(node.name);
    if (spec === undefined) {
      reader.unknown.add(node.name);
      return readInlineNodes(node.children, reader);
    }
    switch (spec.type) {
      case "furniture":
      case "empty":
      case "break": {
        return [];
      }
      case "character": {
        return [{ type: "text", text: spec.text }];
      }
      case "line-break": {
        return [{ type: "line-break" }];
      }
      case "label": {
        return [
          ...readInlineNodes(node.children, reader),
          { type: "text", text: " " },
        ];
      }
      case "mark": {
        return [wrap(spec.mark, readInlineNodes(node.children, reader))];
      }
      case "link": {
        const children = readInlineNodes(node.children, reader);
        const href = sanitizeUrl(attr(node, "href") ?? "");
        return href === undefined || href === ""
          ? children
          : [{ type: "link", href, children }];
      }
      case "container":
      case "heading":
      case "paragraph":
      case "transparent": {
        return readInlineNodes(node.children, reader);
      }
      default: {
        spec satisfies never;
        return panic("Unhandled RIS element type");
      }
    }
  });

/**
 * Collapse whitespace across the whole inline tree (the XML prints no
 * layout whitespace of its own), trim both ends, and drop empty wrappers,
 * leading, trailing and repeated line breaks.
 */
export const normalizeInlineLayout = (inlines: readonly Inline[]): Inline[] => {
  let atStart = true;
  const walk = (nodes: readonly Inline[]): Inline[] => {
    const out: Inline[] = [];
    for (const node of nodes) {
      if (node.type === "text") {
        let text = node.text.replaceAll(/[\s\u00a0]+/gu, " ");
        if (atStart && text.startsWith(" ")) {
          text = text.slice(1);
        }
        if (text === "") {
          continue;
        }
        atStart = text.endsWith(" ");
        out.push({ ...node, text });
        continue;
      }
      if (node.type === "line-break") {
        const last = out.at(-1);
        if (last?.type === "line-break") {
          continue;
        }
        atStart = true;
        out.push(node);
        continue;
      }
      if (hasInlineChildren(node)) {
        const children = walk(node.children);
        if (children.length > 0) {
          out.push({ ...node, children });
        }
        continue;
      }
      out.push(node);
    }
    return out;
  };
  const walked = walk(inlines);
  return trimEnd(trimStart(walked));
};

const trimStart = (nodes: Inline[]): Inline[] => {
  const first = nodes.at(0);
  if (first === undefined) {
    return nodes;
  }
  if (first.type === "line-break") {
    return trimStart(nodes.slice(1));
  }
  return nodes;
};

const trimEnd = (nodes: Inline[]): Inline[] => {
  const last = nodes.at(-1);
  if (last === undefined) {
    return nodes;
  }
  if (last.type === "line-break") {
    return trimEnd(nodes.slice(0, -1));
  }
  if (last.type === "text") {
    const text = last.text.trimEnd();
    return text === ""
      ? trimEnd(nodes.slice(0, -1))
      : [...nodes.slice(0, -1), { ...last, text }];
  }
  if (hasInlineChildren(last)) {
    const children = trimEnd(last.children);
    return children.length === 0
      ? trimEnd(nodes.slice(0, -1))
      : [...nodes.slice(0, -1), { ...last, children }];
  }
  return nodes;
};

const pushBlock = (items: RisItem[], item: RisItem): void => {
  if (item.type === "break") {
    items.push(item);
    return;
  }
  const inlines = normalizeInlineLayout(item.inlines);
  if (inlines.length > 0) {
    items.push({ ...item, inlines });
  }
};

const isBlockElement = (node: AnyNode): boolean => {
  if (!isTag(node)) {
    return false;
  }
  const type = specOf(node.name)?.type;
  return (
    type === "container" ||
    type === "heading" ||
    type === "paragraph" ||
    type === "break"
  );
};

const readBlocks = (
  nodes: readonly AnyNode[],
  reader: Reader,
  items: RisItem[],
): void => {
  for (const node of nodes) {
    if (!isTag(node)) {
      if (isText(node)) {
        pushBlock(items, {
          type: "paragraph",
          element: "text",
          contentType: undefined,
          layout: undefined,
          inlines: readInlineNodes([node], reader),
        });
      }
      continue;
    }
    const spec = specOf(node.name);
    if (spec === undefined) {
      reader.unknown.add(node.name);
      const holdsBlock = node.children.some(isBlockElement);
      if (holdsBlock) {
        readBlocks(node.children, reader, items);
        continue;
      }
    }
    switch (spec?.type) {
      case "furniture":
      case "empty": {
        break;
      }
      case "container": {
        readBlocks(node.children, reader, items);
        break;
      }
      case "break": {
        items.push({ type: "break" });
        break;
      }
      case "heading": {
        pushBlock(items, {
          type: "heading",
          inlines: readInlineNodes(node.children, reader),
        });
        break;
      }
      case "paragraph": {
        const element = node.name;
        pushBlock(items, {
          type: "paragraph",
          element:
            element === "schluss" || element === "listelem"
              ? element
              : "absatz",
          contentType: attr(node, "ct"),
          layout: attr(node, "typ"),
          inlines: readInlineNodes(node.children, reader),
        });
        break;
      }
      case "label":
      case "mark":
      case "link":
      case "transparent":
      case "character":
      case "line-break":
      case undefined: {
        pushBlock(items, {
          type: "paragraph",
          element: "text",
          contentType: undefined,
          layout: undefined,
          inlines: readInlineNodes([node], reader),
        });
        break;
      }
      default: {
        spec satisfies never;
        panic("Unhandled RIS element type");
      }
    }
  }
};

/** Read the children of a `nutzdaten` element as printed units. */
export const readRisContent = (content: Element): RisReading => {
  const reader: Reader = { unknown: new Set() };
  const items: RisItem[] = [];
  readBlocks(content.children, reader, items);
  return { items, unknownElements: [...reader.unknown] };
};

const NON_SPACE = /[^\s\u00a0]/gu;

const nonSpaceChars = (text: string): string =>
  (text.match(NON_SPACE) ?? []).join("");

const sourceNonSpace = (node: AnyNode): string => {
  if (isText(node)) {
    return nonSpaceChars(node.data);
  }
  if (!isTag(node)) {
    return "";
  }
  const spec = specOf(node.name);
  if (spec?.type === "furniture") {
    return "";
  }
  if (spec?.type === "character") {
    return nonSpaceChars(spec.text);
  }
  let printed = "";
  for (const child of node.children) {
    printed += sourceNonSpace(child);
  }
  return printed;
};

const inlineNonSpace = (inlines: readonly Inline[]): string => {
  let read = "";
  for (const node of inlines) {
    if (node.type === "text") {
      read += nonSpaceChars(node.text);
    } else if (hasInlineChildren(node)) {
      read += inlineNonSpace(node.children);
    }
  }
  return read;
};

/** How many characters of `left` have no counterpart in `right`. */
const surplusChars = (left: string, right: string): number => {
  const counts = new Map<string, number>();
  for (const char of right) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let surplus = 0;
  for (const char of left) {
    const remaining = counts.get(char) ?? 0;
    if (remaining === 0) {
      surplus += 1;
      continue;
    }
    counts.set(char, remaining - 1);
  }
  return surplus;
};

/**
 * Compare the non-space characters the publisher printed (text, and what its
 * empty character elements print) with those `items` carry. A difference is
 * a typed marker for the caller to store beside the decision, never a
 * reason to withhold it.
 */
export const risTextFidelity = (
  content: Element,
  items: readonly RisItem[],
): DecisionTextFidelity | undefined => {
  let printed = "";
  for (const child of content.children) {
    printed += sourceNonSpace(child);
  }
  let read = "";
  for (const item of items) {
    if (item.type !== "break") {
      read += inlineNonSpace(item.inlines);
    }
  }
  return orderedFidelity(printed, read);
};

/** Where two character sequences first differ; the shorter length if one extends the other. */
const firstDifference = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return length;
};

/**
 * The reading matches only when it carries the printed non-space characters
 * in the printed order. Counts say how many characters are missing or added;
 * equal counts in another order are `reordered`, never a match.
 */
const orderedFidelity = (
  printed: string,
  read: string,
): DecisionTextFidelity | undefined => {
  if (printed === read) {
    return undefined;
  }
  const missingChars = surplusChars(printed, read);
  const extraChars = surplusChars(read, printed);
  return {
    status: missingChars === 0 && extraChars === 0 ? "reordered" : "mismatch",
    missingChars,
    extraChars,
    firstDifferenceAt: firstDifference(printed, read),
  };
};

/** The same comparison for text already reduced to its characters. */
export const compareTextFidelity = (
  printed: string,
  read: string,
): DecisionTextFidelity | undefined =>
  orderedFidelity(nonSpaceChars(printed), nonSpaceChars(read));
