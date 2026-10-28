import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

type TextRole = "authored" | "generated" | "unknown";
export type OpenRunMessage = {
  messageId: string | null;
  role: string | null;
  current: boolean;
};
type Identity = { type: "known"; messageId: string } | { type: "unknown" };
type Attribution =
  { type: TextRole; identity: Identity } | { type: "protocol" };
const roles = {
  user: "authored",
  assistant: "generated",
  system: "generated",
  developer: "generated",
} as const satisfies Record<
  NonNullable<Extract<StreamChunk, { type: "TEXT_MESSAGE_START" }>["role"]>,
  TextRole
>;
const roleOf = (role: string | null | undefined): TextRole => {
  if (role === null || role === undefined) {
    return "unknown";
  }
  switch (role) {
    case "user":
    case "assistant":
    case "system":
    case "developer":
      return roles[role];
    default:
      return "unknown";
  }
};
export const createRunMessageRoles = () => {
  const messages = new Map<string, TextRole>();
  let current: { role: TextRole; identity: Identity } = {
    role: "unknown",
    identity: { type: "unknown" },
  };
  const restore = (open: OpenRunMessage[]) => {
    for (const message of open) {
      const role = roleOf(message.role);
      const identity: Identity =
        message.messageId === null
          ? { type: "unknown" }
          : { type: "known", messageId: message.messageId };
      if (identity.type === "known") {
        messages.set(identity.messageId, role);
      }
      if (message.current) {
        current = { role, identity };
      }
    }
  };
  const classify = (chunk: StreamChunk): Attribution => {
    switch (chunk.type) {
      case EventType.TEXT_MESSAGE_START:
      case EventType.TEXT_MESSAGE_CHUNK: {
        let identity: Identity = { type: "unknown" };
        if (chunk.messageId !== undefined) {
          identity = { type: "known", messageId: chunk.messageId };
        } else if (chunk.role === undefined) {
          identity = current.identity;
        }
        let role: TextRole = "unknown";
        if (chunk.role !== undefined) {
          role = roleOf(chunk.role);
        } else if (chunk.type === EventType.TEXT_MESSAGE_CHUNK) {
          role =
            identity.type === "known"
              ? (messages.get(identity.messageId) ?? "unknown")
              : current.role;
        }
        if (
          chunk.type === EventType.TEXT_MESSAGE_START ||
          chunk.role !== undefined
        ) {
          current = { role, identity };
        }
        if (identity.type === "known") {
          messages.set(identity.messageId, role);
        }
        return { type: role, identity };
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_END: {
        const identity = { type: "known", messageId: chunk.messageId } as const;
        const role = messages.get(chunk.messageId) ?? "unknown";
        if (chunk.type === EventType.TEXT_MESSAGE_END) {
          messages.delete(chunk.messageId);
          if (
            current.identity.type === "known" &&
            current.identity.messageId === chunk.messageId
          ) {
            current = { role: "unknown", identity: { type: "unknown" } };
          }
        }
        return { type: role, identity };
      }
      case EventType.RUN_STARTED:
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
      case EventType.MESSAGES_SNAPSHOT:
      case "ACTIVITY_DELTA":
      case "ACTIVITY_SNAPSHOT":
      case "CUSTOM":
      case "TOOL_CALL_START":
      case EventType.TOOL_CALL_ARGS:
      case "TOOL_CALL_END":
      case EventType.TOOL_CALL_RESULT:
      case EventType.TOOL_CALL_CHUNK:
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
      case EventType.RAW:
      case EventType.STEP_STARTED:
      case EventType.STEP_FINISHED:
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.REASONING_END:
      case EventType.REASONING_ENCRYPTED_VALUE:
      case EventType.SUBAGENT_STARTED:
      case EventType.SUBAGENT_FINISHED:
      case EventType.SUBAGENT_ERROR:
        return { type: "protocol" };
      default:
        chunk satisfies never;
        return panic("Missing run message attribution");
    }
  };
  return { restore, classify };
};
