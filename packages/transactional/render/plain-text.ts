/**
 * The plain-text part of an email rendered from `../components`.
 *
 * Not a general HTML-to-text converter: it reads only the markup those
 * components produce (headings, paragraphs, presentation tables, links,
 * dividers, images and the preview line) and throws `EmailMarkupError` on
 * any other element, so a template that starts using a new one fails its
 * render test instead of sending a garbled text part.
 *
 * Blocks are separated the way the `html-to-text` defaults lay them out: a
 * heading is uppercased, paragraphs and tables are set apart by a blank line,
 * a divider is a line of 40 dashes, a link is followed by its URL unless the
 * URL is its text, and images and the preview line are dropped. Whitespace
 * runs collapse to one space and lines are never wrapped.
 */
export const toPlainText = (markup: string): string => {
  const bodyStart = markup.indexOf("<body");
  const bodyEnd = markup.lastIndexOf("</body>");
  if (bodyStart === -1 || bodyEnd < bodyStart) {
    return fail("toPlainText: the markup has no <body>");
  }
  const body = markup.slice(bodyStart, bodyEnd + "</body>".length);

  const root = createBlock(0);
  const blocks: Block[] = [root];
  const elements: OpenElement[] = [];
  const transforms: ((word: string) => string)[] = [];
  let skippedDepth = 0;

  const current = (): Block => blocks.at(-1) ?? root;
  // The innermost element's transform applies first.
  const transform = (word: string) => {
    let value = word;
    for (const apply of transforms.toReversed()) {
      value = apply(value);
    }
    return value;
  };

  const openBlock = (leadingLineBreaks: number) => {
    blocks.push(createBlock(leadingLineBreaks));
  };
  const closeBlock = (trailingLineBreaks: number) => {
    const block = blocks.pop() ?? fail("toPlainText: no block to close");
    addText(
      current(),
      getText(block),
      block.leadingLineBreaks,
      Math.max(block.stashedLineBreaks, trailingLineBreaks),
    );
  };

  const token =
    /<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9]*)([^>]*?)(\/?)>|([^<]+)/uy;
  let index = 0;
  while (index < body.length) {
    token.lastIndex = index;
    const match =
      token.exec(body) ??
      fail(
        `toPlainText: unreadable markup at ${index}: ${body.slice(index, index + 40)}`,
      );
    index = token.lastIndex;
    const [, closing, name, attributes = "", selfClosing, text] = match;

    if (skippedDepth > 0) {
      if (name !== undefined && selfClosing === "") {
        skippedDepth += closing === "/" ? -1 : 1;
      }
      continue;
    }
    if (text !== undefined) {
      addInline(current(), decodeEntities(text), transform);
      continue;
    }
    if (name === undefined) {
      continue; // a comment
    }

    if (closing === "/") {
      const element = elements.pop();
      if (element === undefined || element.name !== name) {
        return fail(`toPlainText: unexpected </${name}> in email markup`);
      }
      switch (element.kind) {
        case "block":
          closeBlock(element.trailingLineBreaks);
          break;
        case "heading":
          transforms.pop();
          closeBlock(HEADING.trailing);
          break;
        case "link":
          transforms.pop();
          if (element.href !== element.text) {
            addInline(
              current(),
              element.text === "" ? element.href : ` ${element.href}`,
            );
          }
          break;
        case "inline":
          break;
      }
      continue;
    }

    if (attributes.includes(' data-skip-in-text="true"')) {
      if (selfClosing === "") {
        skippedDepth = 1;
      }
      continue;
    }
    if (selfClosing === "/") {
      switch (name) {
        case "img":
          break;
        case "hr":
          openBlock(DIVIDER.leading);
          addInline(current(), "-".repeat(DIVIDER.length), transform);
          closeBlock(DIVIDER.trailing);
          break;
        default:
          return fail(`toPlainText: unsupported <${name}/> in email markup`);
      }
      continue;
    }
    switch (name) {
      case "p":
      case "table": {
        const spacing = BLOCKS[name];
        openBlock(spacing.leading);
        elements.push({
          kind: "block",
          name,
          trailingLineBreaks: spacing.trailing,
        });
        break;
      }
      case "h1":
        openBlock(HEADING.leading);
        transforms.push(toUpperCase);
        elements.push({ kind: "heading", name });
        break;
      case "a": {
        const href = /\shref="([^"]*)"/u.exec(attributes)?.[1];
        if (href === undefined) {
          return fail("toPlainText: <a> without an href in email markup");
        }
        const link: LinkElement = {
          kind: "link",
          name,
          href: decodeEntities(href),
          text: "",
        };
        transforms.push(collectLinkText(link));
        elements.push(link);
        break;
      }
      case "body":
      case "tbody":
      case "tr":
      case "td":
      case "span":
      case "strong":
        elements.push({ kind: "inline", name });
        break;
      default:
        return fail(`toPlainText: unsupported <${name}> in email markup`);
    }
  }
  if (elements.length > 0 || blocks.length > 1) {
    return fail("toPlainText: the markup leaves elements open");
  }
  return getText(root);
};

