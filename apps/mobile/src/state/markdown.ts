// The markdown chat text uses, as blocks a screen can draw with plain Text
// views: an assistant's answer and the person's own message alike.
// Deliberately small: headings, paragraphs, lists, quotes, fenced code,
// tables, and bold, italic, code and link spans, with backslash escapes
// taken out. Anything else reads as text. Scanned by hand rather than with
// regular expressions, so a long answer costs linear time.
//
// A link to a document, matter or decision (`#stella-entity=…`) becomes a
// reference span, drawn as a chip with its label (`./chat-references.ts`);
// any other link becomes a link span only when `./links.ts` accepts where it
// goes, and otherwise reads as its text.

import { panic } from "better-result";

import { chatTextReference } from "./chat-references";
import type { ChatTextReference } from "./chat-references";
import { openableLink } from "./links";
import type { OpenableLink } from "./links";

export type Span = {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly code?: true;
  readonly link?: OpenableLink;
  readonly reference?: ChatTextReference;
};

export type Block =
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3;
      readonly spans: Span[];
    }
  | { readonly type: "paragraph"; readonly spans: Span[] }
  | { readonly type: "quote"; readonly spans: Span[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: Span[][];
    }
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "table";
      readonly header: Span[][];
      readonly rows: Span[][][];
    };

/** What reading links needs to know about where the text is shown. */
export type MarkdownContext = {
  /** This build's own link scheme; undefined where app links have no place. */
  readonly appScheme: string | undefined;
  /** The thread's matter, for a mention that names none of its own. */
  readonly matterId?: string | undefined;
};

const FENCE = "```";

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

/** CommonMark escapes any ASCII punctuation character with a backslash. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const isEscapable = (char: string | undefined): boolean =>
  char !== undefined && char !== "" && ASCII_PUNCTUATION.includes(char);

/** `text` with its backslash escapes taken out: `podklad\_ZK` is `podklad_ZK`. */
const unescapeMarkdown = (text: string): string => {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\" && isEscapable(text[at + 1])) {
      out += text[at + 1] ?? "";
      at += 1;
    } else {
      out += char ?? "";
    }
  }
  return out;
};

/** The text after a list marker (`- `, `* `, `+ `, `1. `, `1) `), or undefined when the line is not a list item. */
const listItem = (
  line: string,
): { ordered: boolean; text: string } | undefined => {
  const trimmed = line.trimStart();
  const bullet = trimmed[0];
  if (
    (bullet === "-" || bullet === "*" || bullet === "+") &&
    trimmed[1] === " "
  ) {
    return { ordered: false, text: trimmed.slice(2) };
  }
  let digits = 0;
  while (isDigit(trimmed[digits])) {
    digits += 1;
  }
  const marker = trimmed[digits];
  if (
    digits > 0 &&
    digits <= 9 &&
    (marker === "." || marker === ")") &&
    trimmed[digits + 1] === " "
  ) {
    return { ordered: true, text: trimmed.slice(digits + 2) };
  }
  return undefined;
};

const HEADING_LEVELS = [1, 2, 3] as const;

const heading = (
  line: string,
): { level: 1 | 2 | 3; text: string } | undefined => {
  let hashes = 0;
  while (line[hashes] === "#") {
    hashes += 1;
  }
  if (hashes === 0 || hashes > 6 || line[hashes] !== " ") {
    return undefined;
  }
  return {
    level: HEADING_LEVELS[Math.min(hashes, 3) - 1] ?? 3,
    text: line.slice(hashes + 1).trim(),
  };
};

/**
 * The index of the `]` that closes the link label opened at `open`, past
 * escaped and nested brackets; -1 when the label never closes.
 */
const labelEnd = (text: string, open: number): number => {
  let depth = 0;
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      if (depth === 0) {
        return at;
      }
      depth -= 1;
    }
  }
  return -1;
};

/**
 * The destination of a link whose `(` stands at `open`, unescaped, and the
 * index after its closing `)`. A destination is either `<…>`, which may hold
 * spaces and parentheses, or bare, which ends at a space or at a `)` that
 * closes no `(` of its own. Spaces may stand around it, and an optional
 * title after it is skipped.
 */
