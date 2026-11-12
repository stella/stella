import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "@stll/api-contract/chat-run-target";

type ToolCallPartView = {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly state?: string;
};

/**
 * The tool call a paused question belongs to: the message's last question
 * call still waiting for its answer. A harness pauses on one question at a
 * time and resolves it once answered, so only the paused one is unresolved.
 */
export const localRunQuestionCallId = (
  parts: readonly ToolCallPartView[],
): string | null =>
  parts.findLast(
    (part) =>
      part.type === "tool-call" &&
      part.name === CHAT_LOCAL_RUN_QUESTION_TOOL &&
      part.state === "input-complete",
  )?.id ?? null;
