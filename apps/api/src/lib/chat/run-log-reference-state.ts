import type { UIMessage } from "@tanstack/ai";

export const CHAT_RUN_REFERENCE_STATE_MAX_BYTES = 64 * 1024;

export type ChatRunReferenceState = {
  through: string;
  decisionIds: string[];
  messages: UIMessage[];
};
