// Where a provider request answers each tool call: right after the step that
// made it. Pure over message parts, with no app environment behind it, so the
// scripts that read chat messages can import it.

import { uiMessageToModelMessages } from "@tanstack/ai";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";

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
  return answer === undefined || typeof answer.content !== "string"
    ? undefined
    : {
        content: answer.content,
        state: "complete",
        toolCallId: call.id,
        type: "tool-result",
      };
};

const carriesApproval = (part: ChatPart | undefined): boolean =>
  part?.type === "tool-call" && "approval" in part;

/**
 * Where the answer to the call at `callIndex` belongs: among its step's
 * results, the tool results right after the step's calls. The request that
 * answered the call sent the step's results stored by then, and after them,
 * in call order, the answers to the step's approvals; an approved call's
 * result is stored later, in place of its answer. So the answer goes before
 * the first stored result of an approval call made after it, else after the
 * step's results: `parts.length` when the step ends the message.
 */
const answerIndexInStep = (
  parts: readonly ChatPart[],
  callIndex: number,
): number => {
  let end = callIndex + 1;
  while (parts[end]?.type === "tool-call") {
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
 * `parts` with each call the SDK answers only at the end of the message (a
 * denial, most often) answered in its own step instead. The SDK appends those
 * answers after the whole message, so once the message goes on past the
 * call's step a provider sees the call without its answer after it, and a
 * request rebuilt from the thread no longer begins with the request that
 * answered the call. Only the provider request reads this: the stored
 * message keeps its parts. Idempotent; returns `parts` when nothing moves.
 */
export const answerCallsInTheirStep = (
  parts: readonly ChatPart[],
): readonly ChatPart[] => {
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
    const at = answerIndexInStep(parts, index);
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
