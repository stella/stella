import type { Element, ElementContent, Root, RootContent, Text } from "hast";

/**
 * One legal citation an answer makes, as the server resolved it: the words
 * the answer cites with (`§ 52 písm. g) ZP`, `č. j. 3 Afs 41/2008 - 98`) and
 * the page they open.
 */
export type LegalCitationLinkPair = {
  text: string;
  url: string;
};

/**
 * Wraps each resolved citation in prose in a plain `<a href>`, so the chat's
 * own link rendering draws it like any other statute or decision link the
 * answer carries. Only text nodes are split and no character is added or
 * dropped: the rendered text is the answer as written.
 *
 * Text already inside a link, a button, code or a non-prose container is left
 * alone: a citation the model linked itself keeps its own target, and a
 * docket quoted in a code block stays code.
 */

const SKIP_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "code",
  "pre",
  "script",
  "stll-anon",
  "style",
]);

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|]/gu;

const escapeRegex = (value: string) => value.replaceAll(REGEX_SPECIALS, "\\$&");

const isElement = (node: ElementContent | RootContent): node is Element =>
  node.type === "element";

const isText = (node: ElementContent | RootContent): node is Text =>
  node.type === "text";

/**
 * Pass `pairs` as the unified options (`[rehypeLegalCitationLinks, pairs]`)
 * so Streamdown's processor cache keys on them. A named `function` keeps the
 * cache key, which reads `plugin.name`, distinct from other plugins.
 */
export function rehypeLegalCitationLinks(
  this: unknown,
  pairs: readonly LegalCitationLinkPair[],
) {
  const usable = pairs.filter(({ text }) => text.trim() !== "");
  if (usable.length === 0) {
    return (tree: Root) => tree;
  }
  // Longest first, so a docket inside a longer reference never wins.
  const sorted = usable.toSorted(
    (left, right) => right.text.length - left.text.length,
  );
  const urlByText = new Map(sorted.map(({ text, url }) => [text, url]));
  const pattern = new RegExp(
    sorted.map(({ text }) => escapeRegex(text)).join("|"),
    "gu",
  );

  const splitTextNode = (text: Text): ElementContent[] => {
    const { value } = text;
    const result: ElementContent[] = [];
    let lastEnd = 0;
    for (const match of value.matchAll(pattern)) {
      const cited = match[0];
      const url = urlByText.get(cited);
      if (url === undefined) {
        continue;
      }
      if (match.index > lastEnd) {
        result.push({ type: "text", value: value.slice(lastEnd, match.index) });
      }
      result.push({
        type: "element",
        tagName: "a",
        properties: { href: url },
        children: [{ type: "text", value: cited }],
      });
      lastEnd = match.index + cited.length;
    }
    if (result.length === 0) {
      return [text];
    }
    if (lastEnd < value.length) {
      result.push({ type: "text", value: value.slice(lastEnd) });
    }
    return result;
  };

  const walkElement = (parent: Element) => {
    const next: ElementContent[] = [];
    for (const child of parent.children) {
      if (isText(child)) {
        next.push(...splitTextNode(child));
        continue;
      }
      if (isElement(child) && !SKIP_TAGS.has(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    parent.children = next;
  };

  const walkRoot = (root: Root) => {
    const next: RootContent[] = [];
    for (const child of root.children) {
      if (isText(child)) {
        next.push(...splitTextNode(child));
        continue;
      }
      if (isElement(child) && !SKIP_TAGS.has(child.tagName)) {
        walkElement(child);
      }
      next.push(child);
    }
    root.children = next;
  };

  return (tree: Root) => {
    walkRoot(tree);
    return tree;
  };
}
