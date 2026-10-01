// What counts as a model's answer: visible text or a call, read off the
// chunks a model streams. Both places that decide whether a run came back
// empty read it: the attempt middleware, which chooses whether to try the
// fallback model, and the terminal guard in `stream-chat.ts`, which fails
// the turn. Every other part an assistant message shows reaches it through
// a call, so a chunk that only reports on one (its arguments, its result, a
// custom event) is not counted, and neither is thinking.

import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

/** What each chunk says about an answer. `text` answers only when its delta
 *  holds more than whitespace. */
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
