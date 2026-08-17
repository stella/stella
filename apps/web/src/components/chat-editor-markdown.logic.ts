import { starPasteRegex, underscorePasteRegex } from "@tiptap/extension-bold";
import type { JSONContent } from "@tiptap/react";

type InlineNode = NonNullable<JSONContent["content"]>[number];

type StrongMatch = {
  from: number;
  text: string;
  to: number;
};

const collectStrongMatches = (
  source: string,
  pattern: RegExp,
): StrongMatch[] => {
  const matches: StrongMatch[] = [];
  for (const match of source.matchAll(
    new RegExp(pattern.source, pattern.flags),
  )) {
    const token = match.at(1);
    const text = match.at(2);
    if (token === undefined || text === undefined) {
      continue;
    }
    const tokenOffset = match[0].indexOf(token);
    const from = match.index + tokenOffset;
    matches.push({ from, text, to: from + token.length });
  }
  return matches;
};

// CommonMark backslash escapes: a backslash before ASCII punctuation stands
// for that character. Model-written prompts escape brackets and asterisks
// (`\[Party Name\]`); the composer holds resolved text, and the submit
// boundary re-escapes whatever it needs, so a literal backslash never leaks
// into the sent prompt.
const BACKSLASH_ESCAPE =
  /\\(?<punctuation>[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu;

const unescapeOutsideCodeSpans = (text: string): string =>
  text.replace(BACKSLASH_ESCAPE, "$<punctuation>");

const backtickRunLength = (text: string, index: number): number => {
  let end = index;
  while (text.charAt(end) === "`") {
    end += 1;
  }
  return end - index;
};

/**
 * Resolve escapes outside code spans only. A code span (a backtick run closed
 * by a run of the same length) is literal in CommonMark: `\*` inside one stays
 * a backslash and a star. Linear scan; an unclosed run is ordinary text.
 */
const unescapeMarkdownPunctuation = (text: string): string => {
  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== "`") {
      index += 1;
      continue;
    }
    const fence = backtickRunLength(text, index);
    let closeIndex = -1;
    let scan = index + fence;
    while (scan < text.length) {
      if (text.charAt(scan) !== "`") {
        scan += 1;
        continue;
      }
      const run = backtickRunLength(text, scan);
      if (run === fence) {
        closeIndex = scan;
        break;
      }
      scan += run;
    }
    if (closeIndex === -1) {
      index += fence;
      continue;
    }
    result += unescapeOutsideCodeSpans(text.slice(cursor, index));
    result += text.slice(index, closeIndex + fence);
    cursor = closeIndex + fence;
    index = cursor;
  }
  return result + unescapeOutsideCodeSpans(text.slice(cursor));
};

const parseInlineStrong = (source: string): InlineNode[] => {
  const nodes: InlineNode[] = [];
  const matches = [
    ...collectStrongMatches(source, starPasteRegex),
    ...collectStrongMatches(source, underscorePasteRegex),
  ].sort((left, right) => left.from - right.from);
  let cursor = 0;

  for (const match of matches) {
    if (match.from < cursor) {
      continue;
    }
    if (match.from > cursor) {
      nodes.push({
        type: "text",
        text: unescapeMarkdownPunctuation(source.slice(cursor, match.from)),
      });
    }
    nodes.push({
      type: "text",
      text: unescapeMarkdownPunctuation(match.text),
      marks: [{ type: "bold" }],
    });
    cursor = match.to;
  }

  if (cursor < source.length) {
    nodes.push({
      type: "text",
      text: unescapeMarkdownPunctuation(source.slice(cursor)),
    });
  }
  return nodes;
};

/**
 * Convert prompt-source Markdown into the deliberately small chat-composer
 * schema. This reuses Bold's paste grammar, so typed, pasted, suggested, and
 * AI-improved prompts all follow the same syntax. TipTap owns caret mapping;
 * the existing HTML-to-Markdown request boundary restores `**...**` on submit.
 */
export const createChatComposerDocument = (source: string): JSONContent => {
  const content: InlineNode[] = [];
  const lines = source.split(/\r\n?|\n/u);
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      content.push({ type: "hardBreak" });
    }
    content.push(...parseInlineStrong(line));
  }

  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(content.length === 0 ? {} : { content }),
      },
    ],
  };
};
