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
      nodes.push({ type: "text", text: source.slice(cursor, match.from) });
    }
    nodes.push({
      type: "text",
      text: match.text,
      marks: [{ type: "bold" }],
    });
    cursor = match.to;
  }

  if (cursor < source.length) {
    nodes.push({ type: "text", text: source.slice(cursor) });
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
