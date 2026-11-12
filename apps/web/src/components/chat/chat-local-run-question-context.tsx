import { createContext } from "react";

import type { LocalRunQuestionPause } from "@stll/api-contract/chat-local-run-question";

import type { ChatRuntime } from "@/features/chat/chat-runtime";

/**
 * The question a run on the member's computer paused the thread's turn on,
 * and how to answer it, for the transcript to show in place of the question's
 * tool call. A surface without it (no local runs there) shows that call as
 * any other tool call.
 */
export type ChatLocalRunQuestionContextValue = {
  pause: LocalRunQuestionPause | null;
  answer: ChatRuntime["answerLocalRunQuestion"];
};

export const ChatLocalRunQuestionContext =
  createContext<ChatLocalRunQuestionContextValue | null>(null);
