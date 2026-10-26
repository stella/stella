import { EventType, type StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

import {
  isUnsupportedChatPart,
  UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
} from "@stll/api-contract/chat";

import type { ChatPart } from "@/api/handlers/chat/types";

/** The client sees where an unknown stored part sits, never its raw payload. */
export const clientVisibleChatPart = (part: ChatPart): ChatPart =>
  isUnsupportedChatPart(part)
    ? {
        type: "activity",
        activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
        content: {},
      }
    : part;

type SnapshotMessage = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>["messages"][number];

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
    if (parts.some(isUnsupportedChatPart)) {
      const visible = {
        parts: parts.map((part) =>
          isUnsupportedChatPart(part) ? clientVisibleChatPart(part) : part,
        ),
      };
      return { ...message, ...visible };
    }
  }
  return message;
};

/** Last server boundary for AG-UI events carrying stored message parts. */
export const clientVisibleStreamChunk = (chunk: StreamChunk): StreamChunk => {
  switch (chunk.type) {
    case EventType.MESSAGES_SNAPSHOT: {
      const messages = chunk.messages.map(clientVisibleSnapshotMessage);
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
