// Where a provider request answers each tool call: right after the step that
// made it. Pure over message parts, with no app environment behind it, so the
// scripts that read chat messages can import it.

import {
  modelMessageToUIMessage,
  uiMessageToModelMessages,
} from "@tanstack/ai";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toolCallStepOf } from "@/api/lib/chat/tool-call-step";

type ToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
type ToolResultPart = Extract<ChatPart, { type: "tool-result" }>;

/**
 * The answer the SDK gives a call that holds no result part (a denial, an
 * approval still to run, an output kept on the call), read from the SDK's
 * own conversion so it stays byte for byte what the SDK sends. Undefined when
 * the SDK gives the call no answer.
 */
const trailingAnswerOf = (call: ToolCallPart): ToolResultPart | undefined => {
  const answer = uiMessageToModelMessages({
    id: call.id,
    parts: [call],
    role: "assistant",
  }).find(
    (message) => message.role === "tool" && message.toolCallId === call.id,
  );
  if (answer === undefined || typeof answer.content !== "string") {
    return undefined;
  }
  return modelMessageToUIMessage(answer, call.id).parts.find(
    (part) => part.type === "tool-result",
  );
};

const carriesApproval = (part: ChatPart | undefined): boolean =>
  part?.type === "tool-call" && "approval" in part;

const stepOf = (call: ToolCallPart): string | undefined =>
  toolCallStepOf("metadata" in call ? call.metadata : undefined);

/**
 * Whether `part` is a call of the same step as `call`. Two calls in a row
 * belong to different steps when they name different ones; calls stored
 * before steps were recorded name none, and read as one step.
 */
const callOfSameStep = (
  call: ToolCallPart,
  part: ChatPart | undefined,
): boolean => part?.type === "tool-call" && stepOf(part) === stepOf(call);

/**
 * Where the answer to `call`, at `callIndex`, belongs: among its step's
 * results, the tool results right after the step's calls (the calls in a row
 * that name its step, `callOfSameStep`). The request that
 * answered the call sent the step's results stored by then, and after them,
 * in call order, the answers to the step's approvals; an approved call's
 * result is stored later, in place of its answer. So the answer goes before
 * the first stored result of an approval call made after it, else after the
 * step's results: `parts.length` when the step ends the message.
 */
const answerIndexInStep = (
  parts: readonly ChatPart[],
  call: ToolCallPart,
  callIndex: number,
): number => {
  let end = callIndex + 1;
  while (callOfSameStep(call, parts[end])) {
    end += 1;
  }
  const resultsStart = end;
  while (parts[end]?.type === "tool-result") {
    end += 1;
  }
  for (let index = resultsStart; index < end; index += 1) {
    const result = parts[index];
    const answered =
      result?.type === "tool-result"
        ? parts.findIndex(
            (part) =>
              part.type === "tool-call" && part.id === result.toolCallId,
          )
        : -1;
    if (answered > callIndex && carriesApproval(parts[answered])) {
      return index;
    }
  }
  return end;
};

/**
 * Each call answered in its own step, including results reconstructed by a
 * snapshot and answers synthesized by the SDK (a denial, most often). The
 * SDK can append either after later steps, so a request rebuilt from the
 * thread no longer begins with the request that answered the call. Only the
 * provider request reads this: the stored message keeps its parts.
 * Idempotent; returns the input when nothing moves.
 */
export const answerCallsInTheirStep = (
  inputParts: readonly ChatPart[],
): readonly ChatPart[] => {
  let parts = inputParts;
  // SDK snapshots append results after later steps' calls. Provider history
  // must keep each result with its own step, whether stored or synthesized.
  for (const result of inputParts) {
    if (result.type !== "tool-result") {
      continue;
    }
    const callIndex = parts.findIndex(
      (part) => part.type === "tool-call" && part.id === result.toolCallId,
    );
    const call = parts[callIndex];
    const resultIndex = parts.indexOf(result);
    if (
      call?.type !== "tool-call" ||
      !parts
        .slice(callIndex + 1, resultIndex)
        .some(
          (part) => part.type === "tool-call" && !callOfSameStep(call, part),
        )
    ) {
      continue;
    }
    const reordered = [...parts];
    reordered.splice(resultIndex, 1);
    reordered.splice(answerIndexInStep(reordered, call, callIndex), 0, result);
    parts = reordered;
  }
  const answeredIds = new Set(
    parts.flatMap((part) =>
      part.type === "tool-result" && part.state !== "streaming"
        ? [part.toolCallId]
        : [],
    ),
  );
  // Each answer with the index of the part it goes before, in call order.
  const answers: { answer: ToolResultPart; at: number }[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type !== "tool-call" || answeredIds.has(part.id)) {
      continue;
    }
    const answer = trailingAnswerOf(part);
    const at = answerIndexInStep(parts, part, index);
    // A step that ends the message already has the SDK's answers after it.
    if (answer !== undefined && at < parts.length) {
      answers.push({ answer, at });
    }
  }
  return answers.length === 0
    ? parts
    : parts.flatMap((part, index) => [
        ...answers.flatMap(({ answer, at }) => (at === index ? [answer] : [])),
        part,
      ]);
};

/** `messages` with every assistant message's calls answered in their own
 *  step (`answerCallsInTheirStep`), for a provider request. */
export const answerHistoryCallsInTheirStep = (
  messages: readonly ChatMessage[],
): ChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = answerCallsInTheirStep(message.parts);
    return parts === message.parts
      ? message
      : { ...message, parts: [...parts] };
  });
