import type { UIMessage } from "@tanstack/ai";

export const CHAT_RUN_REFERENCE_STATE_MAX_BYTES = 64 * 1024;

export type ChatRunCheckpointedReferenceState = {
  type: "checkpointed";
  through: string;
  decisionIds: string[];
  messages: UIMessage[];
};

export type ChatRunReferenceState =
  { type: "legacy" } | ChatRunCheckpointedReferenceState;
