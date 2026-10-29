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
type CurrentMessage =
  Extract<Identity, { type: "known" }> | { type: "unknown"; role: TextRole };
type Attribution =
  { type: TextRole; identity: Identity } | { type: "protocol" };
const snapshotRoleEvents = {
  MESSAGES_SNAPSHOT: EventType.MESSAGES_SNAPSHOT,
} as const satisfies Record<
  Extract<StreamChunk, { messages: unknown }>["type"],
  StreamChunk["type"]
>;
const roles = {
  user: "authored",
  assistant: "generated",
  system: "generated",
  developer: "generated",
  tool: "generated",
  activity: "generated",
  reasoning: "generated",
} as const satisfies Record<
  | NonNullable<Extract<StreamChunk, { type: "TEXT_MESSAGE_START" }>["role"]>
  | Extract<
      StreamChunk,
      { type: "MESSAGES_SNAPSHOT" }
    >["messages"][number]["role"],
  TextRole
>;
const roleKinds = new Map(Object.entries(roles));
const roleOf = (role: string | null | undefined): TextRole =>
  role === null || role === undefined
    ? "unknown"
    : (roleKinds.get(role) ?? "unknown");
export const createRunMessageRoles = () => {
  const messages = new Map<string, TextRole>();
  // Identified messages keep their role only in the map, including the current message.
  let current: CurrentMessage = { type: "unknown", role: "unknown" };
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
        current =
          identity.type === "known" ? identity : { type: "unknown", role };
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
          identity = current.type === "known" ? current : { type: "unknown" };
        }
        let role: TextRole = "unknown";
        if (chunk.role !== undefined) {
          role = roleOf(chunk.role);
        } else if (chunk.type === EventType.TEXT_MESSAGE_CHUNK) {
          const anonymousRole =
            current.type === "unknown" ? current.role : "unknown";
          role =
            identity.type === "known"
              ? (messages.get(identity.messageId) ?? "unknown")
              : anonymousRole;
        }
        if (
          chunk.type === EventType.TEXT_MESSAGE_START ||
          chunk.role !== undefined
        ) {
          current =
            identity.type === "known" ? identity : { type: "unknown", role };
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
            current.type === "known" &&
            current.messageId === chunk.messageId
          ) {
            current = { type: "unknown", role: "unknown" };
          }
        }
        return { type: role, identity };
      }
      case snapshotRoleEvents.MESSAGES_SNAPSHOT:
        for (const message of chunk.messages) {
          messages.set(message.id, roleOf(message.role));
        }
        return { type: "protocol" };
      case EventType.RUN_STARTED:
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
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
