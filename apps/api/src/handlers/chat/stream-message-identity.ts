import { EventType } from "@tanstack/ai";

import { Temporal } from "@stll/time";

import { toPersistableChatMessage } from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatMessage,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord } from "@/api/lib/type-guards";

export type MessageIdMapper = (messageId: string) => SafeId<"chatMessage">;

export const createChatMessageIdMapper = (
  createId: () => SafeId<"chatMessage"> = () => createSafeId<"chatMessage">(),
): MessageIdMapper => {
  let responseId: SafeId<"chatMessage"> | null = null;
  return (_messageId) => {
    if (!responseId) {
      responseId = createId();
    }
    return responseId;
  };
};

/**
 * The id every assistant message a run emits is persisted under. A fresh turn
 * mints one id for the whole turn. A continuation (an approval, a client
 * tool) resumes the assistant message the client replayed: the SDK writes the
 * approved tool's result onto that message, and the model's follow-up has to
 * persist with it, so the run folds into the owning message. A follow-up
 * persisted on its own would leave the owning message's call without a
 * result, and every later resume in the thread would then rebuild that call
 * as a pending interrupt and reject the client's batch.
 */
export const createTurnMessageIdMapper = (
  owningAssistantMessageId: SafeId<"chatMessage"> | undefined,
): MessageIdMapper =>
  owningAssistantMessageId === undefined
    ? createChatMessageIdMapper()
    : () => owningAssistantMessageId;

export const normalizeFinalAssistantMessageId = ({
  mapMessageId,
  message,
}: {
  mapMessageId: MessageIdMapper;
  message: ChatMessage;
}): PersistableChatMessage =>
  toPersistableChatMessage({ ...message, id: mapMessageId(message.id) });

type RemapOutgoingMessageIdsProps = {
  existingMessageIds?: ReadonlySet<string> | undefined;
  mapMessageId: MessageIdMapper;
  source: AsyncIterable<PublicStreamChunk>;
};

export const remapOutgoingMessageIds = async function* ({
  existingMessageIds = new Set(),
  mapMessageId,
  source,
}: RemapOutgoingMessageIdsProps): AsyncIterable<PublicStreamChunk> {
  const snapshotMessageIds = new Map<string, SafeId<"chatMessage">>();
  for await (const chunk of source) {
    yield remapChunkMessageId({
      chunk,
      existingMessageIds,
      mapMessageId,
      snapshotMessageIds,
    });
  }
};

type EnsureAssistantMessageStartProps = {
  getOrCreateMessageId: () => SafeId<"chatMessage">;
  source: AsyncIterable<PublicStreamChunk>;
};

export const ensureAssistantMessageStart = async function* ({
  getOrCreateMessageId,
  source,
}: EnsureAssistantMessageStartProps): AsyncIterable<PublicStreamChunk> {
  let hasAssistantMessageStart = false;

  for await (const chunk of source) {
    if (chunk.type === EventType.TEXT_MESSAGE_START) {
      hasAssistantMessageStart = true;
      yield chunk;
      continue;
    }

    if (!hasAssistantMessageStart) {
      const messageId = getAssistantStartMessageId({
        chunk,
        getOrCreateMessageId,
      });
      if (messageId !== null) {
        hasAssistantMessageStart = true;
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
          timestamp: Temporal.Now.instant().epochMilliseconds,
        };
      }
    }

    yield chunk;
  }
};

const getAssistantStartMessageId = ({
  chunk,
  getOrCreateMessageId,
}: {
  chunk: PublicStreamChunk;
  getOrCreateMessageId: () => SafeId<"chatMessage">;
}): string | null => {
  if (hasMessageId(chunk)) {
    return chunk.messageId;
  }

  if (chunk.type === EventType.TOOL_CALL_START) {
    return typeof chunk.parentMessageId === "string"
      ? chunk.parentMessageId
      : getOrCreateMessageId();
  }

  if (chunk.type === EventType.STEP_FINISHED) {
    return getOrCreateMessageId();
  }

  return null;
};

type StreamChunkWithMessageId = PublicStreamChunk & { messageId: string };

const hasMessageId = (
  chunk: PublicStreamChunk,
): chunk is StreamChunkWithMessageId =>
  "messageId" in chunk && typeof chunk.messageId === "string";

type SnapshotMessage = Extract<
  PublicStreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>["messages"][number];
