import { EventSchema } from "@ag-ui/core/schemas";
import { EventType } from "@tanstack/ai";
import * as v from "valibot";

import { harnessQuestionSchema } from "@stll/agent-engine";
import type { DesktopRunnerChunk } from "@stll/api-contract/desktop-runner";

import { isRecord } from "@/api/lib/type-guards";

const requestIdSchema = v.pipe(v.string(), v.uuid());
const questionsSchema = v.pipe(v.array(harnessQuestionSchema), v.minLength(1));

/**
 * Whether a chunk pauses its run for a blocking question: a `RUN_FINISHED`
 * whose interrupt has `metadata.kind: "question"`. The interrupt's id is the
 * request id an answer names; the desktop mints it as a UUID, so a question
 * without one cannot be answered and its chunk is refused, as is one whose
 * `metadata.questions` an answer cannot be checked against. The harness asks
 * one question request at a time, so a chunk carrying two is refused too.
 */
export const questionPauseOf = (
  chunk: unknown,
):
  | { type: "none" }
  | {
      type: "question";
      requestId: string;
      questions: v.InferOutput<typeof questionsSchema>;
    }
  | { type: "malformed" } => {
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
  const metadata = interrupt["metadata"];
  const questions = v.safeParse(
    questionsSchema,
    isRecord(metadata) ? metadata["questions"] : undefined,
  );
  return rest.length === 0 &&
    v.is(requestIdSchema, requestId) &&
    questions.success
    ? { type: "question", requestId, questions: questions.output }
    : { type: "malformed" };
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
