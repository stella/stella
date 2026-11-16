import type { ChatClientState, ToolCallState } from "@tanstack/ai-client";
import { panic } from "better-result";

import type { ChatTurnTiming } from "@stll/api-contract/chat";
import {
  getChatToolActivityCategory,
  isUserInputChatToolName,
} from "@stll/api-contract/chat-tool-activity";
import { getChatTurnDurationMs } from "@stll/api-contract/chat-turn-duration";

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
  /** When this page sent the turn's message, on the `performance.now()`
   *  clock; `null` for a turn the page joined. */
  sentAt: number | null;
};

/**
 * How long the running turn has taken, on the `performance.now()` clock, the
 * same for a turn on stella and one on the member's computer. A turn this
 * page sent counts from the send. A turn it joined (a reload) counts from
 * the server's start when its reading has arrived, and from when the page
 * first showed it before then. Nothing here waits for a streamed chunk.
 */
export const liveTurnElapsedMs = ({
  sentAt,
  timing,
  shownAt,
  now,
}: {
  sentAt: number | null;
  timing: ChatTurnTiming | null | undefined;
  shownAt: number;
  now: number;
}): number => {
  if (sentAt !== null) {
    return Math.max(0, now - sentAt);
  }
  const fromServer =
    timing === null || timing === undefined
      ? undefined
      : getChatTurnDurationMs(timing, now);
  return fromServer ?? Math.max(0, now - shownAt);
};

export type TurnLiveStatus =
  { type: "none" } | { type: "live"; phase: TurnActivePhase };

/** Maps every SDK chat state to the turn's sole live-status line. */
export const turnLiveStatus = (
  turn: Pick<ChatTurnStatusInput, "phase" | "state">,
): TurnLiveStatus => {
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
