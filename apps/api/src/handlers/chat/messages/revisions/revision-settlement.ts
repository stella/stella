import { panic } from "better-result";

import { getAwaitingUserInteractions } from "@/api/handlers/chat/chat-message-parts";
import type { NormalizedLegacyMessageParts } from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";

type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

export const isRevisionToolCallSettled = (part: ChatToolCallPart): boolean => {
  switch (part.state) {
    case "complete":
    case "error":
      return true;
    case "approval-responded":
      return "approval" in part && part.approval.approved === false;
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
}: NormalizedLegacyMessageParts) =>
  getAwaitingUserInteractions({ role: "assistant", parts, metadata }).length >
    0 ||
  parts.some(
    (part) =>
      (part.type === "tool-call" && !isRevisionToolCallSettled(part)) ||
      (part.type === "tool-result" && part.state === "streaming"),
  );