const linkDestination = (
  text: string,
  open: number,
): { href: string; end: number } | undefined => {
  let at = open + 1;
  while (text[at] === " ") {
    at += 1;
  }
  let href = "";
  if (text[at] === "<") {
    at += 1;
    while (at < text.length && text[at] !== ">") {
      const char = text[at];
      if (char === "<") {
        return undefined;
      }
      if (char === "\\" && isEscapable(text[at + 1])) {
        href += text[at + 1] ?? "";
        at += 2;
        continue;
      }
      href += char ?? "";
      at += 1;
    }
    if (text[at] !== ">") {
      return undefined;
    }
    at += 1;
  } else {
    let depth = 0;
    while (at < text.length) {
      const char = text[at];
      if (char === " " || (char === ")" && depth === 0)) {
        break;
      }
      if (char === "\\" && isEscapable(text[at + 1])) {
        href += text[at + 1] ?? "";
        at += 2;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      href += char ?? "";
      at += 1;
    }
  }
  while (text[at] === " ") {
    at += 1;
  }
  const quote = text[at];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = text.indexOf(quote === "(" ? ")" : quote, at + 1);
    if (close === -1) {
      return undefined;
    }
    at = close + 1;
    while (text[at] === " ") {
      at += 1;
    }
  }
  return text[at] === ")" ? { href, end: at + 1 } : undefined;
};

/**
 * The span a link written as `label` becomes: a reference chip, a link the
 * app may open, or undefined when it reads as its label alone.
 */
const linkSpan = (
  href: string,
  label: string,
  { appScheme, matterId }: MarkdownContext,
): Span | undefined => {
  const reference = chatTextReference(href, label, matterId);
  if (reference === "unresolved") {
    return undefined;
  }
  if (reference !== undefined) {
    return { text: reference.label, reference };
  }
  const link = openableLink(href, appScheme);
  return link === undefined ? undefined : { text: label, link };
};

/**
 * Spans of one line or paragraph. An opening marker with no closing one is
 * text, and so is a link `./links.ts` refuses.
 */
export const parseInline = (text: string, context: MarkdownContext): Span[] => {
  const spans: Span[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") {
      spans.push({ text: plain });
      plain = "";
    }
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === "\\" && isEscapable(text[at + 1])) {
      plain += text[at + 1] ?? "";
      at += 2;
      continue;
    }
    if (char === "`") {
      const end = text.indexOf("`", at + 1);
      if (end > at + 1) {
        flush();
        spans.push({ text: text.slice(at + 1, end), code: true });
        at = end + 1;
        continue;
      }
    } else if (char === "*" && text[at + 1] === "*") {
      const end = text.indexOf("**", at + 2);
      if (end > at + 2) {
        flush();
        // Emphasis holds spans of its own: a mention in bold is still a chip.
        for (const span of parseInline(text.slice(at + 2, end), context)) {
          spans.push({ ...span, bold: true });
        }
        at = end + 2;
        continue;
      }
    } else if ((char === "*" || char === "_") && text[at + 1] !== " ") {
      const end = text.indexOf(char, at + 1);
      // `snake_case` and `2 * 3 * 4` stay text: the closing marker must
      // follow a non-space and end the word.
      const closes =
        end > at + 1 &&
        text[end - 1] !== " " &&
        text[end - 1] !== "\\" &&
        (end + 1 === text.length || !isWordChar(text[end + 1]));
      const opens = at === 0 || !isWordChar(text[at - 1]);
      if (closes && opens) {
        flush();
        for (const span of parseInline(text.slice(at + 1, end), context)) {
          spans.push({ ...span, italic: true });
        }
        at = end + 1;
        continue;
      }
    } else if (char === "[") {
      const close = labelEnd(text, at);
      const target =
        close !== -1 && text[close + 1] === "("
          ? linkDestination(text, close + 1)
          : undefined;
      if (target !== undefined) {
        const label = unescapeMarkdown(text.slice(at + 1, close));
        const span = linkSpan(target.href, label, context);
        if (span === undefined) {
          plain += label;
        } else {
          flush();
          spans.push(span);
        }
        at = target.end;
        continue;
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return spans;
};

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined &&
  ((char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    isDigit(char));

/**
 * The cells of a table row, split at each `|` that is not escaped; one
 * leading and one trailing `|` are the row's edges, not cell borders.
 */
const tableCells = (line: string): string[] => {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < row.length; at += 1) {
    const char = row[at];
    if (char === "\\" && row[at + 1] === "|") {
      cell += "\\|";
      at += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char ?? "";
    }
  }
  cells.push(cell.trim());
  return cells;
};

/** Whether a line is a table's delimiter row: `| --- | :-: |`. */
const isDelimiterRow = (line: string): boolean => {
  if (!line.includes("-")) {
    return false;
  }
  return tableCells(line).every((cell) => {
    let at = cell.startsWith(":") ? 1 : 0;
    const end = cell.endsWith(":") ? cell.length - 1 : cell.length;
    if (at >= end) {
      return false;
    }
    while (at < end) {
      if (cell[at] !== "-") {
        return false;
      }
      at += 1;
    }
    return true;
  });
};

/** Whether a line opens a block other than a paragraph or a table row. */
const startsBlock = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    trimmed.startsWith(FENCE) ||
    trimmed.startsWith(">") ||
    heading(trimmed) !== undefined ||
    listItem(line) !== undefined
  );
};