type AssistantSnapshotMessage = Extract<SnapshotMessage, { role: "assistant" }>;

/**
 * A native snapshot carries one assistant message per model iteration, but the
 * turn is persisted as ONE assistant message (every text and tool-call part of
 * every iteration, under the id `mapMessageId` fixes for the turn). The client
 * continues the persisted message, so the snapshot must present the same
 * shape: the run's new assistant messages fold into that one message, and
 * their tool messages keep anchoring by `toolCallId`. In a continuation that
 * message is the owning one the snapshot already carries from history, so
 * the run's messages fold into it rather than beside it.
 */
const mergeSnapshotAssistantMessages = ({
  existingMessageIds,
  mapMessageId,
  messages,
  snapshotMessageIds,
}: {
  existingMessageIds: ReadonlySet<string>;
  mapMessageId: MessageIdMapper;
  messages: readonly SnapshotMessage[];
  snapshotMessageIds: Map<string, SafeId<"chatMessage">>;
}): SnapshotMessage[] => {
  const isNewAssistant = (
    message: SnapshotMessage,
  ): message is AssistantSnapshotMessage =>
    message.role === "assistant" && !existingMessageIds.has(message.id);
  const newAssistantMessages = messages.filter(isNewAssistant);
  const first = newAssistantMessages.at(0);
  if (first === undefined) {
    return [...messages];
  }
  const mergedId = mapMessageId(first.id);
  const owning = messages.find(
    (message): message is AssistantSnapshotMessage =>
      message.role === "assistant" && message.id === mergedId,
  );
  const base = owning ?? first;
  const contents: string[] = [];
  const toolCalls: NonNullable<AssistantSnapshotMessage["toolCalls"]> = [];
  for (const message of owning === undefined
    ? newAssistantMessages
    : [owning, ...newAssistantMessages]) {
    if (message !== owning) {
      snapshotMessageIds.set(message.id, mergedId);
    }
    if (typeof message.content === "string" && message.content.length > 0) {
      contents.push(message.content);
    }
    if (message.toolCalls !== undefined) {
      toolCalls.push(...message.toolCalls);
    }
  }
  const { content: _content, toolCalls: _toolCalls, ...identity } = base;
  const merged: SnapshotMessage = {
    ...identity,
    id: mergedId,
    ...(contents.length === 0 ? {} : { content: contents.join("\n\n") }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
  const result: SnapshotMessage[] = [];
  for (const message of messages) {
    if (message === base) {
      result.push(merged);
      continue;
    }
    if (!isNewAssistant(message)) {
      result.push(message);
    }
  }
  return result;
};

const remapChunkMessageId = ({
  chunk,
  existingMessageIds,
  mapMessageId,
  snapshotMessageIds,
}: {
  chunk: PublicStreamChunk;
  existingMessageIds: ReadonlySet<string>;
  mapMessageId: MessageIdMapper;
  snapshotMessageIds: Map<string, SafeId<"chatMessage">>;
}): PublicStreamChunk => {
  if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
    return {
      ...chunk,
      messages: mergeSnapshotAssistantMessages({
        existingMessageIds,
        mapMessageId,
        messages: chunk.messages,
        snapshotMessageIds,
      }),
    };
  }
  const remapMessageId = (messageId: string): string =>
    existingMessageIds.has(messageId)
      ? messageId
      : (snapshotMessageIds.get(messageId) ?? mapMessageId(messageId));
  const remappedChunk = hasMessageId(chunk)
    ? { ...chunk, messageId: remapMessageId(chunk.messageId) }
    : chunk;

  const remappedParentChunk =
    "parentMessageId" in remappedChunk &&
    typeof remappedChunk.parentMessageId === "string"
      ? {
          ...remappedChunk,
          parentMessageId: remapMessageId(remappedChunk.parentMessageId),
        }
      : remappedChunk;

  if (
    remappedParentChunk.type !== EventType.CUSTOM ||
    !isRecord(remappedParentChunk.value)
  ) {
    return remappedParentChunk;
  }

  const messageId = remappedParentChunk.value["messageId"];
  if (typeof messageId !== "string") {
    return remappedParentChunk;
  }

  return {
    ...remappedParentChunk,
    value: {
      ...remappedParentChunk.value,
      messageId: remapMessageId(messageId),
    },
  };
};
