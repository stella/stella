import {
  EventType,
  modelMessageToUIMessage,
  uiMessagesToWire,
} from "@tanstack/ai";
import type { StreamChunk, ToolCall } from "@tanstack/ai";
import { panic, Result } from "better-result";

import {
  CHAT_TOOL_DECLINED_ERROR,
  isDeclinedChatToolCall,
} from "@stll/api-contract/chat";
import { Temporal } from "@stll/time";

import type { SafeDbError } from "@/api/db/safe-db";
import { toPersistableChatMessage } from "@/api/handlers/chat/chat-message-parts";
import { COMPACTION_SUMMARY_MESSAGE_ID } from "@/api/handlers/chat/compaction";
import type { ClientMessage } from "@/api/handlers/chat/message-page";
import type {
  ChatMessage,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { classifyAIError } from "@/api/lib/ai-error";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

const SERVED_HISTORY_READ_FAILED = failureSink({
  event: "chat.snapshot.served_history_read_failed",
  expected: [],
});

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

type ChatToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: "tool-call" }
>;

/** A denied call's approval, as the stored message keeps it. */
export type DeniedApproval = NonNullable<
  Extract<ChatToolCallPart, { approval?: unknown }>["approval"]
>;

/** The calls `messages` hold whose approval the user denied, by call id. */
export const findDeniedApprovals = (
  messages: readonly ChatMessage[],
): ReadonlyMap<string, DeniedApproval> =>
  new Map(
    messages.flatMap(({ parts }) =>
      parts.flatMap((part): [string, DeniedApproval][] =>
        part.type === "tool-call" &&
        "approval" in part &&
        isDeclinedChatToolCall(part)
          ? [[part.id, part.approval]]
          : [],
      ),
    ),
  );

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

/**
 * Presents every call the history denied as denied in the snapshots the
 * client reads (see `keepDeniedApprovals`). It runs on the client-visible
 * stream, after its refs are resolved, so the parts it builds carry what the
 * rest of the stream shows rather than the model-facing tokens.
 *
 * @yields Each chunk of `source`, a snapshot with its denied calls as stored.
 */
export const keepDeniedApprovalsOnScreen = async function* ({
  deniedApprovals,
  source,
}: {
  deniedApprovals: ReadonlyMap<string, DeniedApproval>;
  source: AsyncIterable<StreamChunk>;
}): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    yield chunk.type === EventType.MESSAGES_SNAPSHOT
      ? {
          ...chunk,
          messages: keepDeniedApprovals({
            deniedApprovals,
            messages: chunk.messages,
          }),
        }
      : chunk;
  }
};

/** What the client-visible stream shows of the history a run was handed,
 *  each message as the thread's page serves it (`loadClientMessages`). */
export type StoredHistory = {
  /**
   * The messages accepting the turn rewrote (the turn a new message
   * superseded). The stream opens with a snapshot of just these, so the page
   * holds them as stored however the run then ends. The page keeps every
   * message a snapshot leaves out where it held it (the web app's
   * `keepPostedMessagesInSnapshots`), so its older pages and cursor stand.
   */
  rewrittenOnAcceptance: readonly ClientMessage[];
  /**
   * Every stored message the run was handed except the one it continues, by
   * id, as served. Read at the first snapshot: only a snapshot repeats the
   * history, and most runs carry none. The page already holds each of these,
   * so a snapshot leaves them out (`withoutServedHistory`).
   */
  loadServed: () => Promise<
    Result<ReadonlyMap<string, ClientMessage>, SafeDbError>
  >;
};

/** A served message as a snapshot carries it: in UI form, which the client
 *  takes as is. AG-UI requires `content`; the client reads `parts`. */
const servedSnapshotMessage = (message: ClientMessage): SnapshotMessage => {
  switch (message.role) {
    case "activity": {
      if (
        message.parts.length !== 1 ||
        message.parts.at(0)?.type !== "activity"
      ) {
        return panic(
          "An activity message must contain exactly one activity part",
        );
      }
      const activity = uiMessagesToWire(
        [
          {
            id: message.id,
            role: "activity",
            parts: message.parts,
            ...(message.metadata === undefined
              ? {}
              : { metadata: message.metadata }),
          },
        ],
        { includeActivity: true },
      ).at(0);
      if (!activity) {
        return panic("A served activity has no activity part");
      }
      return activity;
    }
    case "assistant":
    case "system":
    case "user":
      return { ...message, role: message.role, content: "" };
    default:
      message.role satisfies never;
      return panic(`Unhandled served role: ${String(message.role)}`);
  }
};