/** Whether a line ends in a hard line break of two or more spaces. */
const breaksAfter = (line: string): boolean => line.endsWith("  ");

/** Blocks of a whole text. */
export const parseMarkdown = (
  markdown: string,
  context: MarkdownContext,
): Block[] => {
  const blocks: Block[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Span[][] } | undefined;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        type: "paragraph",
        spans: parseInline(paragraph.join(""), context),
      });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== undefined) {
      blocks.push({ type: "list", ...list });
      list = undefined;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith(FENCE)) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !(lines[index] ?? "").trim().startsWith(FENCE)
      ) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (trimmed.includes("|") && isDelimiterRow(lines[index + 1] ?? "")) {
      flushParagraph();
      flushList();
      const header = tableCells(trimmed);
      const rows: Span[][][] = [];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index] ?? "";
        const row = rowLine.trim();
        // A table ends at a blank line, a line with no cells, or the start
        // of another block.
        if (row === "" || !row.includes("|") || startsBlock(rowLine)) {
          break;
        }
        const cells = tableCells(row);
        // A row has as many cells as the header: missing ones are empty,
        // extra ones are dropped.
        rows.push(
          header.map((_, column) => parseInline(cells[column] ?? "", context)),
        );
        index += 1;
      }
      index -= 1;
      blocks.push({
        type: "table",
        header: header.map((cell) => parseInline(cell, context)),
        rows,
      });
      continue;
    }
    const title = heading(trimmed);
    if (title !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: title.level,
        spans: parseInline(title.text, context),
      });
      continue;
    }
    const item = listItem(line);
    if (item !== undefined) {
      flushParagraph();
      if (list !== undefined && list.ordered !== item.ordered) {
        flushList();
      }
      list ??= { ordered: item.ordered, items: [] };
      list.items.push(parseInline(item.text, context));
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "quote",
        spans: parseInline(trimmed.slice(1).trim(), context),
      });
      continue;
    }
    flushList();
    // Lines run on with a space, unless the previous one ended in a hard
    // break: two spaces (how a sent message stores its line breaks) or a
    // backslash.
    const previous = paragraph.at(-1);
    if (previous !== undefined && (lines[index - 1] ?? "").endsWith("\\")) {
      paragraph[paragraph.length - 1] = `${previous.slice(0, -1)}\n`;
    } else if (previous !== undefined) {
      const joint = breaksAfter(lines[index - 1] ?? "") ? "\n" : " ";
      paragraph[paragraph.length - 1] = `${previous}${joint}`;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
};

/**
 * The text as a person reads it: every reference and link as its label,
 * every other mark and escape taken out. What copying an answer gives.
 */
export const plainText = (markdown: string, context: MarkdownContext): string =>
  parseMarkdown(markdown, context)
    .map((block) => {
      const line = (spans: readonly Span[]) =>
        spans.map((span) => span.text).join("");
      switch (block.type) {
        case "code":
          return block.text;
        case "list":
          return block.items
            .map(
              (item, index) =>
                `${block.ordered ? `${String(index + 1)}.` : "-"} ${line(item)}`,
            )
            .join("\n");
        case "table":
          return [block.header, ...block.rows]
            .map((row) => row.map(line).join("\t"))
            .join("\n");
        case "heading":
        case "paragraph":
        case "quote":
          return line(block.spans);
        default:
          block satisfies never;
          return panic(`Unhandled block: ${String(block)}`);
      }
    })
    .join("\n\n");
