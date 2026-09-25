import {
  convertMessagesToModelMessages,
  EventType,
  maxIterations,
  modelMessagesToUIMessages,
  uiMessagesToWire,
} from "@tanstack/ai";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { panic } from "better-result";

import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicStreamChunk,
  StreamChatChunksOptions,
} from "@/api/lib/chat/tanstack-chat-runtime";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

// The one owner of valid-path chat fixtures: messages snapshots and stream
// chunk sequences as TanStack's own engine and converters produce them. A
// hand-written snapshot agrees with the engine only until the engine changes,
// so valid fixtures come only from here, branded, and
// `scripts/chat-fixture-guard.ts` rejects a snapshot literal anywhere else.
// Edge cases the engine really produces (an assistant message split at every
// tool result, strict-mode null arguments) come through these builders too.
// Input no engine would produce goes through `unsafeFixture`, which names why.

const validChatFixture = Symbol("validChatFixture");

/** A fixture one of this module's builders produced. */
export type ValidChatFixture<T> = T & { readonly [validChatFixture]: true };

const brand = <T extends object>(value: T): ValidChatFixture<T> => {
  Object.defineProperty(value, validChatFixture, { value: true });
  // SAFETY: the brand property was defined on `value` just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as ValidChatFixture<T>;
};

type MessagesSnapshotChunk = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>;

/**
 * The messages snapshot the engine builds from `history` at an interrupt:
 * every message converted to model messages (where TanStack splits an
 * assistant message at each tool result, every copy keeping its id), back to
 * UI messages, then to the wire.
 */
export const buildEngineSnapshot = (
  history: readonly UIMessage[],
): ValidChatFixture<MessagesSnapshotChunk> =>
  brand({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: uiMessagesToWire(
      modelMessagesToUIMessages(convertMessagesToModelMessages([...history])),
      { includeSnapshotStructuredOutput: true },
    ),
  });

/**
 * The chunks the real `chat()` engine emits for a scripted model over
 * `messages` and `tools`: its own tool execution, approval interrupts and
 * interrupt snapshots included.
 */
export const buildEngineChunks = async ({
  messages,
  tools = [],
  turns,
}: {
  messages: readonly UIMessage[];
  tools?: NonNullable<StreamChatChunksOptions["tools"]>;
  turns: readonly ScriptedTurn[];
}): Promise<ValidChatFixture<PublicStreamChunk[]>> => {
  const chunks: PublicStreamChunk[] = [];
  for await (const chunk of streamChatChunks({
    abortController: new AbortController(),
    adapter: createScriptedTextAdapter(turns),
    agentLoopStrategy: maxIterations(turns.length),
    messages: [...messages],
    runId: `run-${Bun.randomUUIDv7()}`,
    threadId: `thread-${Bun.randomUUIDv7()}`,
    tools,
  })) {
    chunks.push(chunk);
  }
  return brand(chunks);
};

const MIN_UNSAFE_FIXTURE_REASON_LENGTH = 12;

/**
 * A fixture no builder can produce because no engine emits it: malformed wire
 * input, or one member of an exhaustive state matrix. `reason` says which,
 * and is what the fixture guard reads to let the literal through.
 */
export const unsafeFixture = <T>(reason: string, value: T): T =>
  reason.trim().length < MIN_UNSAFE_FIXTURE_REASON_LENGTH
    ? panic("unsafeFixture needs a reason a reviewer can check")
    : value;
