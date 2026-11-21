import type { Paragraph } from "./transcribe-logic";

/**
 * The cleaned-up text of a recording: the Markdown subset the API returns
 * (paragraphs, three heading levels, bold, italic, bulleted and numbered
 * lists) read into blocks the window renders as elements, never as HTML,
 * and written back out as HTML or plain text for copying. Anything outside
 * the subset is shown as the text it is.
 */

export type Inline = { text: string; bold: boolean; italic: boolean };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] };

const isSpace = (character: string | undefined): boolean =>
  character === " " || character === "\t";

const isDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= "0" && character <= "9";

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.test(character);

/** `# Title` to `### Title`: the level and the title, or null. */
const HEADING_LEVELS = [1, 2, 3] as const;

const headingOf = (line: string): { level: 1 | 2 | 3; text: string } | null => {
  let marks = 0;
  while (line[marks] === "#") {
    marks += 1;
  }
  const level = HEADING_LEVELS[marks - 1];
  if (level === undefined || !isSpace(line[marks])) {
    return null;
  }
  return { level, text: line.slice(marks).trim() };
};

/** `- item`, `* item` or `• item`: the item, or null. */
const bulletOf = (line: string): string | null => {
  const trimmed = line.trimStart();
  const [mark] = trimmed;
  return (mark === "-" || mark === "*" || mark === "•") && isSpace(trimmed[1])
    ? trimmed.slice(2).trim()
    : null;
};

/** `1. item` or `1) item`, up to three digits: its number and the item,
 *  or null. */
const numberedOf = (line: string): { number: number; text: string } | null => {
  const trimmed = line.trimStart();
  let digits = 0;
  let number = 0;
  while (digits < 4 && isDigit(trimmed[digits])) {
    number = number * 10 + (trimmed.codePointAt(digits) ?? 48) - 48;
    digits += 1;
  }
  const mark = trimmed[digits];
  return digits >= 1 &&
    digits <= 3 &&
    (mark === "." || mark === ")") &&
    isSpace(trimmed[digits + 1])
    ? {
        number,
        text: trimmed.slice(digits + 2).trim(),
      }
    : null;
};

/** Every position where `mark` could close an italic run: not after a
 *  space, and not before a letter or digit. Found once per text, so each
 *  opener looks its closer up instead of rescanning the rest. */
const closersOf = (source: string, mark: string): number[] => {
  const closers: number[] = [];
  for (let at = 1; at < source.length; at += 1) {
    if (
      source[at] === mark &&
      !isSpace(source[at - 1]) &&
      !isWordCharacter(source[at + 1])
    ) {
      closers.push(at);
    }
  }
  return closers;
};

/** The first entry of the ascending `positions` at or after `from`, or -1. */
const firstAtOrAfter = (positions: readonly number[], from: number): number => {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((positions[middle] ?? 0) < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return positions[low] ?? -1;
};

/** Where the italic run opened at `start` by `mark` closes, or -1: the
 *  mark must not touch a space inside, nor a letter or digit outside. */
const italicEnd = (
  source: string,
  start: number,
  closers: readonly number[],
): number => {
  if (isWordCharacter(source[start - 1])) {
    return -1;
  }
  const first = source[start + 1];
  if (first === undefined || isSpace(first) || first === "*" || first === "_") {
    return -1;
  }
  return firstAtOrAfter(closers, start + 2);
};

/** Bold (`**`) and italic (`*` or `_`) runs; unmatched marks stay text. */
export const parseInline = (source: string): Inline[] => {
  const runs: Inline[] = [];
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (text === "") {
      return;
    }
    const last = runs.at(-1);
    if (last?.bold === bold && last.italic === italic) {
      last.text += text;
      return;
    }
    runs.push({ text, bold, italic });
  };
  const closers = { "*": closersOf(source, "*"), _: closersOf(source, "_") };
  let plain = "";
  let at = 0;
  while (at < source.length) {
    if (source.startsWith("**", at)) {
      const close = source.indexOf("**", at + 2);
      if (close > at + 2) {
        push(plain, false, false);
        plain = "";
        for (const inner of parseInline(source.slice(at + 2, close))) {
          push(inner.text, true, inner.italic);
        }
        at = close + 2;
        continue;
      }
    }
    const mark = source[at] ?? "";
    if (mark === "*" || mark === "_") {
      const close = italicEnd(source, at, closers[mark]);
      if (close !== -1) {
        push(plain, false, false);
        plain = "";
        push(source.slice(at + 1, close), false, true);
        at = close + 1;
        continue;
      }
    }
    plain += mark;
    at += 1;
  }
  push(plain, false, false);
  return runs;
};