/**
 * `messages` without the stored history the page already holds: every
 * message `served` holds other than one acceptance `rewritten`, which keeps
 * its served form. The engine's copies of what served messages carry go too:
 * the tool messages answering their calls and the reasoning ahead of them.
 *
 * The page keeps a message a snapshot leaves out (the web app's
 * `keepPostedMessagesInSnapshots`), so repeating the history adds nothing but
 * size: a snapshot that carried it would grow with the thread until the
 * delivery log could no longer store it as one entry. A rewritten message is
 * the exception because the page restores an omitted message from the copy it
 * posted, from before the rewrite; it is one message, so it does not grow with
 * the thread. What remains besides it is the message the run continues and
 * what the run itself wrote, which a page load cannot know yet.
 */
const withoutServedHistory = ({
  messages,
  rewritten,
  served,
}: {
  messages: readonly SnapshotMessage[];
  rewritten: ReadonlySet<string>;
  served: ReadonlyMap<string, ClientMessage>;
}): SnapshotMessage[] => {
  const servedCallIds = new Set(
    [...served.values()].flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
    ),
  );
  const presented: SnapshotMessage[] = [];
  for (const message of messages) {
    // Interrupt snapshots include the model-only summary as a user message.
    // Keep it in the engine's history, but never present it as a posted turn.
    if (message.id === COMPACTION_SUMMARY_MESSAGE_ID) {
      continue;
    }
    if (message.role === "tool" && servedCallIds.has(message.toolCallId)) {
      continue;
    }
    const stored = served.get(message.id);
    if (stored === undefined) {
      presented.push(message);
      continue;
    }
    while (presented.at(-1)?.role === "reasoning") {
      presented.pop();
    }
    if (rewritten.has(message.id)) {
      presented.push(servedSnapshotMessage(stored));
    }
  }
  return presented;
};

/**
 * Presents the history a run was handed as the thread's page holds it, never
 * as the engine holds it: no snapshot repeats a stored message the run does
 * not continue, so the page keeps each as a page load serves it and a
 * snapshot's size does not grow with the thread. A turn whose acceptance
 * rewrote a message the page holds opens with that message as stored, and
 * every snapshot carries it so.
 *
 * @yields Each chunk of `source`, its snapshots without the stored history.
 */
export const presentStoredHistory = async function* ({
  history: { loadServed, rewrittenOnAcceptance },
  source,
}: {
  history: StoredHistory;
  source: AsyncIterable<StreamChunk>;
}): AsyncIterable<StreamChunk> {
  let opening: StreamChunk | undefined =
    rewrittenOnAcceptance.length === 0
      ? undefined
      : {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: rewrittenOnAcceptance.map(servedSnapshotMessage),
          timestamp: Temporal.Now.instant().epochMilliseconds,
        };
  const rewritten: ReadonlySet<string> = new Set(
    rewrittenOnAcceptance.map(({ id }) => id),
  );
  let served: ReadonlyMap<string, ClientMessage> | undefined;
  for await (const chunk of source) {
    if (opening !== undefined && chunk.type !== EventType.RUN_STARTED) {
      yield opening;
      opening = undefined;
    }
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      yield chunk;
      continue;
    }
    if (served === undefined) {
      const loaded = await loadServed();
      if (Result.isError(loaded)) {
        observeFailure(loaded.error, { sink: SERVED_HISTORY_READ_FAILED });
        const kind = classifyAIError(loaded.error);
        yield {
          type: EventType.RUN_ERROR,
          code: kind,
          message: kind,
          timestamp: Temporal.Now.instant().epochMilliseconds,
        };
        return;
      }
      served = loaded.value;
    }
    yield {
      ...chunk,
      messages: withoutServedHistory({
        messages: chunk.messages,
        rewritten,
        served,
      }),
    };
  }
  if (opening !== undefined) {
    yield opening;
  }
};

type EnsureAssistantMessageStartProps = {
  getOrCreateMessageId: () => SafeId<"chatMessage">;
  source: AsyncIterable<PublicStreamChunk>;
};

