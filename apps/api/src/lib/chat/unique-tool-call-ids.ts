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
//
// The history a request carries is only a window of the thread: the send
// window and compaction leave older turns out, and compaction inside a run
// can drop the run's own earlier calls. So the ids a call must not reuse come
// from a `ToolCallIdLedger` the caller seeds with every id the thread holds
// and binds to the run's adapter (`withRunToolCallIds`); a request through an
// adapter without one falls back to the ids its own history carries. The
// ledger never rides in the request, so no adapter can send it to a provider.

/**
 * Where each chunk type carries a tool call id: the call a chunk starts, the
 * call it names, a `toolCallId` inside a custom event's value, ids inside a
 * list only the engine writes (a snapshot, an interrupted run's outcome), or
 * none.
 */
type CallIdCarrier = "engine" | "names" | "none" | "starts" | "value";

export const CALL_ID_CARRIER = {
  ACTIVITY_DELTA: "none",
  ACTIVITY_SNAPSHOT: "none",
  CUSTOM: "value",
  MESSAGES_SNAPSHOT: "engine",
  RAW: "none",
  REASONING_ENCRYPTED_VALUE: "none",
  REASONING_END: "none",
  REASONING_MESSAGE_CHUNK: "none",
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
  SUBAGENT_ERROR: "engine",
  SUBAGENT_FINISHED: "engine",
  SUBAGENT_STARTED: "engine",
  TEXT_MESSAGE_CHUNK: "none",
  TEXT_MESSAGE_CONTENT: "none",
  TEXT_MESSAGE_END: "none",
  TEXT_MESSAGE_START: "none",
  TOOL_CALL_ARGS: "names",
  // TanStack's stream processor does not read the AG-UI chunk shorthand, so
  // a call named only here never enters the thread.
  TOOL_CALL_CHUNK: "none",
  TOOL_CALL_END: "names",
  TOOL_CALL_RESULT: "names",
  TOOL_CALL_START: "starts",
} as const satisfies Record<StreamChunk["type"], CallIdCarrier>;

/** The call ids `messages` already hold. */
const callIdsOf = (messages: readonly ModelMessage[]): string[] =>
  messages.flatMap((message) => [
    ...arrayOrEmpty(message.toolCalls).map(({ id }) => id),
    ...(message.toolCallId === undefined ? [] : [message.toolCallId]),
  ]);

/**
 * Every tool call id one thread holds, the ones its current run starts
 * included. One ledger serves every request of one run (fallback attempts
 * too), so a call started early in the run stays taken after compaction drops
 * it from a later request's history.
 */
export class ToolCallIdLedger {
  readonly #taken: Set<string>;

  constructor(threadCallIds: Iterable<string>) {
    this.#taken = new Set(threadCallIds);
  }

  has(id: string): boolean {
    return this.#taken.has(id);
  }

  take(id: string): void {
    this.#taken.add(id);
  }
}

type ToolCallIdRequest = {
  /** The run's ledger; absent when the caller keeps none. */
  ledger: ToolCallIdLedger | undefined;
  messages: readonly ModelMessage[];
};

/** The run's ledger with `request`'s history taken, or one for the request
 *  alone when the caller keeps none. */
const ledgerFor = ({ ledger, messages }: ToolCallIdRequest) => {
  const taken = ledger ?? new ToolCallIdLedger([]);
  for (const id of callIdsOf(messages)) {
    taken.take(id);
  }
  return taken;
};

/** `id` with the first numeric suffix no call in `taken` holds. */
const freshCallId = (id: string, taken: ToolCallIdLedger): string => {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${id}_${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
};

/**
 * `chunks` with every tool call id unique within the thread `request` belongs
 * to: a call whose id the run's ledger, the request's history, or an earlier
 * call of this response already holds gets a fresh one, and every later chunk
 * that names it follows.
 *
 * @yields Each chunk of `chunks`, its call ids unique within the thread.
 */
export const withUniqueToolCallIds = async function* (
  chunks: AsyncIterable<StreamChunk>,
  request: ToolCallIdRequest,
): AsyncIterable<StreamChunk> {
  const taken = ledgerFor(request);
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
          taken.take(chunk.toolCallId);
          yield chunk;
          break;
        }
        const fresh = freshCallId(chunk.toolCallId, taken);
        taken.take(fresh);
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
