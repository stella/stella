import { starPasteRegex, underscorePasteRegex } from "@tiptap/extension-bold";
import type { JSONContent } from "@tiptap/react";
import { panic } from "better-result";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  formatChatSourceScopeId,
  parseChatSourceScopeHref,
  SKILL_REF_HREF_PREFIX,
} from "@stll/api-contract";

import { PASTED_TEXT_NODE_NAME } from "@/components/chat-pasted-text-extension";
import { referenceFromHref } from "@/components/references/reference.logic";
import type { ChatReference } from "@/components/references/reference.logic";

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
  ].toSorted((left, right) => left.from - right.from);
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

// --- A sent user message, back in the composer ---------------------------

/**
 * The Markdown constructs the server never writes for a user message. The
 * composer holds paragraphs, line breaks, bold text and chips, and the server
 * stores them as paragraphs, `  \n` breaks, `**bold**` and links; it escapes
 * every other syntax character it meets in typed text except a line's leading
 * `1.`, `-`, `#` or `!`. Read with those constructs on, a typed numbered line
 * would come back as a list and lose its number, so they stay off and what
 * the user typed reads as the text it was.
 */
const STORED_USER_MESSAGE_GRAMMAR = {
  disable: {
    null: [
      "autolink",
      "blockQuote",
      "characterReference",
      "codeFenced",
      "codeIndented",
      "codeText",
      "definition",
      "headingAtx",
      "htmlFlow",
      "htmlText",
      "labelStartImage",
      "list",
      "setextUnderline",
      "thematicBreak",
    ],
  },
};

type StoredMarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];

const markdownText = (nodes: readonly StoredMarkdownNode[]): string =>
  nodes
    .map((node) => {
      if ("value" in node) {
        return node.value;
      }
      return "children" in node ? markdownText(node.children) : "";
    })
    .join("");

/** A reference chip's attributes, as the composer's mention node holds them. */
const mentionAttrsOf = (
  href: string,
  reference: ChatReference,
): Record<string, string | null> | null => {
  const label = reference.label;
  switch (reference.type) {
    case "entity":
      return {
        category: "entity",
        id: reference.entityId,
        kind: "document",
        label,
        matterId: reference.matterId,
        sourceWorkspaceId: reference.matterId,
      };
    case "matter":
      return {
        category: "workspace",
        id: reference.matterId,
        kind: "workspace",
        label,
      };
    case "decision":
      return reference.locator.type === "ref"
        ? {
            category: "decision",
            id: reference.locator.ref,
            kind: "decision",
            label,
          }
        : null;
    case "corpus":
    case "registry":
    case "connector": {
      const scope = parseChatSourceScopeHref(href);
      return scope === null
        ? null
        : {
            category: scope.kind,
            id: formatChatSourceScopeId(scope),
            kind: scope.kind,
            label,
          };
    }
    case "skill":
    case "user":
      return null;
    default:
      reference satisfies never;
      return panic("Unhandled chat reference");
  }
};

const textNodes = (value: string, bold: boolean): InlineNode[] =>
  value.split(/\r\n?|\n/u).flatMap((line, index): InlineNode[] => [
    ...(index === 0 ? [] : [{ type: "hardBreak" }]),
    ...(line === ""
      ? []
      : [
          {
            type: "text",
            text: line,
            ...(bold ? { marks: [{ type: "bold" }] } : {}),
          },
        ]),
  ]);

/**
 * A stored link back as composer content: a skill as its skill chip, a stella
 * reference as its reference chip, and any other link as the text that shows
 * it, which is how the composer holds a link.
 */
const linkNodes = (
  href: string,
  label: string,
  bold: boolean,
): InlineNode[] => {
  if (href.startsWith(SKILL_REF_HREF_PREFIX)) {
    return [
      {
        type: PASTED_TEXT_NODE_NAME,
        attrs: {
          label,
          source: "skill",
          text: href.slice(SKILL_REF_HREF_PREFIX.length),
        },
      },
    ];
  }
  const parsed = referenceFromHref(href, label);
  const attrs =
    parsed?.type === "reference"
      ? mentionAttrsOf(href, parsed.reference)
      : null;
  if (attrs !== null) {
    return [{ type: "mention", attrs }];
  }
  return textNodes(label === href ? href : `${label} (${href})`, bold);
};

const storedInlineNodes = (
  nodes: readonly StoredMarkdownNode[],
  bold: boolean,
): InlineNode[] =>
  nodes.flatMap((node): InlineNode[] => {
    switch (node.type) {
      case "text":
        return textNodes(node.value, bold);
      case "strong":
        return storedInlineNodes(node.children, true);
      case "break":
        return [{ type: "hardBreak" }];
      case "link":
        return linkNodes(node.url, markdownText(node.children), bold);
      default:
        if ("value" in node) {
          return textNodes(node.value, bold);
        }
        return "children" in node ? storedInlineNodes(node.children, bold) : [];
    }
  });

/**
 * The composer document of a stored user message: the Markdown the server
 * wrote for what the composer sent, read with the composer's grammar.
 */
export const storedUserMessageDocument = (markdown: string): JSONContent => {
  const paragraphs = fromMarkdown(markdown, {
    extensions: [STORED_USER_MESSAGE_GRAMMAR],
  }).children.map((node): JSONContent => {
    const content = storedInlineNodes(
      node.type === "paragraph" ? node.children : [node],
      false,
    );
    return {
      type: "paragraph",
      ...(content.length === 0 ? {} : { content }),
    };
  });
  return {
    type: "doc",
    content: paragraphs.length === 0 ? [{ type: "paragraph" }] : paragraphs,
  };
};

/**
 * Whether a text part still holds the composer's own serialization (a
 * just-sent message, until the stored copy replaces it): the composer writes
 * every message as paragraphs. Stored Markdown never takes that shape, since
 * the server escapes the `<` of typed text.
 */
const isComposerSerialization = (content: string): boolean => {
  const trimmed = content.trim();
  return /^<p(?:\s[^>]*)?>/u.test(trimmed) && trimmed.endsWith("</p>");
};

/**
 * A sent user message's text as content the composer loads: its own markup
 * as it is, stored Markdown through `storedUserMessageDocument`. Every path
 * that puts a sent message back into a composer (an edit, the up-arrow
 * recall) reads it here.
 */
export const userMessageComposerContent = (
  stored: string,
): JSONContent | string =>
  isComposerSerialization(stored) ? stored : storedUserMessageDocument(stored);
