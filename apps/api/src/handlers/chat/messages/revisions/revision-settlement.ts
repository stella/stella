import { panic } from "better-result";

import type { ChatPart } from "@/api/handlers/chat/types";

type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

export const isRevisionToolCallSettled = (part: ChatToolCallPart): boolean => {
  switch (part.state) {
    case "complete":
    case "error":
      return true;
    case "approval-responded":
      return "approval" in part && part.approval?.approved === false;
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