/** The chunk that tells the client which message the turn writes. */
export const assistantMessageStartChunk = (messageId: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_START,
  messageId,
  role: "assistant",
  timestamp: Temporal.Now.instant().epochMilliseconds,
});

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
        yield assistantMessageStartChunk(messageId);
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
 *
 * TanStack also splits every assistant message it replays at each tool
 * result, and every copy keeps the message's id. The client keeps one message
 * per id, so the snapshot carries exactly one assistant message per id, at
 * the position of that id's first copy; each copy's reasoning moves ahead of
 * it, where the client attaches reasoning to the next assistant message.
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
  const groupId = (message: AssistantSnapshotMessage): string => {
    if (existingMessageIds.has(message.id)) {
      return message.id;
    }
    const mergedId = mapMessageId(message.id);
    snapshotMessageIds.set(message.id, mergedId);
    return mergedId;
  };
  const groups = new Map<string, AssistantSnapshotGroup>();
  const groupsByFirstCopy = new Map<SnapshotMessage, AssistantSnapshotGroup>();
  const order: SnapshotMessage[] = [];
  let reasoning: SnapshotMessage[] = [];
  for (const message of messages) {
    if (message.role === "reasoning") {
      reasoning.push(message);
      continue;
    }
    if (message.role !== "assistant") {
      order.push(...reasoning, message);
      reasoning = [];
      continue;
    }
    const id = groupId(message);
    const group = groups.get(id);
    if (group === undefined) {
      const created: AssistantSnapshotGroup = {
        copies: [message],
        id,
        reasoning,
      };
      groups.set(id, created);
      groupsByFirstCopy.set(message, created);
      order.push(message);
    } else {
      group.copies.push(message);
      group.reasoning.push(...reasoning);
    }
    reasoning = [];
  }
  order.push(...reasoning);
  const result: SnapshotMessage[] = [];
  for (const message of order) {
    const group = groupsByFirstCopy.get(message);
    if (group === undefined) {
      result.push(message);
      continue;
    }
    result.push(...group.reasoning, mergeCopies(group));
  }
  return result;
};

type AssistantSnapshotGroup = {
  copies: [AssistantSnapshotMessage, ...AssistantSnapshotMessage[]];
  id: string;
  reasoning: SnapshotMessage[];
};

/**
 * Joins the copies' text and tool calls in document order. Identity comes
 * from the first copy, but TanStack keeps per-call provider metadata on each
 * copy's `metadata.tanstack.toolCallMetadata`, so that map is unioned.
 */
