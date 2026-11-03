// The markdown an assistant answer uses, as blocks a screen can draw with
// plain Text views. Deliberately small: headings, paragraphs, lists, quotes,
// fenced code, and bold, italic, code and link spans. Anything else reads as
// text. Scanned by hand rather than with regular expressions, so a long
// answer costs linear time.

export type Span = {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly code?: true;
  readonly href?: string;
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
  | { readonly type: "code"; readonly text: string };

const FENCE = "```";

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

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

/** Spans of one line or paragraph. An opening marker with no closing one is text. */
export const parseInline = (text: string): Span[] => {
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
    const char = text[at];
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
        spans.push({ text: text.slice(at + 2, end), bold: true });
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
        (end + 1 === text.length || !isWordChar(text[end + 1]));
      const opens = at === 0 || !isWordChar(text[at - 1]);
      if (closes && opens) {
        flush();
        spans.push({ text: text.slice(at + 1, end), italic: true });
        at = end + 1;
        continue;
      }
    } else if (char === "[") {
      const close = text.indexOf("](", at + 1);
      const end = close === -1 ? -1 : text.indexOf(")", close + 2);
      if (close > at + 1 && end > close + 2) {
        flush();
        spans.push({
          text: text.slice(at + 1, close),
          href: text.slice(close + 2, end),
        });
        at = end + 1;
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

/** Blocks of a whole answer. */
export const parseMarkdown = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Span[][] } | undefined;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        type: "paragraph",
        spans: parseInline(paragraph.join(" ")),
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
    const title = heading(trimmed);
    if (title !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: title.level,
        spans: parseInline(title.text),
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
      list.items.push(parseInline(item.text));
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "quote",
        spans: parseInline(trimmed.slice(1).trim()),
      });
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
};
