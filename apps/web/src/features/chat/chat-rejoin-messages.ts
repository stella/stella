import type { MessagePart, UIMessage } from "@tanstack/ai-client";
import { replaceEqualDeep } from "@tanstack/react-query";
import { panic } from "better-result";

const TOOL_CALL_PROGRESS = {
  "awaiting-input": 0,
  "input-streaming": 1,
  "input-complete": 2,
  "approval-requested": 3,
  "approval-responded": 4,
  complete: 5,
  error: 5,
} as const satisfies Record<
  Extract<MessagePart, { type: "tool-call" }>["state"],
  number
>;

const RESULT_PROGRESS = {
  streaming: 0,
  complete: 1,
  error: 1,
} as const satisfies Record<
  Extract<MessagePart, { type: "tool-result" }>["state"],
  number
>;

const STRUCTURED_PROGRESS = {
  streaming: 0,
  complete: 1,
  error: 1,
} as const satisfies Record<
  Extract<MessagePart, { type: "structured-output" }>["status"],
  number
>;

const SUBAGENT_PROGRESS = {
  running: 0,
  suspended: 1,
  finished: 2,
  error: 2,
} as const satisfies Record<
  Extract<MessagePart, { type: "subagent" }>["subagent"]["status"],
  number
>;

const sameJsonValue = (shown: unknown, replayed: unknown): boolean =>
  replaceEqualDeep(shown, replayed) === shown;

type RejoinPartComparison<Part = MessagePart> = { shown: Part; replayed: Part };

const hasCaughtUpToolCall = ({
  shown,
  replayed,
}: RejoinPartComparison<
  Extract<MessagePart, { type: "tool-call" }>
>): boolean => {
  if (
    replayed.id !== shown.id ||
    replayed.name !== shown.name ||
    !(
      replayed.arguments.startsWith(shown.arguments) ||
      (TOOL_CALL_PROGRESS[shown.state] >=
        TOOL_CALL_PROGRESS["input-complete"] &&
        TOOL_CALL_PROGRESS[replayed.state] >=
          TOOL_CALL_PROGRESS["input-complete"] &&
        shown.input !== undefined &&
        replayed.input !== undefined &&
        sameJsonValue(shown.input, replayed.input))
    )
  ) {
    return false;
  }
  return (
    TOOL_CALL_PROGRESS[replayed.state] >= TOOL_CALL_PROGRESS[shown.state] &&
    (TOOL_CALL_PROGRESS[shown.state] < TOOL_CALL_PROGRESS.complete ||
      replayed.state === shown.state) &&
    (shown.output === undefined ||
      sameJsonValue(shown.output, replayed.output)) &&
    (shown.approval === undefined ||
      (replayed.approval?.id === shown.approval.id &&
        replayed.approval.needsApproval === shown.approval.needsApproval &&
        (shown.approval.approved === undefined ||
          replayed.approval.approved === shown.approval.approved)))
  );
};

const hasCaughtUpStructuredOutput = ({
  shown,
  replayed,
}: RejoinPartComparison<
  Extract<MessagePart, { type: "structured-output" }>
>): boolean =>
  STRUCTURED_PROGRESS[replayed.status] >= STRUCTURED_PROGRESS[shown.status] &&
  (shown.status === "streaming" || replayed.status === shown.status) &&
  replayed.raw.startsWith(shown.raw) &&
  (shown.reasoning === undefined ||
    replayed.reasoning?.startsWith(shown.reasoning) === true) &&
  (shown.data === undefined || sameJsonValue(shown.data, replayed.data)) &&
  (shown.partial === undefined ||
    (replayed.raw !== shown.raw && replayed.partial !== undefined) ||
    sameJsonValue(shown.partial, replayed.partial) ||
    (replayed.status === "complete" && replayed.data !== undefined)) &&
  (shown.errorMessage === undefined ||
    replayed.errorMessage === shown.errorMessage);

/** Compare the entire rendered part prefix, including cards and their lifecycle.
 * Atomic media/resource parts must return intact; streaming parts may advance. */
const hasCaughtUpPart = ({
  shown,
  replayed,
}: RejoinPartComparison): boolean => {
  switch (shown.type) {
    case "text":
    case "thinking":
      return (
        replayed.type === shown.type &&
        replayed.content.startsWith(shown.content)
      );
    case "tool-call":
      return (
        replayed.type === "tool-call" &&
        hasCaughtUpToolCall({ shown, replayed })
      );
    case "tool-result":
      return (
        replayed.type === "tool-result" &&
        replayed.toolCallId === shown.toolCallId &&
        RESULT_PROGRESS[replayed.state] >= RESULT_PROGRESS[shown.state] &&
        (shown.state === "streaming" || replayed.state === shown.state) &&
        (typeof shown.content === "string"
          ? typeof replayed.content === "string" &&
            replayed.content.startsWith(shown.content)
          : sameJsonValue(shown.content, replayed.content))
      );
    case "structured-output":
      return (
        replayed.type === "structured-output" &&
        hasCaughtUpStructuredOutput({ shown, replayed })
      );
    case "subagent":
      return (
        replayed.type === "subagent" &&
        replayed.subagent.id === shown.subagent.id &&
        (SUBAGENT_PROGRESS[replayed.subagent.status] >=
          SUBAGENT_PROGRESS[shown.subagent.status] ||
          (shown.subagent.status === "suspended" &&
            replayed.subagent.status === "running")) &&
        shown.subagent.messages.every((message) => {
          const candidate = replayed.subagent.messages.find(
            ({ id }) => id === message.id,
          );
          return (
            candidate !== undefined &&
            hasCaughtUpParts({
              shown: message.parts,
              replayed: candidate.parts,
            })
          );
        })
      );
    case "image":
    case "audio":
    case "video":
    case "document":
    case "ui-resource":
      return replayed.type === shown.type && sameJsonValue(shown, replayed);
    default:
      return panic(shown satisfies never);
  }
};

type RejoinPartsComparison = {
  shown: readonly MessagePart[];
  replayed: readonly MessagePart[];
};

const hasCaughtUpParts = ({
  shown,
  replayed,
}: RejoinPartsComparison): boolean =>
  shown.every((part, index) => {
    const candidate = replayed.at(index);
    return (
      candidate !== undefined &&
      hasCaughtUpPart({ shown: part, replayed: candidate })
    );
  });

/** Keep the assistant's displayed parts until replay has caught up to all of
 * them. Equal or progressed tool states then replace the held message. */
export const keepShownRejoinMessages = <Message extends UIMessage>(
  shown: readonly Message[],
  replayed: Message[],
): Message[] => {
  const assistant = shown.at(-1);
  if (assistant?.role !== "assistant") {
    return replayed;
  }
  const candidate = replayed.find(({ id }) => id === assistant.id);
  if (candidate === undefined) {
    return [...replayed, assistant];
  }
  if (hasCaughtUpParts({ shown: assistant.parts, replayed: candidate.parts })) {
    return replayed;
  }
  return replayed.map((message) =>
    message.id === assistant.id ? assistant : message,
  );
};
