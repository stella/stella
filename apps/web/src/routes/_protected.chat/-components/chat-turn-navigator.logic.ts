import { buildMessageTurns } from "@/components/chat/chat-thread-messages.logic";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

const PROMPT_PREVIEW_LENGTH = 180;
const RESPONSE_PREVIEW_LENGTH = 280;
const PREVIEW_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const WHITESPACE_SEGMENT = /^\s+$/u;

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

const buildPreview = (values: readonly string[], length: number): string => {
  const output: string[] = [];
  let pendingSpace = false;
  let truncated = false;

  preview: for (const value of values) {
    for (const { segment } of PREVIEW_SEGMENTER.segment(value)) {
      if (WHITESPACE_SEGMENT.test(segment)) {
        pendingSpace = output.length > 0;
        continue;
      }
      if (pendingSpace) {
        if (output.length >= length) {
          truncated = true;
          break preview;
        }
        output.push(" ");
        pendingSpace = false;
      }
      if (output.length >= length) {
        truncated = true;
        break preview;
      }
      output.push(segment);
    }
    pendingSpace = output.length > 0;
  }

  return `${output.join("")}${truncated ? "…" : ""}`;
};

export const buildChatTurnNavigationItems = (
  messages: readonly PersistedChatMessage[],
  toUserPlainText: (value: string) => string,
): ChatTurnNavigationItem[] => {
  const items: ChatTurnNavigationItem[] = [];

  for (const turn of buildMessageTurns(messages)) {
    if (turn.type !== "user") {
      continue;
    }

    const assistantMessage = turn.body.find(
      ({ message }) => message.role === "assistant",
    )?.message;
    const userTextParts = getMessageTextParts(turn.header).map(toUserPlainText);
    const userPreview = buildPreview(userTextParts, PROMPT_PREVIEW_LENGTH);
    const assistantPreview = assistantMessage
      ? buildPreview(
          getMessageTextParts(assistantMessage),
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

  return items;
};
