import { panic } from "better-result";

import { isDeclinedChatToolCall } from "@stll/api-contract/chat";

import { getAwaitingUserInteractions } from "@/api/handlers/chat/chat-message-parts";
import type { NormalizedChatMessageParts } from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";

type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

/** A call is settled once its result or error is stored, or once it was
 *  declined, whatever state it was declined in (as turn settlement reads
 *  it). */
export const isRevisionToolCallSettled = (part: ChatToolCallPart): boolean => {
  if (isDeclinedChatToolCall(part)) {
    return true;
  }
  switch (part.state) {
    case "complete":
    case "error":
      return true;
    case "approval-responded":
    case "awaiting-input":
    case "input-streaming":
    case "input-complete":
    case "approval-requested":
      return false;
    default:
      part.state satisfies never;
      return panic(`Unhandled tool call state: ${String(part.state)}`);
  }
};

export const hasUnsettledRevisionContent = ({
  parts,
  metadata,
}: NormalizedChatMessageParts) =>
  getAwaitingUserInteractions({ role: "assistant", parts, metadata }).length >
    0 ||
  parts.some(
    (part) =>
      (part.type === "tool-call" && !isRevisionToolCallSettled(part)) ||
      (part.type === "tool-result" && part.state === "streaming"),
  );
