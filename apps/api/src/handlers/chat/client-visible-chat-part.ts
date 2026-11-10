import { EventType, type StreamChunk, wireSubagentInfo } from "@tanstack/ai";
import { panic, Result } from "better-result";

import {
  isUnsupportedChatPart,
  UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
} from "@stll/api-contract/chat";
import { supersededToolResults } from "@stll/api-contract/chat-tool-result-retention";

import {
  clientVisibleChatPart,
  isChatPart,
  retainSubagentResults,
  SUBAGENT_RESULT_RETENTION,
} from "@/api/handlers/chat/chat-message-parts";
import { isTanStackStreamEventType } from "@/api/handlers/chat/tanstack-chat-lifecycle";
import {
  projectSupersededPart,
  supersededCallOutputs,
} from "@/api/handlers/chat/tool-result-retention";
import { arrayOrEmpty } from "@/api/lib/array";

type SnapshotMessage = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>["messages"][number];

/** The sub-agent run a wire message belongs to (AG-UI `subagentRunId`), as
 *  the SDK tags a child's messages when it serializes a sub-agent part. */
const snapshotSubagentRunId = (message: SnapshotMessage): string | null => {
  if ("parts" in message) {
    return null;
  }
  const id: unknown = Reflect.get(message, "subagentRunId");
  return typeof id === "string" && id.length > 0 ? id : null;
};

const parseJsonContent = (content: unknown): unknown => {
  if (typeof content !== "string") {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(content));
  return Result.isError(parsed) ? undefined : parsed.value;
};

/**
 * A snapshot's sub-agent rows with each run's tool results kept as the run's
 * status allows (`SUBAGENT_RESULT_RETENTION`), as its stored part keeps them.
 * The SDK serializes a sub-agent part as its child's own wire messages, each
 * tagged with the run and its status, so a snapshot carries a child's results
 * as `tool` rows of the run, never as parts.
 */
const retainSubagentWireResults = (
  messages: readonly SnapshotMessage[],
): readonly SnapshotMessage[] => {
  const runs = new Map<string, SnapshotMessage[]>();
  for (const message of messages) {
    const runId = snapshotSubagentRunId(message);
    if (runId !== null) {
      runs.set(runId, [...(runs.get(runId) ?? []), message]);
    }
  }
  const projections = new Map<SnapshotMessage, unknown>();
  for (const run of runs.values()) {
    const status = run
      .map((message) => wireSubagentInfo(message)?.status)
      .find((candidate) => candidate !== undefined);
    const toolNames = new Map(
      run.flatMap((message) =>
        message.role === "assistant"
          ? arrayOrEmpty(message.toolCalls).map(
              (call) => [call.id, call.function.name] as const,
            )
          : [],
      ),
    );
    const superseded = supersededToolResults(
      run,
      (message) => {
        if (message.role !== "tool") {
          return null;
        }
        const toolName = toolNames.get(message.toolCallId);
        return toolName === undefined
          ? null
          : { output: parseJsonContent(message.content), toolName };
      },
      // A run whose tag carries no status keeps its newest result.
      status === undefined ? undefined : SUBAGENT_RESULT_RETENTION[status],
    );
    for (const [message, projection] of superseded) {
      projections.set(message, projection);
    }
  }
  if (projections.size === 0) {
    return messages;
  }
  return messages.map((message) => {
    const projection = projections.get(message);
    return projection === undefined || message.role !== "tool"
      ? message
      : { ...message, content: JSON.stringify(projection) };
  });
};

const clientVisibleSnapshotMessage = (
  message: SnapshotMessage,
): SnapshotMessage => {
  if (
    message.role === "activity" &&
    message.activityType === UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE
  ) {
    return { ...message, content: {} };
  }
  // Served history adds page UI parts to these AG-UI snapshot messages.
  if (
    (message.role === "assistant" ||
      message.role === "system" ||
      message.role === "user") &&
    "parts" in message &&
    Array.isArray(message.parts)
  ) {
    const parts: unknown[] = message.parts;
    const visibleParts = parts.map((part) =>
      isUnsupportedChatPart(part) ||
      (isChatPart(part) && part.type === "subagent")
        ? clientVisibleChatPart(part)
        : part,
    );
    if (visibleParts.some((part, index) => part !== parts.at(index))) {
      const visible = { parts: visibleParts };
      return { ...message, ...visible };
    }
  }
  return message;
};

