import type { UIMessage } from "@tanstack/ai";

export type ChatRunCheckpointedReferenceState = {
  type: "checkpointed";
  through: string;
  decisionIds: string[];
  messages: {
    id: string;
    role: Exclude<UIMessage["role"], "activity">;
    parts: Extract<UIMessage["parts"][number], { type: "text" | "thinking" }>[];
  }[];
};

export type ChatRunRescanReferenceState = {
  type: "rescan-required";
  from: string;
  through: string;
};

export type ChatRunTrackedReferenceState =
  ChatRunCheckpointedReferenceState | ChatRunRescanReferenceState;

export type ChatRunReferenceState =
  { type: "legacy" } | ChatRunTrackedReferenceState;
