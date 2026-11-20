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
  | { kind: "list"; ordered: boolean; items: Inline[][] };

const HEADING = /^(#{1,3})\s+(.*)$/u;
const BULLET = /^\s*[-*•]\s+(.*)$/u;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/u;

/** Bold (`**`) and italic (`*` or `_`) runs; unmatched marks stay text. */
export const parseInline = (source: string): Inline[] => {
  const runs: Inline[] = [];
  const push = (text: string, bold: boolean, italic: boolean) => {
    if (text === "") {
      return;
    }
    const last = runs.at(-1);
    if (last && last.bold === bold && last.italic === italic) {
      last.text += text;
      return;
    }
    runs.push({ text, bold, italic });
  };
  const pattern =
    /\*\*(.+?)\*\*|(?<![\p{L}\p{N}])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\p{L}\p{N}])/gu;
  let at = 0;
  for (const match of source.matchAll(pattern)) {
    push(source.slice(at, match.index), false, false);
    if (match[1] !== undefined) {
      for (const inner of parseInline(match[1])) {
        push(inner.text, true, inner.italic);
      }
    } else {
      push(match[2] ?? "", false, true);
    }
    at = match.index + match[0].length;
  }
  push(source.slice(at), false, false);
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
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: Math.min(3, heading[1]?.length ?? 1) as 1 | 2 | 3,
        inline: parseInline(heading[2] ?? ""),
      });
      continue;
    }
    const item = bullet ?? numbered;
    if (item) {
      flush();
      const ordered = numbered !== null;
      const last = blocks.at(-1);
      const inline = parseInline(item[1] ?? "");
      if (last?.kind === "list" && last.ordered === ordered) {
        last.items.push(inline);
      } else {
        blocks.push({ kind: "list", ordered, items: [inline] });
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
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items
            .map((item) => `<li>${inlineHtml(item)}</li>`)
            .join("");
          return `<${tag}>${items}</${tag}>`;
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
                `${block.ordered ? `${index + 1}.` : "-"} ${inlineText(item)}`,
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
 *  larger, so the model sees more context per request. */
export const FIRST_PART_CHARACTERS = 1500;
export const PART_CHARACTERS = 6000;

const characters = (text: string): number => [...text].length;

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
