import type { ChatClientState, ToolCallState } from "@tanstack/ai-client";
import { panic } from "better-result";

import type { ChatTurnTiming } from "@stll/api-contract/chat";

import { getChatToolActivityCategory } from "@/components/chat/chat-activity.logic";
import { isUserInputChatToolName } from "@/components/chat/chat-ui-tools";
import type { ChatPart } from "@/components/chat/chat-ui-tools";

export type TurnActivePhase =
  | { type: "thinking" }
  | { type: "using-tool"; label: string }
  | { type: "analyzing-sources" }
  | { type: "writing" }
  | { type: "waiting-for-approval" }
  | { type: "waiting-for-input" };

export type ChatTurnStatusInput = {
  phase: TurnActivePhase | null;
  state: ChatClientState;
  timing?: ChatTurnTiming | null | undefined;
};

export type TurnLiveStatus =
  { type: "none" } | { type: "live"; phase: TurnActivePhase };

/** Maps every SDK chat state to the turn's sole live-status line. */
export const turnLiveStatus = (turn: ChatTurnStatusInput): TurnLiveStatus => {
  switch (turn.state) {
    case "ready":
    case "error":
      return { type: "none" };
    case "submitted":
      return { type: "live", phase: turn.phase ?? { type: "thinking" } };
    case "streaming":
      return { type: "live", phase: turn.phase ?? { type: "writing" } };
    default:
      return panic("Unhandled chat client state", {
        state: turn.state satisfies never,
      });
  }
};

/** Converts every SDK tool state without a permissive fallback. */
export const turnPhaseForTool = (
  state: ToolCallState,
  label: string,
): TurnActivePhase | null => {
  switch (state) {
    case "awaiting-input":
    case "input-streaming":
    case "input-complete":
      return { type: "using-tool", label };
    case "approval-requested":
      return { type: "waiting-for-approval" };
    case "approval-responded":
      return { type: "using-tool", label };
    case "complete":
    case "error":
      return null;
    default:
      return panic("Unhandled tool call state", {
        state: state satisfies never,
      });
  }
};

/** Latest active work wins; completed research hands off to source analysis. */
export const turnPhaseFromParts = (
  parts: readonly ChatPart[],
  toolLabel: (name: string) => string,
): TurnActivePhase => {
  for (const part of parts.toReversed()) {
    if (part.type === "tool-call") {
      const phase = turnPhaseForTool(part.state, toolLabel(part.name));
      if (phase !== null) {
        if (
          isUserInputChatToolName(part.name) &&
          part.state === "input-complete"
        ) {
          return { type: "waiting-for-input" };
        }
        return phase;
      }
    }
  }
  for (const part of parts.toReversed()) {
    switch (part.type) {
      case "text":
        if (part.content.trim()) {
          return { type: "writing" };
        }
        break;
      case "thinking":
        if (part.content.trim()) {
          return { type: "thinking" };
        }
        break;
      case "tool-call":
        if (
          part.state === "complete" &&
          getChatToolActivityCategory(part.name) === "research"
        ) {
          return { type: "analyzing-sources" };
        }
        break;
      case "structured-output":
      case "ui-resource":
        return { type: "writing" };
      case "activity":
      case "image":
      case "audio":
      case "video":
      case "document":
      case "tool-result":
      case "subagent":
        break;
      default:
        return panic("Unhandled chat part", { part: part satisfies never });
    }
  }
  return { type: "thinking" };
};