type Block = {
  /** Text of the closed child blocks and the inline text before them. */
  rawText: string;
  /** Completed lines of the inline text after `rawText`. */
  lines: string[][];
  /** Words of the inline line being built. */
  words: string[];
  leadingLineBreaks: number;
  /** Line breaks owed before the next text, from the last closed child. */
  stashedLineBreaks: number;
  /** Whitespace seen after the last word, owed before the next one. */
  stashedSpace: boolean;
};

type OpenElement =
  | { kind: "inline"; name: string }
  | { kind: "block"; name: string; trailingLineBreaks: number }
  | { kind: "heading"; name: string }
  | LinkElement;

type LinkElement = {
  kind: "link";
  name: string;
  href: string;
  /** The link's own words joined without spaces, as they are added. */
  text: string;
};

function toUpperCase(word: string): string {
  return word.toUpperCase();
}

/** Records the link's words; the URL is left out when it equals them. */
function collectLinkText(link: LinkElement): (word: string) => string {
  return (word) => {
    link.text += word;
    return word;
  };
}

const BLOCKS = {
  p: { leading: 2, trailing: 2 },
  table: { leading: 2, trailing: 2 },
} as const;

const HEADING = { leading: 3, trailing: 2 } as const;

const DIVIDER = { leading: 2, trailing: 2, length: 40 } as const;

// HTML whitespace, plus the zero-width space.
const WORD = /[^ \t\r\n\f\u{200B}]+/gu;
const HAS_WORD = /[^ \t\r\n\f\u{200B}]/u;
const LEADING_WHITESPACE = /^[ \t\r\n\f\u{200B}]/u;
const TRAILING_WHITESPACE = /[ \t\r\n\f\u{200B}]$/u;

// React escapes exactly these five characters in text and attribute values.
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(?:amp|lt|gt|quot|#x27);/gu,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

function createBlock(leadingLineBreaks: number): Block {
  return {
    rawText: "",
    lines: [],
    words: [],
    leadingLineBreaks,
    stashedLineBreaks: 0,
    stashedSpace: false,
  };
}

function getText(block: Block): string {
  if (block.lines.length === 0 && block.words.length === 0) {
    return block.rawText;
  }
  const inline = [...block.lines, block.words]
    .map((words) => words.join(" "))
    .join("\n");
  return block.rawText + inline;
}

/** Appends a closed child block's text, separated by the owed line breaks. */
function addText(
  block: Block,
  text: string,
  leadingLineBreaks: number,
  trailingLineBreaks: number,
) {
  const blockText = getText(block);
  const lineBreaks = Math.max(block.stashedLineBreaks, leadingLineBreaks);
  block.lines = [];
  block.words = [];
  if (blockText === "") {
    block.rawText = text;
    block.leadingLineBreaks = lineBreaks;
  } else {
    block.rawText = blockText + "\n".repeat(lineBreaks) + text;
  }
  block.stashedLineBreaks = trailingLineBreaks;
}

/** Adds inline text, collapsing whitespace runs to single spaces. */
function addInline(
  block: Block,
  text: string,
  transform: (word: string) => string = (word) => word,
) {
  if (text === "" || (block.stashedLineBreaks > 0 && !HAS_WORD.test(text))) {
    return;
  }
  if (block.stashedLineBreaks > 0) {
    block.lines.push(block.words);
    for (let line = 1; line < block.stashedLineBreaks; line += 1) {
      block.lines.push([]);
    }
    block.words = [];
  }
  const previouslyStashedSpace = block.stashedSpace;
  let anyWord = false;
  for (const [word] of text.matchAll(WORD)) {
    const transformed = transform(word);
    const lastWord = block.words.at(-1);
    if (
      anyWord ||
      previouslyStashedSpace ||
      LEADING_WHITESPACE.test(text) ||
      lastWord === undefined
    ) {
      block.words.push(transformed);
    } else {
      block.words[block.words.length - 1] = lastWord + transformed;
    }
    anyWord = true;
  }
  block.stashedSpace =
    (previouslyStashedSpace && !anyWord) || TRAILING_WHITESPACE.test(text);
  block.stashedLineBreaks = 0;
}

/** The markup is not what the email components produce. */
export class EmailMarkupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailMarkupError";
  }
}

function fail(message: string): never {
  throw new EmailMarkupError(message);
}