export const parseMarkdown = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        inline: parseInline(paragraph.join(" ")),
      });
      paragraph = [];
    }
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = headingOf(line);
    const bullet = bulletOf(line);
    const numbered = bullet === null ? numberedOf(line) : null;
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading.level,
        inline: parseInline(heading.text),
      });
      continue;
    }
    const item = bullet ?? numbered?.text ?? null;
    if (item !== null) {
      flush();
      const ordered = numbered !== null;
      const last = blocks.at(-1);
      const inline = parseInline(item);
      if (last?.kind === "list" && last.ordered === ordered) {
        last.items.push(inline);
      } else {
        // A list a later part continues keeps its numbering.
        blocks.push({
          kind: "list",
          ordered,
          start: numbered?.number ?? 1,
          items: [inline],
        });
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtmlText = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);

const inlineHtml = (inline: readonly Inline[]): string =>
  inline
    .map(({ text, bold, italic }) => {
      let html = escapeHtmlText(text);
      if (italic) {
        html = `<em>${html}</em>`;
      }
      return bold ? `<strong>${html}</strong>` : html;
    })
    .join("");

const inlineText = (inline: readonly Inline[]): string =>
  inline.map(({ text }) => text).join("");

export const blocksToHtml = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `<h${block.level}>${inlineHtml(block.inline)}</h${block.level}>`;
        case "paragraph":
          return `<p>${inlineHtml(block.inline)}</p>`;
        case "list": {
          const items = block.items
            .map((item) => `<li>${inlineHtml(item)}</li>`)
            .join("");
          if (!block.ordered) {
            return `<ul>${items}</ul>`;
          }
          return block.start === 1
            ? `<ol>${items}</ol>`
            : `<ol start="${block.start}">${items}</ol>`;
        }
        default:
          return "";
      }
    })
    .join("\n");

export const blocksToText = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
        case "paragraph":
          return inlineText(block.inline);
        case "list":
          return block.items
            .map(
              (item, index) =>
                `${block.ordered ? `${block.start + index}.` : "-"} ${inlineText(item)}`,
            )
            .join("\n");
        default:
          return "";
      }
    })
    .join("\n\n");

/** Raw transcript paragraphs as HTML, each with its timestamp. */
export const paragraphsToHtml = (
  paragraphs: readonly Paragraph[],
  timestamp: (ms: number) => string,
): string =>
  paragraphs
    .map(
      (paragraph) =>
        `<p>[${escapeHtmlText(timestamp(paragraph.startMs))}] ${escapeHtmlText(paragraph.text)}</p>`,
    )
    .join("\n");

/** The cleaned text with the dictation's instructions above it, as one
 *  Markdown document for saving. */
export const cleanedMarkdown = (
  instructions: readonly string[],
  markdown: string,
  instructionsLabel: string,
): string =>
  instructions.length === 0
    ? markdown
    : `> **${instructionsLabel}** ${instructions.join(" ")}\n\n${markdown}`;

/** A part of the transcript the window sends for cleanup: whole paragraphs,
 *  in order, never more than the server accepts. */
export type CleanupPart = { from: number; to: number; text: string };

/** The first part is small, so cleaned text appears soon; later ones are
 *  larger, so the model sees more context per request, yet small enough to
 *  be answered well within the minute the edge in front of the API waits. */
export const FIRST_PART_CHARACTERS = 1500;
export const PART_CHARACTERS = 3000;

/** Code points, the way the server counts a part's length. */
const characters = (text: string): number => {
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
  }
  return count;
};

/**
 * The next part to clean up, starting at paragraph `from`, or null when it
 * should wait. A paragraph covers at most 90 s of speech, so one always fits
 * a request. While the recording is still transcribing, its last
 * paragraph may still grow, so it is left for later, and a part is sent only
 * once it is big enough; once transcription ended, whatever remains goes.
 */
export const nextCleanupPart = ({
  paragraphs,
  from,
  finished,
  first,
  maxCharacters,
}: {
  paragraphs: readonly Paragraph[];
  from: number;
  finished: boolean;
  first: boolean;
  maxCharacters: number;
}): CleanupPart | null => {
  const stable = finished ? paragraphs.length : paragraphs.length - 1;
  if (from >= stable) {
    return null;
  }
  const target = Math.min(
    maxCharacters,
    first ? FIRST_PART_CHARACTERS : PART_CHARACTERS,
  );
  const texts: string[] = [];
  let size = 0;
  let to = from;
  while (to < stable) {
    const text = paragraphs[to]?.text ?? "";
    const added = characters(text) + (texts.length > 0 ? 2 : 0);
    if (texts.length > 0 && size + added > maxCharacters) {
      break;
    }
    texts.push(text);
    size += added;
    to += 1;
    if (size >= target) {
      break;
    }
  }
  if (!finished && size < target) {
    return null;
  }
  return { from, to, text: texts.join("\n\n") };
};
