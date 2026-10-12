import { EventType, uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk, UIMessage as StreamUIMessage } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";

type SnapshotChunk = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>;
type SnapshotMessage = SnapshotChunk["messages"][number];
type ReasoningSnapshotMessage = Extract<SnapshotMessage, { role: "reasoning" }>;

// TanStack's wire discriminator for Anthropic's opaque redacted thinking.
const REDACTED_THINKING_ID_PREFIX = "redacted_thinking-";

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
        switch (message.role) {
          case "activity": {
            if (
              message.parts.length !== 1 ||
              message.parts.at(0)?.type !== "activity"
            ) {
              panic(
                "An activity message must contain exactly one activity part",
              );
            }
            restored.push(
              ...uiMessagesToWire([message], { includeActivity: true }),
            );
            continue;
          }
          case "assistant":
          case "system":
          case "user":
            // The client reads `parts`; keep the narrowed wire role.
            restored.push({ ...message, role: message.role, content: "" });
            break;
          default:
            message.role satisfies never;
            panic(`Unhandled posted role: ${String(message.role)}`);
        }
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

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The provider signature a reasoning message carries: the AG-UI field, or
 *  TanStack's metadata copy of it. */
const reasoningSignature = ({
  encryptedValue,
  metadata,
}: ReasoningSnapshotMessage): string | undefined => {
  const tanstack: unknown = metadata?.["tanstack"];
  return (
    nonEmptyString(encryptedValue) ??
    nonEmptyString(
      typeof tanstack === "object" && tanstack !== null
        ? Reflect.get(tanstack, "signature")
        : undefined,
    )
  );
};

/**
 * A snapshot's messages with each reasoning message as a thinking part that
 * names its own step.
 *
 * The client turns a reasoning message into a thinking part without a step,
 * and the next thinking step streamed onto that answer takes over the first
 * such part: TanStack adopts it as a stored part the stream is replaying. A
 * snapshot closes a run at an interrupt, so the reasoning of the run that
 * continues the answer is always a new step, and adopting would overwrite the
 * earlier step's reasoning on the page while the stored thread keeps both.
 * The part is keyed by the reasoning message's id, the key TanStack itself
 * gives reasoning that arrives without a step. A message a subagent owns is
 * left to the client's subagent handling.
 */
export const keepReasoningSteps = (
  snapshot: readonly SnapshotMessage[],
): SnapshotMessage[] =>
  snapshot.map((message) => {
    if (message.role !== "reasoning" || message.subagentRunId !== undefined) {
      return message;
    }
    const signature = reasoningSignature(message);
    // The stream processor's message type: its thinking part keeps a step,
    // which the client's narrower part type leaves out.
    const settled = {
      id: message.id,
      parts:
        message.content === "" && signature === undefined
          ? []
          : [
              {
                content: message.content,
                stepId: message.id,
                type: "thinking",
                ...(message.id.startsWith(REDACTED_THINKING_ID_PREFIX)
                  ? { redacted: true }
                  : {}),
                ...(signature === undefined ? {} : { signature }),
              },
            ],
      role: "assistant",
      ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    } as const satisfies StreamUIMessage;
    // AG-UI requires `content`; the client reads `parts`.
    return { ...settled, content: "" };
  });

/**
 * Which events replace the page's messages, per event type: an upstream event
 * added or renamed fails the typecheck until it is decided here.
 */
const REPLACES_MESSAGES = {
  ACTIVITY_DELTA: false,
  ACTIVITY_SNAPSHOT: false,
  CUSTOM: false,
  MESSAGES_SNAPSHOT: true,
  RAW: false,
  REASONING_ENCRYPTED_VALUE: false,
  REASONING_END: false,
  REASONING_MESSAGE_CHUNK: false,
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
  SUBAGENT_ERROR: false,
  SUBAGENT_FINISHED: false,
  SUBAGENT_STARTED: false,
  TEXT_MESSAGE_CHUNK: false,
  TEXT_MESSAGE_CONTENT: false,
  TEXT_MESSAGE_END: false,
  TEXT_MESSAGE_START: false,
  TOOL_CALL_ARGS: false,
  TOOL_CALL_CHUNK: false,
  TOOL_CALL_END: false,
  TOOL_CALL_RESULT: false,
  TOOL_CALL_START: false,
} as const satisfies Record<StreamChunk["type"], boolean>;

/**
 * `source` with every snapshot keeping the messages the page posted and the
 * step of every reasoning it carries.
 *
 * @yields Each chunk of `source`, a snapshot with the posted messages and the
 * reasoning steps kept.
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
      panic(`${chunk.type} replaces messages but is not a snapshot`);
    }
    yield {
      ...chunk,
      messages: keepPostedMessages(posted, keepReasoningSteps(chunk.messages)),
    };
  }
};
