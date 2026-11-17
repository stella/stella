import type { Cheerio } from "@stll/html";
import { isTag, isText } from "@stll/html/nodes";
import type { AnyNode } from "@stll/html/nodes";

const BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const SKIPPED_TAGS = new Set(["script", "style", "template", "noscript"]);

const collapseLine = (line: string) => line.replace(/\s+/gu, " ").trim();

/** Publisher HTML as paragraphs: block elements end a paragraph, `<br>` a line. */
export const publisherHtmlText = (root: Cheerio<AnyNode>) => {
  const parts: string[] = [];
  const walk = (node: AnyNode) => {
    if (isText(node)) {
      parts.push(node.data);
      return;
    }
    if (!isTag(node) || SKIPPED_TAGS.has(node.name)) {
      return;
    }
    if (node.name === "br") {
      parts.push("\n");
      return;
    }
    const block = BLOCK_TAGS.has(node.name);
    if (block) {
      parts.push("\n\n");
    }
    for (const child of node.children) {
      walk(child);
    }
    if (block) {
      parts.push("\n\n");
    }
  };
  for (const node of root.contents().toArray()) {
    walk(node);
  }
  return parts
    .join("")
    .split(/\n{2,}/u)
    .map((paragraph) =>
      paragraph.split("\n").map(collapseLine).filter(Boolean).join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
};
