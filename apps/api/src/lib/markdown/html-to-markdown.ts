import * as cheerio from "cheerio";
import { isTag, isText } from "domhandler";
import type { AnyNode, Element } from "domhandler";

const INLINE_ESCAPE = /([\\`*_~[\]<>])/g;

const escapeText = (text: string): string =>
  text.replace(INLINE_ESCAPE, "\\$1");

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ");

const endsWithWhitespace = (text: string): boolean =>
  text.length === 0 || text.endsWith(" ") || text.endsWith("\n");

const tagNameOf = (node: Element): string => node.tagName.toLowerCase();

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
]);

const rawText = (node: AnyNode): string => {
  if (isText(node)) {
    return node.data;
  }
  if (isTag(node)) {
    if (tagNameOf(node) === "br") {
      return "\n";
    }
    return node.children.map(rawText).join("");
  }
  return "";
};

/**
 * Wrap inline code so that any backtick run inside the
 * payload survives intact. CommonMark allows the fence to
 * be any number of backticks longer than the longest
 * internal run; pad with one space on each side when the
 * payload itself starts or ends with a backtick.
 */
const wrapInlineCode = (text: string): string => {
  if (text === "") {
    return "``";
  }
  let longestRun = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longestRun = Math.max(longestRun, run.length);
  }
  const fence = "`".repeat(longestRun + 1);
  const padded =
    text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
};

const renderInlineElement = (el: Element): string => {
  const tag = tagNameOf(el);
  switch (tag) {
    case "strong":
    case "b":
      return `**${renderInline(el.children)}**`;
    case "em":
    case "i":
      return `*${renderInline(el.children)}*`;
    case "del":
    case "s":
      return `~~${renderInline(el.children)}~~`;
    case "code":
      return wrapInlineCode(rawText(el));
    case "br":
      return "  \n";
    case "a": {
      const href = el.attribs["href"] ?? "";
      return `[${renderInline(el.children)}](${href})`;
    }
    case "u":
    case "sub":
    case "sup":
      return `<${tag}>${renderInline(el.children)}</${tag}>`;
    default:
      return renderInline(el.children);
  }
};

const renderInline = (nodes: AnyNode[]): string => {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      let collapsed = collapseWhitespace(node.data);
      if (collapsed.startsWith(" ") && endsWithWhitespace(out)) {
        collapsed = collapsed.slice(1);
      }
      out += escapeText(collapsed);
      continue;
    }
    if (isTag(node)) {
      out += renderInlineElement(node);
    }
  }
  return out;
};

const renderMixed = (nodes: AnyNode[]): string => {
  const blocks: string[] = [];
  let inlineRun: AnyNode[] = [];

  const flushInline = (): void => {
    if (inlineRun.length === 0) {
      return;
    }
    const text = renderInline(inlineRun).trim();
    if (text) {
      blocks.push(text);
    }
    inlineRun = [];
  };

  for (const node of nodes) {
    if (isTag(node) && BLOCK_TAGS.has(tagNameOf(node))) {
      flushInline();
      const block = renderBlock(node);
      if (block) {
        blocks.push(block);
      }
      continue;
    }
    inlineRun.push(node);
  }
  flushInline();

  return blocks.join("\n\n");
};

const renderListItem = (li: Element): string => renderMixed(li.children).trim();

const renderList = (el: Element, ordered: boolean): string => {
  const items = el.children.filter(
    (c): c is Element => isTag(c) && tagNameOf(c) === "li",
  );
  return items
    .map((li, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const indent = " ".repeat(marker.length);
      const content = renderListItem(li);
      return marker + content.replace(/\n/g, `\n${indent}`);
    })
    .join("\n");
};

const renderTableCell = (cell: Element): string =>
  renderInline(cell.children).replace(/\|/g, "\\|").replace(/\n/g, " ");

const collectTableRows = (parent: Element): string[][] => {
  const rows: string[][] = [];
  for (const child of parent.children) {
    if (!isTag(child)) {
      continue;
    }
    const tag = tagNameOf(child);
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      rows.push(...collectTableRows(child));
      continue;
    }
    if (tag !== "tr") {
      continue;
    }
    const cells: string[] = [];
    for (const cell of child.children) {
      if (
        isTag(cell) &&
        (tagNameOf(cell) === "th" || tagNameOf(cell) === "td")
      ) {
        cells.push(renderTableCell(cell));
      }
    }
    rows.push(cells);
  }
  return rows;
};

const findTableCaption = (el: Element): string => {
  const caption = el.children.find(
    (c): c is Element => isTag(c) && tagNameOf(c) === "caption",
  );
  return caption ? renderInline(caption.children).trim() : "";
};

const renderTable = (el: Element): string => {
  const rows = collectTableRows(el);
  if (rows.length === 0) {
    return "";
  }
  const colCount = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((row) => {
    const copy = Array.from(row);
    while (copy.length < colCount) {
      copy.push("");
    }
    return copy;
  });
  const [header = [], ...body] = padded;
  const tableLines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  const caption = findTableCaption(el);
  // Markdown has no native caption; render it as a bold line
  // before the table so it survives the round-trip without
  // being silently dropped.
  return caption
    ? `**${caption}**\n\n${tableLines.join("\n")}`
    : tableLines.join("\n");
};

const renderBlock = (el: Element): string => {
  const tag = tagNameOf(el);
  const headingLevel = HEADING_LEVELS[tag];
  if (headingLevel !== undefined) {
    return `${"#".repeat(headingLevel)} ${renderInline(el.children).trim()}`;
  }
  switch (tag) {
    case "p":
      return renderInline(el.children).trim();
    case "hr":
      return "---";
    case "blockquote": {
      const inner = renderChildren(el.children).trim();
      if (!inner) {
        return "";
      }
      return inner
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    }
    case "pre": {
      const codeEl = el.children.find(
        (c): c is Element => isTag(c) && tagNameOf(c) === "code",
      );
      const lang = codeEl?.attribs["class"]?.match(/language-(\S+)/)?.[1] ?? "";
      const text = trimTrailingNewlines(rawText(codeEl ?? el));
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "ul":
      return renderList(el, false);
    case "ol":
      return renderList(el, true);
    case "table":
      return renderTable(el);
    default:
      return renderChildren(el.children).trim();
  }
};

const renderChildren = (nodes: AnyNode[]): string => renderMixed(nodes);

const trimTrailingNewlines = (text: string): string => {
  let end = text.length;
  while (text[end - 1] === "\n") {
    end -= 1;
  }
  return text.slice(0, end);
};

/**
 * Convert sanitized HTML to GFM-flavored Markdown.
 *
 * Inputs come from cheerio with an upstream allowlist
 * sanitizer; tags outside the allowlist are unwrapped
 * (children rendered, tag dropped). Output ends with a
 * single trailing newline when non-empty.
 */
export const htmlToMarkdown = (html: string): string => {
  if (!html.trim()) {
    return "";
  }
  const $ = cheerio.load(html, undefined, false);
  const body = renderChildren($.root().contents().toArray() as AnyNode[]);
  return body ? `${body}\n` : "";
};
