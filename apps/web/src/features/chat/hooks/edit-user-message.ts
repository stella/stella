import { panic } from "better-result";

import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type {
  ChatPart,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import type { ChatContinuationRequestBody } from "@/features/chat/chat-runtime";
import { toSafeId } from "@/lib/safe-id";

/**
 * Where a replay rewinds the thread to. Both rewind the same way: the page
 * drops every later message at once, and the request names the same message
 * as `truncateAfterMessageId`, so the server drops the same persisted turns
 * before the model runs again.
 *
 * - `ask-user-answer`: an answered ask-user card is answered again; its
 *   assistant message stays, with the card reset to take the new answer.
 * - `user-message`: one of the user's own messages is replaced; it and every
 *   later message leave the page, and the edited message is sent in its
 *   place under the same id.
 */
export type TruncatedReplayTarget =
  | { type: "ask-user-answer"; toolCallId: string }
  | { type: "user-message"; messageId: string };

export type TruncatedReplay = {
  /** The page's messages once the replay rewound them. */
  messages: PersistedChatMessage[];
  /** What the replay request carries so the server rewinds the same way. */
  body: Required<Pick<ChatContinuationRequestBody, "truncateAfterMessageId">> &
    Pick<ChatContinuationRequestBody, "turnIntent">;
};

type AskUserToolCallPart = Extract<
  ChatPart,
  { name: "ask-user"; type: "tool-call" }
>;

const isAskUserCall = (
  part: ChatPart,
  toolCallId: string,
): part is AskUserToolCallPart =>
  part.type === "tool-call" &&
  part.name === "ask-user" &&
  part.id === toolCallId;

const resetAskUserToolCall = (
  part: AskUserToolCallPart,
): AskUserToolCallPart => {
  const { output: _discardedOutput, ...partWithoutOutput } = part;
  return { ...partWithoutOutput, state: "input-complete" };
};

const planAskUserReplay = (
  messages: readonly PersistedChatMessage[],
  toolCallId: string,
): TruncatedReplay | null => {
  const targetIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => isAskUserCall(part, toolCallId)),
  );
  const target = messages[targetIndex];
  if (target === undefined) {
    return null;
  }
  // `slice` shares the message objects with the page's history; the spread
  // builds a new message that owns the rewritten parts, so the history the
  // SDK holds is never mutated in place.
  const rewound = messages.slice(0, targetIndex + 1).map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    // The card's call goes back to awaiting an answer, and its old result
    // leaves, so the new answer is written as a fresh result. The call keeps
    // its input, so the card body does not flicker before the answer lands.
    const parts: ChatPart[] = [];
    for (const part of message.parts) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        continue;
      }
      parts.push(
        isAskUserCall(part, toolCallId) && part.state === "complete"
          ? resetAskUserToolCall(part)
          : part,
      );
    }
    return { ...message, parts };
  });
  return {
    messages: rewound,
    body: { truncateAfterMessageId: toSafeId<"chatMessage">(target.id) },
  };
};

const planUserMessageReplay = (
  messages: readonly PersistedChatMessage[],
  messageId: string,
): TruncatedReplay | null => {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (messages[targetIndex]?.role !== "user") {
    return null;
  }
  return {
    messages: messages.slice(0, targetIndex),
    body: {
      truncateAfterMessageId: toSafeId<"chatMessage">(messageId),
      turnIntent: CHAT_TURN_INTENT.edit,
    },
  };
};

/**
 * The one truncate-and-replay plan: what the page keeps and what the replay
 * request tells the server. Null when the target is not on the page.
 */
export const planTruncatedReplay = (
  messages: readonly PersistedChatMessage[],
  target: TruncatedReplayTarget,
): TruncatedReplay | null => {
  switch (target.type) {
    case "ask-user-answer":
      return planAskUserReplay(messages, target.toolCallId);
    case "user-message":
      return planUserMessageReplay(messages, target.messageId);
    default:
      target satisfies never;
      return panic("Unhandled replay target");
  }
};