const snapshotParts = (message: SnapshotMessage): unknown[] | null =>
  (message.role === "assistant" ||
    message.role === "system" ||
    message.role === "user") &&
  "parts" in message &&
  Array.isArray(message.parts)
    ? message.parts
    : null;

/**
 * A snapshot's messages with each superseded tool result projected, as the
 * message stores it (`chat-tool-result-retention`): on the parts of the
 * message that made the call, on the `tool` message the engine carries
 * beside them, and inside each sub-agent part's child messages. Without it,
 * a snapshot of a paused browsing turn would carry every page the turn read.
 */
const retainSnapshotToolResults = (
  messages: readonly SnapshotMessage[],
): readonly SnapshotMessage[] => {
  const projections = new Map<string, unknown>();
  const withParts = messages.map((message) => {
    const parts = snapshotParts(message);
    if (parts === null) {
      return message;
    }
    const superseded = supersededCallOutputs(parts.filter(isChatPart));
    for (const [callId, projection] of superseded) {
      projections.set(callId, projection);
    }
    // A sub-agent part's child keeps its results as the part stores them.
    const visibleParts = parts.map((part) => {
      if (!isChatPart(part)) {
        return part;
      }
      return part.type === "subagent"
        ? retainSubagentResults(part)
        : projectSupersededPart(part, superseded);
    });
    if (visibleParts.every((part, index) => part === parts.at(index))) {
      return message;
    }
    const visible = { parts: visibleParts };
    return { ...message, ...visible };
  });
  if (projections.size === 0) {
    return withParts;
  }
  return withParts.map((message) => {
    if (message.role !== "tool") {
      return message;
    }
    const projection = projections.get(message.toolCallId);
    return projection === undefined
      ? message
      : { ...message, content: JSON.stringify(projection) };
  });
};

/** Last server boundary for AG-UI events carrying stored message parts. */
export const clientVisibleStreamChunk = (chunk: StreamChunk): StreamChunk => {
  // An event the engine emits beyond the SDK's types carries no stored part.
  if (!isTanStackStreamEventType(chunk.type)) {
    return chunk;
  }
  switch (chunk.type) {
    case EventType.MESSAGES_SNAPSHOT: {
      const messages = retainSubagentWireResults(
        retainSnapshotToolResults(chunk.messages),
      ).map(clientVisibleSnapshotMessage);
      return messages.every(
        (message, index) => message === chunk.messages[index],
      )
        ? chunk
        : { ...chunk, messages };
    }
    case "ACTIVITY_SNAPSHOT":
      return chunk.activityType === UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE
        ? { ...chunk, content: {} }
        : chunk;
    case "ACTIVITY_DELTA":
      return chunk.activityType === UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE
        ? { ...chunk, patch: [] }
        : chunk;
    case "CUSTOM":
    case EventType.RAW:
    case EventType.REASONING_ENCRYPTED_VALUE:
    case EventType.REASONING_END:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_START:
    case EventType.RUN_ERROR:
    case EventType.RUN_FINISHED:
    case EventType.RUN_STARTED:
    case EventType.STATE_DELTA:
    case EventType.STATE_SNAPSHOT:
    case EventType.STEP_FINISHED:
    case EventType.STEP_STARTED:
    case EventType.SUBAGENT_ERROR:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_STARTED:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TEXT_MESSAGE_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_CHUNK:
    case "TOOL_CALL_END":
    case EventType.TOOL_CALL_RESULT:
    case "TOOL_CALL_START":
      return chunk;
    default:
      chunk satisfies never;
      return panic("Unexpected client-visible stream chunk");
  }
};