const mergeCopies = ({
  copies,
  id,
}: AssistantSnapshotGroup): AssistantSnapshotMessage => {
  const contents: string[] = [];
  const toolCalls: NonNullable<AssistantSnapshotMessage["toolCalls"]> = [];
  const toolCallMetadata: Record<string, unknown> = {};
  for (const copy of copies) {
    if (typeof copy.content === "string" && copy.content.length > 0) {
      contents.push(copy.content);
    }
    if (copy.toolCalls !== undefined) {
      toolCalls.push(...copy.toolCalls);
    }
    Object.assign(toolCallMetadata, readToolCallMetadata(copy));
  }
  const { content: _content, toolCalls: _toolCalls, ...identity } = copies[0];
  const metadata = withToolCallMetadata({
    metadata: identity.metadata,
    toolCallMetadata,
  });
  return {
    ...identity,
    id,
    ...(metadata === undefined ? {} : { metadata }),
    ...(contents.length === 0 ? {} : { content: contents.join("\n\n") }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
};

const readToolCallMetadata = (
  message: AssistantSnapshotMessage,
): Record<string, unknown> | undefined => {
  if (!("metadata" in message) || !isRecord(message.metadata)) {
    return undefined;
  }
  const tanstack = message.metadata["tanstack"];
  if (!isRecord(tanstack) || !isRecord(tanstack["toolCallMetadata"])) {
    return undefined;
  }
  return tanstack["toolCallMetadata"];
};

const withToolCallMetadata = ({
  metadata,
  toolCallMetadata,
}: {
  metadata: AssistantSnapshotMessage["metadata"];
  toolCallMetadata: Record<string, unknown>;
}): AssistantSnapshotMessage["metadata"] => {
  if (Object.keys(toolCallMetadata).length === 0) {
    return metadata;
  }
  const base = isRecord(metadata) ? metadata : {};
  const tanstack = isRecord(base["tanstack"]) ? base["tanstack"] : {};
  return { ...base, tanstack: { ...tanstack, toolCallMetadata } };
};

/** Preserve the stored approval decision while the SDK rebuilds terminal
 *  results from the snapshot's tool messages. */
const keepDeniedApprovals = ({
  deniedApprovals,
  messages,
}: {
  deniedApprovals: ReadonlyMap<string, DeniedApproval>;
  messages: readonly SnapshotMessage[];
}): SnapshotMessage[] => {
  if (deniedApprovals.size === 0) {
    return [...messages];
  }
  return messages.flatMap((message): SnapshotMessage[] => {
    if (message.role === "tool") {
      return [message];
    }
    // Reconciled UI snapshots already carry the stored denial and results.
    // Rebuilding them from model toolCalls would discard those result parts.
    if (
      message.role !== "assistant" ||
      "parts" in message ||
      message.toolCalls === undefined
    ) {
      return [message];
    }
    const { toolCalls } = message;
    if (!toolCalls.some(({ id }) => deniedApprovals.has(id))) {
      return [message];
    }
    const toolCallMetadata = readToolCallMetadata(message) ?? {};
    const denials = deniedOutputs({ deniedApprovals, messages });
    const { parts } = modelMessageToUIMessage(
      {
        content: typeof message.content === "string" ? message.content : null,
        role: "assistant",
        toolCalls: toolCalls.map((call) =>
          withCallMetadata(call, toolCallMetadata[call.id]),
        ),
      },
      message.id,
    );
    // Still a valid AG-UI assistant message, now also carrying `parts`: the
    // client's `aguiSnapshotMessageToUIMessage` takes a message with `parts`
    // as it is instead of rebuilding it from `toolCalls`.
    const inUIForm = {
      ...message,
      parts: parts.map((part) =>
        part.type === "tool-call" ? asStoredDenial(part, denials) : part,
      ),
    };
    return [inUIForm];
  });
};

type SnapshotToolCall = NonNullable<
  AssistantSnapshotMessage["toolCalls"]
>[number];

/** A wire tool call as the engine's own call type, with the provider
 *  metadata the snapshot keeps beside it. */
const withCallMetadata = (
  call: SnapshotToolCall,
  metadata: unknown,
): ToolCall => ({
  function: call.function,
  id: call.id,
  type: "function",
  ...(metadata === undefined ? {} : { metadata }),
});

type UIToolCallPart = Extract<
  ReturnType<typeof modelMessageToUIMessage>["parts"][number],
  { type: "tool-call" }
>;

/** A denied call's approval and the output the engine settled it with. */
type DeniedOutput = { approval: DeniedApproval; output: unknown };

/**
 * The output each denied call settles with, as the engine stores it: the
 * content of the tool message answering it, parsed as the engine's stream
 * processor parses a result, or the engine's own denial when no message
 * answers it yet.
 */
const deniedOutputs = ({
  deniedApprovals,
  messages,
}: {
  deniedApprovals: ReadonlyMap<string, DeniedApproval>;
  messages: readonly SnapshotMessage[];
}): ReadonlyMap<string, DeniedOutput> => {
  const answers = new Map(
    messages.flatMap((message): [string, unknown][] =>
      message.role === "tool" ? [[message.toolCallId, message.content]] : [],
    ),
  );
  return new Map(
    [...deniedApprovals].map(([callId, approval]): [string, DeniedOutput] => [
      callId,
      { approval, output: storedResultOutput(answers.get(callId)) },
    ]),
  );
};

/** A tool message's content as the engine stores it on the call it
 *  answers: JSON text parsed, anything else as it is; the engine's denial
 *  when no message answers the call. */
const storedResultOutput = (content: unknown): unknown => {
  if (content === undefined) {
    return { error: CHAT_TOOL_DECLINED_ERROR };
  }
  if (typeof content !== "string") {
    return content;
  }
  return Result.try((): unknown => JSON.parse(content)).unwrapOr(content);
};

/**
 * A rebuilt call as the stored thread holds it when its approval was denied:
 * settled as an error carrying the denial (`declineToolCall`), so the
 * snapshot and a reload show the same call.
 */
const asStoredDenial = (
  part: UIToolCallPart,
  denials: ReadonlyMap<string, DeniedOutput>,
): UIToolCallPart => {
  const denial = denials.get(part.id);
  if (denial === undefined) {
    return part;
  }
  const denied: UIToolCallPart = {
    ...part,
    approval: denial.approval,
    output: denial.output,
    state: "error",
  };
  return denied;
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
