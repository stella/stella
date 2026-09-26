import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";

type SnapshotChunk = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>;
type SnapshotMessage = SnapshotChunk["messages"][number];

/**
 * A snapshot's messages with every message the page posted put back where
 * the page held it.
 *
 * The server's snapshot is the engine's history, which leaves out what the
 * model is never shown: an answer that failed before any output, a turn a
 * new message replaced, messages compaction folded away. The client replaces
 * its messages with a snapshot, so those would vanish from the page until a
 * reload. A posted message missing from the snapshot goes back ahead of the
 * next posted message the snapshot holds; it carries its `parts`, which the
 * client takes as they are.
 */
export const keepPostedMessages = (
  posted: readonly UIMessage[],
  snapshot: readonly SnapshotMessage[],
): SnapshotMessage[] => {
  const inSnapshot = new Set(snapshot.map(({ id }) => id));
  if (posted.every(({ id }) => inSnapshot.has(id))) {
    return [...snapshot];
  }
  const postedIndex = new Map(posted.map(({ id }, index) => [id, index]));
  const restored: SnapshotMessage[] = [];
  const restore = (from: number, to: number) => {
    for (const message of posted.slice(from, to)) {
      if (!inSnapshot.has(message.id)) {
        // AG-UI requires `content`; the client reads `parts` instead.
        restored.push({ ...message, content: "" });
      }
    }
  };
  let next = 0;
  let afterLastPosted = 0;
  for (const message of snapshot) {
    const at = postedIndex.get(message.id);
    if (at !== undefined && at >= next) {
      restore(next, at);
      next = at + 1;
    }
    restored.push(message);
    if (at !== undefined) {
      afterLastPosted = restored.length;
    }
  }
  const tail = restored.splice(afterLastPosted);
  restore(next, posted.length);
  restored.push(...tail);
  return restored;
};

/**
 * Which events replace the page's messages, per event type: an upstream event
 * added or renamed fails the typecheck until it is decided here.
 */
const REPLACES_MESSAGES = {
  CUSTOM: false,
  MESSAGES_SNAPSHOT: true,
  REASONING_ENCRYPTED_VALUE: false,
  REASONING_END: false,
  REASONING_MESSAGE_CONTENT: false,
  REASONING_MESSAGE_END: false,
  REASONING_MESSAGE_START: false,
  REASONING_START: false,
  RUN_ERROR: false,
  RUN_FINISHED: false,
  RUN_STARTED: false,
  STATE_DELTA: false,
  STATE_SNAPSHOT: false,
  STEP_FINISHED: false,
  STEP_STARTED: false,
  TEXT_MESSAGE_CONTENT: false,
  TEXT_MESSAGE_END: false,
  TEXT_MESSAGE_START: false,
  TOOL_CALL_ARGS: false,
  TOOL_CALL_END: false,
  TOOL_CALL_RESULT: false,
  TOOL_CALL_START: false,
} as const satisfies Record<StreamChunk["type"], boolean>;

/**
 * `source` with every snapshot keeping the messages the page posted.
 *
 * @yields Each chunk of `source`, a snapshot with the posted messages kept.
 */
export const keepPostedMessagesInSnapshots = async function* (
  posted: readonly UIMessage[],
  source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (!REPLACES_MESSAGES[chunk.type]) {
      yield chunk;
      continue;
    }
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      return panic(`${chunk.type} replaces messages but is not a snapshot`);
    }
    yield { ...chunk, messages: keepPostedMessages(posted, chunk.messages) };
  }
};
