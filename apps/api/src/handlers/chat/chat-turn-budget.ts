import { EventType, maxIterations } from "@tanstack/ai";
import type { AgentLoopStrategy, ChatMiddleware } from "@tanstack/ai";

import { CHAT_TURN_BUDGET } from "@stll/chat-limits";
import type { ChatTurnBudget, ChatTurnPauseReason } from "@stll/chat-limits";

import type {
  ChatMessage,
  ChatTurnOutcome,
  ChatTurnSpend,
} from "@/api/handlers/chat/types";

export type ChatTurnPause = Extract<ChatTurnOutcome, { type: "paused" }>;

/**
 * The agent loop's own ceiling on model calls in one request. It sits above
 * the budget: a turn reaches `CHAT_TURN_BUDGET.maxToolCalls` first, at a step
 * boundary, and pauses there instead of ending on the engine's ceiling with
 * no answer.
 */
export const CHAT_TURN_LOOP_STRATEGY: AgentLoopStrategy = maxIterations(
  CHAT_TURN_BUDGET.maxToolCalls * 2,
);

const exhaustedCap = ({
  budget,
  promptTokens,
  toolCalls,
}: {
  budget: ChatTurnBudget;
  promptTokens: number;
  toolCalls: number;
}): ChatTurnPauseReason | null => {
  if (toolCalls >= budget.maxToolCalls) {
    return "tool-calls";
  }
  if (promptTokens >= budget.maxPromptTokens) {
    return "prompt-tokens";
  }
  return null;
};

/**
 * The budget of one assistant turn, the one place a chat turn's autonomous
 * work is bounded. It counts the turn as a whole: the calls and spend its
 * stored message already holds (a request that answers an approval continues
 * the same turn) plus what this request adds. Its middleware ends the agent
 * loop at the first step boundary where a cap is reached, whatever grant let
 * the calls run, and the run settles the turn as `paused`
 * (`processServerChatStream` reads `pause()`).
 *
 * A step's calls run together, so the turn stops at the boundary after the
 * step that reaches a cap. A request that answers an approval of a turn
 * already at its cap runs the approved call and the model call after it,
 * then pauses at the next boundary: the engine starts that model call before
 * any hook can end the loop.
 */
export const createChatTurnBudget = ({
  budget = CHAT_TURN_BUDGET,
  owningMessage,
}: {
  budget?: ChatTurnBudget | undefined;
  /** The stored assistant message this request continues, if it continues one. */
  owningMessage: ChatMessage | undefined;
}) => {
  const toolCallIds = new Set<string>(
    owningMessage?.parts.flatMap((part) =>
      part.type === "tool-call" ? [part.id] : [],
    ),
  );
  let promptTokens = owningMessage?.metadata?.turnSpend?.promptTokens ?? 0;
  let pause: ChatTurnPause | null = null;

  const middleware: ChatMiddleware = {
    name: "stella-chat-turn-budget",
    onChunk: (_ctx, chunk) => {
      // Calls a harness or provider runs itself reach the turn as chunks
      // only; engine-run calls arrive here too, and the set counts each once.
      if (chunk.type === EventType.TOOL_CALL_START) {
        toolCallIds.add(chunk.toolCallId);
      }
    },
    onToolPhaseComplete: (_ctx, info) => {
      for (const call of info.toolCalls) {
        toolCallIds.add(call.id);
      }
    },
    onUsage: (_ctx, usage) => {
      promptTokens += usage.promptTokens;
    },
    onShouldContinue: (_ctx, state) => {
      // Only a step that ran tools would call the model again; a final
      // answer ends the loop on its own and is not a pause.
      if (state.lastTurnToolCallCount === 0) {
        return undefined;
      }
      const reason = exhaustedCap({
        budget,
        promptTokens,
        toolCalls: toolCallIds.size,
      });
      if (reason === null) {
        return undefined;
      }
      pause = { type: "paused", reason, toolCalls: toolCallIds.size };
      return false;
    },
  };

  return {
    budget,
    middleware,
    /** The pause the loop ended on, or null when no cap ended it. */
    pause: (): ChatTurnPause | null => pause,
    /** What the turn has spent so far, stored with its message. */
    spend: (): ChatTurnSpend => ({ promptTokens }),
  };
};

export type ChatTurnBudgetRun = ReturnType<typeof createChatTurnBudget>;
