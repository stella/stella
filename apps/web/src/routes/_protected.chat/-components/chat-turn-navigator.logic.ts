import { buildMessageTurns } from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

const PROMPT_PREVIEW_LENGTH = 180;
const RESPONSE_PREVIEW_LENGTH = 280;
const MAX_NAVIGATION_ITEMS = 10;
const PREVIEW_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const WHITESPACE_SEGMENT = /^\s+$/u;
const MARKDOWN_FENCE = /^\s{0,3}(?:`{3,}|~{3,})[^\n]*$/gmu;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+/gmu;
const MARKDOWN_BLOCKQUOTE = /^\s{0,3}>\s?/gmu;
const MARKDOWN_LIST_MARKER = /^\s*(?:[-+*]|\d+[.)])\s+/gmu;
const MARKDOWN_STRONG = /(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/gu;
const MARKDOWN_EMPHASIS = /(\*|_)(\S(?:[\s\S]*?\S)?)\1/gu;
const MARKDOWN_STRIKETHROUGH = /(~~)(\S(?:[\s\S]*?\S)?)\1/gu;
const MARKDOWN_INLINE_CODE = /(`+)([\s\S]*?)\1/gu;
const MARKDOWN_ESCAPE = /\\([!#()*+\-.>[\]\\_`{|}~])/gu;

export type ChatTurnNavigationItem = {
  assistantPreview: string | null;
  id: string;
  userAttachmentCount: number;
  userPreview: string | null;
};

const getMessageTextParts = (message: PersistedChatMessage): string[] => {
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.content.trim()) {
      textParts.push(part.content);
    }
  }
  return textParts;
};

const findMarkdownDelimiterEnd = ({
  closing,
  opening,
  start,
  value,
}: {
  closing: string;
  opening: string;
  start: number;
  value: string;
}): number => {
  let depth = 1;
  for (let index = start; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === opening) {
      depth += 1;
      continue;
    }
    if (character !== closing) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }
  return -1;
};

const stripMarkdownLinkDestinations = (value: string): string => {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const isImage =
      value.charAt(cursor) === "!" && value.charAt(cursor + 1) === "[";
    let labelStart = -1;
    if (isImage) {
      labelStart = cursor + 1;
    } else if (value.charAt(cursor) === "[") {
      labelStart = cursor;
    }
    if (labelStart === -1) {
      output += value.charAt(cursor);
      cursor += 1;
      continue;
    }

    const labelEnd = findMarkdownDelimiterEnd({
      closing: "]",
      opening: "[",
      start: labelStart + 1,
      value,
    });
    if (labelEnd === -1) {
      output += value.slice(cursor);
      break;
    }

    const destinationOpening = value.charAt(labelEnd + 1);
    const destinationClosing = destinationOpening === "(" ? ")" : "]";
    if (destinationOpening !== "(" && destinationOpening !== "[") {
      output += value.charAt(cursor);
      cursor += 1;
      continue;
    }
    const destinationEnd = findMarkdownDelimiterEnd({
      closing: destinationClosing,
      opening: destinationOpening,
      start: labelEnd + 2,
      value,
    });
    if (destinationEnd === -1) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(labelStart + 1, labelEnd);
    cursor = destinationEnd + 1;
  }

  return output;
};

const markdownToPreviewText = (value: string): string =>
  stripMarkdownLinkDestinations(value)
    .replace(MARKDOWN_FENCE, "")
    .replace(MARKDOWN_HEADING, "")
    .replace(MARKDOWN_BLOCKQUOTE, "")
    .replace(MARKDOWN_LIST_MARKER, "")
    .replace(MARKDOWN_STRONG, "$2")
    .replace(MARKDOWN_EMPHASIS, "$2")
    .replace(MARKDOWN_STRIKETHROUGH, "$2")
    .replace(MARKDOWN_INLINE_CODE, "$2")
    .replace(MARKDOWN_ESCAPE, "$1");

const buildPreview = (values: readonly string[], length: number): string => {
  const output: string[] = [];
  let pendingSpace = false;

  for (const value of values) {
    for (const { segment } of PREVIEW_SEGMENTER.segment(value)) {
      if (WHITESPACE_SEGMENT.test(segment)) {
        pendingSpace = output.length > 0;
        continue;
      }
      if (pendingSpace) {
        if (output.length >= length) {
          return `${output.join("")}…`;
        }
        output.push(" ");
        pendingSpace = false;
      }
      if (output.length >= length) {
        return `${output.join("")}…`;
      }
      output.push(segment);
    }
    pendingSpace = output.length > 0;
  }

  return output.join("");
};

export const buildChatTurnNavigationItems = (
  messages: readonly PersistedChatMessage[],
  toUserPlainText: (value: string) => string,
): ChatTurnNavigationItem[] => {
  const items: ChatTurnNavigationItem[] = [];
  const turns = buildMessageTurns(messages);

  for (
    let index = turns.length - 1;
    index >= 0 && items.length < MAX_NAVIGATION_ITEMS;
    index -= 1
  ) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }
    if (turn.type !== "user") {
      continue;
    }

    const assistantMessage = turn.body.find(
      ({ message }) => message.role === "assistant",
    )?.message;
    const userTextParts = getMessageTextParts(turn.header).map((value) =>
      markdownToPreviewText(toUserPlainText(value)),
    );
    const userPreview = buildPreview(userTextParts, PROMPT_PREVIEW_LENGTH);
    const assistantPreview = assistantMessage
      ? buildPreview(
          getMessageTextParts(assistantMessage).map(markdownToPreviewText),
          RESPONSE_PREVIEW_LENGTH,
        )
      : "";

    items.push({
      assistantPreview: assistantPreview || null,
      id: turn.header.id,
      userAttachmentCount: turn.header.parts.filter(
        (part) => part.type === "document" || part.type === "image",
      ).length,
      userPreview: userPreview || null,
    });
  }

  return items.toReversed();
};
