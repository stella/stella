import {
  getChatToolActivityCategory,
  isFailedToolOutput,
} from "@stll/api-contract/chat-tool-activity";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";

export const getLatestCompletedResearchPartIndex = (
  messages: readonly ChatMessage[],
): number | null => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") {
    return null;
  }

  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (
      part?.type === "tool-call" &&
      part.state === "complete" &&
      getChatToolActivityCategory(part.name) === "research" &&
      !isFailedToolOutput(part.output)
    ) {
      return index;
    }
  }
  return null;
};

type ResolveChatActivityIndicatorStateOptions = {
  hasCompletedResearch: boolean;
  hasRunningTool: boolean;
  hasVisibleResponse: boolean;
  hasVisibleContent: boolean;
};

/** `solving` once research came back (the answer is being composed from
 *  sources); `working` before that. */
export type ChatActivityIndicatorState = "solving" | "working";

export const resolveChatActivityIndicatorState = ({
  hasCompletedResearch,
  hasRunningTool,
  hasVisibleResponse,
  hasVisibleContent,
}: ResolveChatActivityIndicatorStateOptions): ChatActivityIndicatorState | null => {
  if (hasRunningTool || hasVisibleResponse) {
    return null;
  }

  if (hasCompletedResearch) {
    return "solving";
  }

  return hasVisibleContent ? null : "working";
};
