import { EventType } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

import { arrayOrEmpty } from "@/api/lib/array";
import { isRecord } from "@/api/lib/type-guards";

// A thread holds each tool call id once. Some providers number calls per
// response (`call_0`, `call_1`, ...), so a later response, or a later call in
// the same response, can reuse an id the thread already holds. The engine,
// persistence, approvals and the page all find a call by its id, so a reused
// one would attach the new call to the earlier one. Every adapter's stream
// passes through here (`withProviderStreamContract`), which gives a reused id
// a fresh one before anything else reads it. The provider reads the fresh id
// back in later history, which is sound: an id is opaque as long as a call
// and its result carry the same one.

/**
 * Where each chunk type carries a tool call id: the call a chunk starts, the
 * call it names, a `toolCallId` inside a custom event's value, ids inside a
 * list only the engine writes (a snapshot, an interrupted run's outcome), or
 * none.
 */
type CallIdCarrier = "engine" | "names" | "none" | "starts" | "value";

export const CALL_ID_CARRIER = {
  CUSTOM: "value",
  MESSAGES_SNAPSHOT: "engine",
  REASONING_ENCRYPTED_VALUE: "none",
  REASONING_END: "none",
  REASONING_MESSAGE_CONTENT: "none",
  REASONING_MESSAGE_END: "none",
  REASONING_MESSAGE_START: "none",
  REASONING_START: "none",
  RUN_ERROR: "none",
  RUN_FINISHED: "engine",
  RUN_STARTED: "none",
  STATE_DELTA: "none",
  STATE_SNAPSHOT: "none",
  STEP_FINISHED: "none",
  STEP_STARTED: "none",
  TEXT_MESSAGE_CONTENT: "none",
  TEXT_MESSAGE_END: "none",
  TEXT_MESSAGE_START: "none",
  TOOL_CALL_ARGS: "names",
  TOOL_CALL_END: "names",
  TOOL_CALL_RESULT: "names",
  TOOL_CALL_START: "starts",
} as const satisfies Record<StreamChunk["type"], CallIdCarrier>;

/** The call ids `messages` already hold. */
const callIdsOf = (messages: readonly ModelMessage[]): Set<string> =>
  new Set(
    messages.flatMap((message) => [
      ...arrayOrEmpty(message.toolCalls).map(({ id }) => id),
      ...(message.toolCallId === undefined ? [] : [message.toolCallId]),
    ]),
  );

/** `id` with the first numeric suffix no call in `taken` holds. */
const freshCallId = (id: string, taken: ReadonlySet<string>): string => {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
};

/**
 * `chunks` with every tool call id unique within the thread `history` belongs
 * to: a call whose id `history` or an earlier call of this response already
 * holds gets a fresh one, and every later chunk that names it follows.
 *
 * @yields Each chunk of `chunks`, its call ids unique within the thread.
 */
export const withUniqueToolCallIds = async function* (
  chunks: AsyncIterable<StreamChunk>,
  history: readonly ModelMessage[],
): AsyncIterable<StreamChunk> {
  const taken = callIdsOf(history);
  const renamed = new Map<string, string>();
  const idOf = (id: string): string => renamed.get(id) ?? id;
  for await (const chunk of chunks) {
    const carrier = CALL_ID_CARRIER[chunk.type];
    switch (carrier) {
      case "starts": {
        if (chunk.type !== EventType.TOOL_CALL_START) {
          panic(`${chunk.type} does not start a tool call`);
        }
        if (!taken.has(chunk.toolCallId)) {
          taken.add(chunk.toolCallId);
          yield chunk;
          break;
        }
        const fresh = freshCallId(chunk.toolCallId, taken);
        taken.add(fresh);
        renamed.set(chunk.toolCallId, fresh);
        yield { ...chunk, toolCallId: fresh };
        break;
      }
      case "names": {
        if (
          chunk.type !== EventType.TOOL_CALL_ARGS &&
          chunk.type !== EventType.TOOL_CALL_END &&
          chunk.type !== EventType.TOOL_CALL_RESULT
        ) {
          panic(`${chunk.type} does not name a tool call`);
        }
        yield { ...chunk, toolCallId: idOf(chunk.toolCallId) };
        break;
      }
      case "value": {
        if (chunk.type !== EventType.CUSTOM) {
          panic(`${chunk.type} carries no value`);
        }
        const value: unknown = chunk.value;
        const toolCallId: unknown = isRecord(value)
          ? value["toolCallId"]
          : undefined;
        yield typeof toolCallId === "string" && isRecord(value)
          ? { ...chunk, value: { ...value, toolCallId: idOf(toolCallId) } }
          : chunk;
        break;
      }
      case "engine": {
        // Only the engine writes calls into these, from what it read: an
        // adapter's own copy would name a call by an id it no longer has.
        const namesCalls =
          chunk.type === EventType.MESSAGES_SNAPSHOT ||
          (chunk.type === EventType.RUN_FINISHED &&
            chunk.outcome?.type === "interrupt");
        if (namesCalls && renamed.size > 0) {
          panic(`An adapter sent ${chunk.type} after a call was renamed`);
        }
        yield chunk;
        break;
      }
      case "none": {
        yield chunk;
        break;
      }
      default: {
        carrier satisfies never;
        panic(`Unhandled call id carrier: ${String(carrier)}`);
      }
    }
  }
};
