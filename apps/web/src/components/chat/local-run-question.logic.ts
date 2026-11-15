import type { LocalRunQuestionDraft } from "@stll/api-contract/chat-local-run-question";
import {
  CHAT_LOCAL_RUN_QUESTION_TOOL,
  type ChatLocalRunQuestion,
} from "@stll/api-contract/chat-run-target";

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

/**
 * The member's own words typed into a question card that closed without
 * sending, one question's words per line, to keep in the composer. A
 * secret's words are never kept.
 */
export const unsentOwnWords = (
  questions: readonly ChatLocalRunQuestion[],
  drafts: Readonly<Record<string, LocalRunQuestionDraft>>,
): string =>
  questions
    .flatMap((question) => {
      const draft = Object.hasOwn(drafts, question.id)
        ? drafts[question.id]
        : undefined;
      const words = draft?.text.trim() ?? "";
      return question.secret || words === "" ? [] : [words];
    })
    .join("\n");
