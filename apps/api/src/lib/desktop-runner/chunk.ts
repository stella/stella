import { EventSchema } from "@ag-ui/core/schemas";
import { EventType } from "@tanstack/ai";
import * as v from "valibot";

import {
  harnessQuestionSchema,
  questionAnswersRefusal,
} from "@stll/agent-engine";
import {
  type ChatLocalRunQuestionReply,
  chatLocalRunQuestionReplySchema,
} from "@stll/api-contract/chat-run-target";
import type { DesktopRunnerChunk } from "@stll/api-contract/desktop-runner";

import { isRecord } from "@/api/lib/type-guards";

const requestIdSchema = v.pipe(v.string(), v.uuid());
const questionsSchema = v.pipe(v.array(harnessQuestionSchema), v.minLength(1));

type HarnessQuestions = v.InferOutput<typeof questionsSchema>;

/** The blocking question a run paused on, as its interrupt names it. */
export type QuestionPause = {
  type: "question";
  /** The request id an answer names; the interrupt's id. */
  requestId: string;
  /** The tool call the question is persisted as, when the interrupt names it. */
  toolCallId: string | undefined;
  questions: HarnessQuestions;
};

/**
 * The blocking question among a pause's interrupts: the one whose
 * `metadata.kind` is `"question"`. Its id is the request id an answer names;
 * the desktop mints it as a UUID, so a question without one cannot be
 * answered and is malformed, as is one whose `metadata.questions` an answer
 * cannot be checked against. The harness asks one question request at a
 * time, so two are malformed too. The live chunk and a stored turn's resume
 * snapshot carry the same interrupts, so both read alike.
 */
export const questionInterruptOf = (
  interrupts: readonly unknown[],
): { type: "none" } | QuestionPause | { type: "malformed" } => {
  const pauses = interrupts.filter(
    (interrupt): interrupt is Record<string, unknown> =>
      isRecord(interrupt) &&
      isRecord(interrupt["metadata"]) &&
      interrupt["metadata"]["kind"] === "question",
  );
  const [interrupt, ...rest] = pauses;
  if (interrupt === undefined) {
    return { type: "none" };
  }
  const requestId = interrupt["id"];
  const toolCallId = interrupt["toolCallId"];
  const metadata = interrupt["metadata"];
  const questions = v.safeParse(
    questionsSchema,
    isRecord(metadata) ? metadata["questions"] : undefined,
  );
  return rest.length === 0 &&
    v.is(requestIdSchema, requestId) &&
    (toolCallId === undefined || typeof toolCallId === "string") &&
    questions.success
    ? {
        type: "question",
        requestId,
        toolCallId,
        questions: questions.output,
      }
    : { type: "malformed" };
};

/**
 * Whether a chunk pauses its run for a blocking question: a `RUN_FINISHED`
 * whose interrupt has `metadata.kind: "question"` (`questionInterruptOf`).
 */
export const questionPauseOf = (
  chunk: unknown,
): { type: "none" } | QuestionPause | { type: "malformed" } => {
  if (
    !isRecord(chunk) ||
    chunk["type"] !== EventType.RUN_FINISHED ||
    !isRecord(chunk["outcome"]) ||
    chunk["outcome"]["type"] !== "interrupt" ||
    !Array.isArray(chunk["outcome"]["interrupts"])
  ) {
    return { type: "none" };
  }
  const interrupts: unknown[] = chunk["outcome"]["interrupts"];
  return questionInterruptOf(interrupts);
};

/**
 * The answers a resume payload gives a paused question, or why they are
 * refused: a payload that is not `chatLocalRunQuestionReplySchema`, or
 * answers the harness would refuse (`questionAnswersRefusal`). The chat
 * continuation check and the run's answer delivery both read a reply here,
 * so the two can never disagree. The reason names question ids and payload
 * fields only, never what was answered.
 */
export const questionReplyOf = (
  payload: unknown,
  questions: HarnessQuestions,
):
  | { type: "answers"; answers: ChatLocalRunQuestionReply["answers"] }
  | { type: "refused"; reason: string } => {
  const reply = v.safeParse(chatLocalRunQuestionReplySchema, payload);
  if (!reply.success) {
    return {
      type: "refused",
      reason: `The answer is not a question reply: ${reply.issues
        .map((issue) => v.getDotPath(issue) ?? "payload")
        .join(", ")}`,
    };
  }
  const refusal = questionAnswersRefusal(questions, reply.output.answers);
  return refusal === null
    ? { type: "answers", answers: reply.output.answers }
    : { type: "refused", reason: refusal };
};

/**
 * Whether a chunk's fields match its AG-UI event, the protocol TanStack's
 * `StreamChunk` is. The wire contract checks only the chunk's type; the event
 * log stores only chunks a reader can fold, so a malformed one is refused
 * before it is acknowledged, while the desktop can still be fixed and resend.
 * Fields TanStack adds beyond AG-UI are kept and left to the folding reader.
 * A question pause must name the one request an answer can match.
 */
export const isFoldableChunk = (chunk: DesktopRunnerChunk): boolean =>
  EventSchema.safeParse(chunk).success &&
  questionPauseOf(chunk).type !== "malformed";
