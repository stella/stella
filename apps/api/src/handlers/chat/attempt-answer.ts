// What counts as a model's answer, for both places that decide whether a run
// came back empty: the attempt middleware, which watches the chunks a model
// streams and chooses whether to try the fallback model, and the terminal
// guard, which reads the assistant message the turn is about to persist.
// `attempt-answer.test.ts` drives the SDK's own stream processor to hold the
// two readings together.

import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";

/**
 * What each part says about an answer. `text` answers only when it holds
 * more than whitespace, `call` is a tool call (counted once, by id), and
 * `content` is anything else the user sees. Thinking is not an answer, and a
 * tool result belongs to a call the model made earlier.
 */
const PART_ANSWER_POLICY = {
  audio: "content",
  document: "content",
  image: "content",
  "structured-output": "content",
  subagent: "content",
  text: "text",
  thinking: "none",
  "tool-call": "call",
  "tool-result": "none",
  "ui-resource": "content",
  video: "content",
} as const satisfies Record<
  ChatPart["type"],
  "call" | "content" | "none" | "text"
>;

const mayAnswer = (part: ChatPart): boolean =>
  PART_ANSWER_POLICY[part.type] !== "none";

/** Whether a part the run added is an answer on its own. */
const partIsAnswer = (part: ChatPart): boolean => {
  const policy = PART_ANSWER_POLICY[part.type];
  switch (policy) {
    case "call":
    case "content":
      return true;
    case "none":
      return false;
    case "text":
      return part.type === "text" && part.content.trim().length > 0;
    default:
      policy satisfies never;
      return panic(`Unhandled part policy: ${String(policy)}`);
  }
};

type AttemptProducedAnswerOptions = {
  /** The parts the run produced or continued, as it ends. */
  after: readonly ChatPart[];
  /** The parts the message held before the run: empty for a fresh turn, the
   *  owning assistant message's for a continuation. */
  before: readonly ChatPart[];
};

/**
 * Whether a run added an answer to the message it wrote: visible text, a
 * tool call, or other user-visible content. Measured against what the message
 * held before the run, because a continuation's message already carries the
 * call the user answered, and that is not the model answering.
 *
 * Parts that can answer are matched by position: the SDK keeps the parts a
 * message held, in order, writes the run's text over a text part the message
 * ends with, and appends everything else. Where it puts a part that never
 * answers (thinking, a tool result) does not matter.
 * `attempt-answer.test.ts` pins that layout.
 */
export const attemptProducedAnswer = ({
  after,
  before,
}: AttemptProducedAnswerOptions): boolean => {
  const heldParts = before.filter(mayAnswer);
  for (const [index, part] of after.filter(mayAnswer).entries()) {
    const held = heldParts.at(index);
    if (held === undefined) {
      if (partIsAnswer(part)) {
        return true;
      }
      continue;
    }
    if (part.type === "text" && held.type === "text") {
      if (part.content !== held.content && partIsAnswer(part)) {
        return true;
      }
      continue;
    }
    if (
      part.type !== held.type ||
      (part.type === "tool-call" &&
        held.type === "tool-call" &&
        part.id !== held.id)
    ) {
      panic("A continued message no longer starts with the parts it held");
    }
  }
  return false;
};

type RunProducedAnswerOptions = {
  /** The history the run started from: the messages it may continue. */
  initialMessages: readonly ChatMessage[];
  /** The assistant message the run wrote, if it wrote one. */
  responseMessage: ChatMessage | null;
};

/** `attemptProducedAnswer` for a run's message against the one it continued. */
export const runProducedAnswer = ({
  initialMessages,
  responseMessage,
}: RunProducedAnswerOptions): boolean => {
  if (responseMessage === null) {
    return false;
  }
  const continued = initialMessages.find(({ id }) => id === responseMessage.id);
  return attemptProducedAnswer({
    after: responseMessage.parts,
    before: continued === undefined ? [] : continued.parts,
  });
};

/**
 * What each chunk a model streams says about an answer, by the same measure
 * as `attemptProducedAnswer`: visible text or a call. Every other part an
 * assistant message shows reaches it through a call, so a chunk that only
 * reports on one (its arguments, its result, a custom event) is not counted.
 */
const CHUNK_ANSWER_POLICY = {
  ACTIVITY_DELTA: "none",
  ACTIVITY_SNAPSHOT: "none",
  CUSTOM: "none",
  MESSAGES_SNAPSHOT: "none",
  RAW: "none",
  REASONING_ENCRYPTED_VALUE: "none",
  REASONING_END: "none",
  REASONING_MESSAGE_CHUNK: "none",
  REASONING_MESSAGE_CONTENT: "none",
  REASONING_MESSAGE_END: "none",
  REASONING_MESSAGE_START: "none",
  REASONING_START: "none",
  RUN_ERROR: "none",
  RUN_FINISHED: "none",
  RUN_STARTED: "none",
  STATE_DELTA: "none",
  STATE_SNAPSHOT: "none",
  STEP_FINISHED: "none",
  STEP_STARTED: "none",
  SUBAGENT_ERROR: "none",
  SUBAGENT_FINISHED: "none",
  SUBAGENT_STARTED: "call",
  TEXT_MESSAGE_CHUNK: "text",
  TEXT_MESSAGE_CONTENT: "text",
  TEXT_MESSAGE_END: "none",
  TEXT_MESSAGE_START: "none",
  TOOL_CALL_ARGS: "none",
  TOOL_CALL_CHUNK: "call",
  TOOL_CALL_END: "none",
  TOOL_CALL_RESULT: "none",
  TOOL_CALL_START: "call",
} as const satisfies Record<StreamChunk["type"], "call" | "none" | "text">;

/** Whether a chunk a model streamed carries an answer. */
export const chunkCarriesAnswer = (chunk: StreamChunk): boolean => {
  const policy = CHUNK_ANSWER_POLICY[chunk.type];
  switch (policy) {
    case "call":
      return true;
    case "none":
      return false;
    case "text":
      return (
        (chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
          chunk.type === EventType.TEXT_MESSAGE_CHUNK) &&
        chunk.delta !== undefined &&
        chunk.delta.trim().length > 0
      );
    default:
      policy satisfies never;
      return panic(`Unhandled chunk policy: ${String(policy)}`);
  }
};
