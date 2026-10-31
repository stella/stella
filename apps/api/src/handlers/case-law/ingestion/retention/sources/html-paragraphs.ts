/**
 * Every visible run of an HTML document as paragraph input for the oracle.
 *
 * The oracle reads an HTML source through its content elements only (`p`,
 * `li`, `td`, `th`, `div`), so a heading, a `blockquote` or text standing
 * directly in the body would go unmeasured, and a parse that dropped it
 * would still score complete. A projection therefore hands the oracle
 * paragraphs instead: every text node a reader sees, split where a block
 * element starts or ends.
 *
 * Written for retention projections: it shares nothing with the parsers'
 * readers. Visible means outside `script`, `style`, `template`, `noscript`
 * and `head`, and outside the page header and footer blocks a Word export
 * marks with `-aw-headerfooter-type` (repeated page furniture, which the
 * oracle drops from HTML sources too). A line break joins its neighbours
 * with a space, as the oracle reads it; image alt text is a run of its own.
 */
import * as cheerio from "cheerio";
import { type AnyNode, isTag, isText } from "domhandler";

const HIDDEN_TAGS = new Set([
  "head",
  "noscript",
  "script",
  "style",
  "template",
]);

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "html",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const PAGE_FURNITURE = /-aw-headerfooter-type/u;

/** A node to visit, or the end of a block whose text must be flushed. */
type Step = { type: "node"; node: AnyNode } | { type: "block-end" };

/** The visible paragraphs of an HTML document or fragment, in order. */
export const htmlParagraphs = (html: string): string[] => {
  const $ = cheerio.load(html);
  const paragraphs: string[] = [];
  let current = "";
  const flush = (): void => {
    const text = current.replace(/\s+/gu, " ").trim();
    if (text !== "") {
      paragraphs.push(text);
    }
    current = "";
  };
  // A walk with an explicit stack: decisions nest inline markup deeply
  // enough that recursion would overflow.
  const pending: Step[] = $.root()
    .contents()
    .toArray()
    .toReversed()
    .map((node): Step => ({ type: "node", node }));
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (step.type === "block-end") {
      flush();
      continue;
    }
    const { node } = step;
    if (isText(node)) {
      current += node.data;
      continue;
    }
    if (!isTag(node) || HIDDEN_TAGS.has(node.name)) {
      continue;
    }
    if (PAGE_FURNITURE.test(node.attribs["style"] ?? "")) {
      continue;
    }
    if (node.name === "br") {
      current += " ";
      continue;
    }
    if (node.name === "img") {
      const alt = node.attribs["alt"]?.trim() ?? "";
      if (alt !== "") {
        flush();
        current = alt;
        flush();
      }
      continue;
    }
    const block = BLOCK_TAGS.has(node.name);
    if (block) {
      flush();
      pending.push({ type: "block-end" });
    }
    for (const child of node.children.toReversed()) {
      pending.push({ type: "node", node: child });
    }
  }
  flush();
  return paragraphs;
};
