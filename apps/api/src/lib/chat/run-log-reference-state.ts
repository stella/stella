import type { UIMessage } from "@tanstack/ai";

export type ChatRunCheckpointedReferenceState = {
  type: "checkpointed";
  through: string;
  decisionIds: string[];
  messages: UIMessage[];
};

export type ChatRunReferenceState =
  { type: "legacy" } | ChatRunCheckpointedReferenceState;
