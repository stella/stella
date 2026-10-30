import type { ChatClientState, ToolCallState } from "@tanstack/ai-client";
import { panic } from "better-result";

import type { ChatTurnTiming } from "@stll/api-contract/chat";

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
      return { type: "waiting-for-input" };
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
