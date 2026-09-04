import { parsePartialJSON } from "@tanstack/ai-client";
import type { ChatClientState } from "@tanstack/ai-client";
import { panic } from "better-result";
import { v5 as uuidv5 } from "uuid";

import type {
  ChatMessage,
  ChatPart,
  ChatUITools,
} from "@/components/chat/chat-ui-tools";
import { isChatClientRequestActive } from "@/components/chat/chat-ui-tools";
import { type ChatThreadId, toChatThreadId } from "@/lib/chat-thread-ref";

type CreateDocumentInput = ChatUITools["create-document"]["input"];
type CreateDocumentOutput = ChatUITools["create-document"]["output"];
type CreateDocumentMatterOutput = Extract<
  CreateDocumentOutput,
  { entityId: string; success: true }
>;

export const CREATE_DOCUMENT_DRAFT_VIEW = "create-document-draft";
export const createDocumentDraftReviewId = (toolCallId: string): string =>
  `draft:${toolCallId}`;
const CREATE_DOCUMENT_DRAFT_THREAD_NAMESPACE =
  "58cd2ab8-5b47-4c60-8ccc-edbbabf7fc69";

type CreateDocumentDraftPayloadBase = {
  originChatMessageId: string;
  originChatThreadId: ChatThreadId;
  toolCallId: string;
  name: string;
  source: string;
};

type CreateDocumentDraftChatThread =
  | {
      /** The client may display this chat, but the server has not bound it to
       * the generated draft yet, so it cannot be linked while saving. */
      chatThreadBinding: "unbound";
      chatThreadId: ChatThreadId;
    }
  | {
      /** A persisted user message carries the server-owned active-draft
       * context for exactly this inspector chat. */
      chatThreadBinding: "bound";
      chatThreadId: ChatThreadId;
    };

export type CreateDocumentDraftPayload = CreateDocumentDraftPayloadBase &
  CreateDocumentDraftChatThread &
  (
    | {
        status: "streaming" | "ready" | "saving";
        workspaceId?: string | undefined;
      }
    | {
        status: "persisted";
        entityId: string;
        fieldId: string;
        fileName: string;
        workspaceId: string;
      }
  );

type PersistCreateDocumentDraftPayloadOptions = {
  entityId: string;
  fieldId: string;
  fileName: string;
  payload: CreateDocumentDraftPayload;
  workspaceId: string;
};

export const persistCreateDocumentDraftPayload = ({
  entityId,
  fieldId,
  fileName,
  payload,
  workspaceId,
}: PersistCreateDocumentDraftPayloadOptions): CreateDocumentDraftPayload => ({
  originChatMessageId: payload.originChatMessageId,
  originChatThreadId: payload.originChatThreadId,
  chatThreadBinding: payload.chatThreadBinding,
  chatThreadId: payload.chatThreadId,
  toolCallId: payload.toolCallId,
  name: payload.name,
  source: payload.source,
  status: "persisted",
  entityId,
  fieldId,
  fileName,
  workspaceId,
});

export const getCreateDocumentDraftEditorAccess = (
  payload: CreateDocumentDraftPayload,
): "editable" | "read-only" =>
  payload.status === "ready" ? "editable" : "read-only";

/**
 * An unbound draft-only chat has no durable relationship to the saved file.
 * Once the document exists, omit that synthetic id so the file overlay
 * resolves its canonical file-chat mapping instead. A bound id is safe to
 * retain because the server moved that mapping as part of the save.
 */
export const resolveCreateDocumentDraftOverlayChatThreadId = (
  payload: CreateDocumentDraftPayload,
): ChatThreadId | undefined =>
  payload.status === "persisted" && payload.chatThreadBinding === "unbound"
    ? undefined
    : payload.chatThreadId;

type SetCreateDocumentDraftChatThreadIdOptions = {
  chatThreadId: ChatThreadId;
  payload: CreateDocumentDraftPayload;
};

export const setCreateDocumentDraftChatThreadId = ({
  chatThreadId,
  payload,
}: SetCreateDocumentDraftChatThreadIdOptions): CreateDocumentDraftPayload => {
  if (
    chatThreadId === payload.chatThreadId ||
    chatThreadId === payload.originChatThreadId
  ) {
    return payload;
  }

  switch (payload.status) {
    case "streaming":
    case "ready":
    case "saving":
      return {
        originChatMessageId: payload.originChatMessageId,
        originChatThreadId: payload.originChatThreadId,
        chatThreadBinding: "unbound",
        chatThreadId,
        toolCallId: payload.toolCallId,
        name: payload.name,
        source: payload.source,
        status: payload.status,
        ...(payload.workspaceId === undefined
          ? {}
          : { workspaceId: payload.workspaceId }),
      };
    case "persisted":
      return {
        originChatMessageId: payload.originChatMessageId,
        originChatThreadId: payload.originChatThreadId,
        chatThreadBinding: "unbound",
        chatThreadId,
        toolCallId: payload.toolCallId,
        name: payload.name,
        source: payload.source,
        status: "persisted",
        entityId: payload.entityId,
        fieldId: payload.fieldId,
        fileName: payload.fileName,
        workspaceId: payload.workspaceId,
      };
    default: {
      payload satisfies never;
      return panic(`Unhandled payload: ${String(payload)}`);
    }
  }
};

type BindCreateDocumentDraftChatThreadOptions = {
  chatThreadId: ChatThreadId;
  payload: CreateDocumentDraftPayload;
};

/**
 * A deterministic inspector id only gives the browser a stable draft-chat
 * surface. Saving may forward it only after a server-persisted message proves
 * that this chat owns the active generated-document draft.
 */
export const bindCreateDocumentDraftChatThread = ({
  chatThreadId,
  payload,
}: BindCreateDocumentDraftChatThreadOptions): CreateDocumentDraftPayload => {
  if (
    chatThreadId !== payload.chatThreadId ||
    payload.chatThreadBinding === "bound"
  ) {
    return payload;
  }

  switch (payload.status) {
    case "streaming":
    case "ready":
    case "saving":
      return {
        originChatMessageId: payload.originChatMessageId,
        originChatThreadId: payload.originChatThreadId,
        chatThreadBinding: "bound",
        chatThreadId: payload.chatThreadId,
        toolCallId: payload.toolCallId,
        name: payload.name,
        source: payload.source,
        status: payload.status,
        ...(payload.workspaceId === undefined
          ? {}
          : { workspaceId: payload.workspaceId }),
      };
    case "persisted":
      return {
        originChatMessageId: payload.originChatMessageId,
        originChatThreadId: payload.originChatThreadId,
        chatThreadBinding: "bound",
        chatThreadId: payload.chatThreadId,
        toolCallId: payload.toolCallId,
        name: payload.name,
        source: payload.source,
        status: "persisted",
        entityId: payload.entityId,
        fieldId: payload.fieldId,
        fileName: payload.fileName,
        workspaceId: payload.workspaceId,
      };
    default: {
      payload satisfies never;
      return panic(`Unhandled payload: ${String(payload)}`);
    }
  }
};

export const createDocumentDraftTabId = (toolCallId: string) =>
  `${CREATE_DOCUMENT_DRAFT_VIEW}:${toolCallId}`;

export const isCreateDocumentDraftPayload = (
  payload: unknown,
): payload is CreateDocumentDraftPayload => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const hasBasePayload =
    "toolCallId" in payload &&
    typeof payload.toolCallId === "string" &&
    "originChatThreadId" in payload &&
    typeof payload.originChatThreadId === "string" &&
    "originChatMessageId" in payload &&
    typeof payload.originChatMessageId === "string" &&
    "chatThreadId" in payload &&
    typeof payload.chatThreadId === "string" &&
    payload.chatThreadId !== payload.originChatThreadId &&
    "chatThreadBinding" in payload &&
    (payload.chatThreadBinding === "unbound" ||
      payload.chatThreadBinding === "bound") &&
    "name" in payload &&
    typeof payload.name === "string" &&
    "source" in payload &&
    typeof payload.source === "string";
  if (!hasBasePayload || !("status" in payload)) {
    return false;
  }
  if (
    payload.status === "streaming" ||
    payload.status === "ready" ||
    payload.status === "saving"
  ) {
    return (
      !("workspaceId" in payload) ||
      payload.workspaceId === undefined ||
      typeof payload.workspaceId === "string"
    );
  }
  return (
    payload.status === "persisted" &&
    "entityId" in payload &&
    typeof payload.entityId === "string" &&
    "fieldId" in payload &&
    typeof payload.fieldId === "string" &&
    "fileName" in payload &&
    typeof payload.fileName === "string" &&
    "workspaceId" in payload &&
    typeof payload.workspaceId === "string"
  );
};

export const isSameCreateDocumentDraftPayload = (
  left: unknown,
  right: CreateDocumentDraftPayload,
): boolean =>
  isCreateDocumentDraftPayload(left) &&
  left.toolCallId === right.toolCallId &&
  left.originChatMessageId === right.originChatMessageId &&
  left.originChatThreadId === right.originChatThreadId &&
  left.chatThreadBinding === right.chatThreadBinding &&
  left.chatThreadId === right.chatThreadId &&
  left.name === right.name &&
  left.source === right.source &&
  left.status === right.status &&
  left.workspaceId === right.workspaceId &&
  (left.status !== "persisted" ||
    right.status !== "persisted" ||
    (left.entityId === right.entityId &&
      left.fieldId === right.fieldId &&
      left.fileName === right.fileName));

const DOWNLOAD_EXTENSION = ".docx";
const MAX_DOWNLOAD_FILENAME_LENGTH = 255;
const UNSAFE_DOWNLOAD_FILENAME_CHARACTERS = '"/\\<>\r\n\0|*?:';

export type CreateDocumentDraft = {
  messageId: string;
  toolCallId: string;
  name: string;
  source: string;
  status: "streaming" | "ready";
};

type BuildCreateDocumentDraftPayloadOptions = {
  draft: CreateDocumentDraft;
  existingPayload: unknown;
  originChatThreadId: ChatThreadId;
  workspaceId?: string | undefined;
};

export const buildCreateDocumentDraftPayload = ({
  draft,
  existingPayload,
  originChatThreadId,
  workspaceId,
}: BuildCreateDocumentDraftPayloadOptions): CreateDocumentDraftPayload => {
  const hasExistingIdentity =
    isCreateDocumentDraftPayload(existingPayload) &&
    existingPayload.originChatThreadId === originChatThreadId &&
    existingPayload.toolCallId === draft.toolCallId;
  if (hasExistingIdentity && existingPayload.status === "persisted") {
    return existingPayload;
  }
  const chatThreadId = hasExistingIdentity
    ? existingPayload.chatThreadId
    : toChatThreadId(
        uuidv5(
          `${originChatThreadId}:${draft.toolCallId}`,
          CREATE_DOCUMENT_DRAFT_THREAD_NAMESPACE,
        ),
      );

  return {
    originChatMessageId: draft.messageId,
    originChatThreadId,
    chatThreadBinding: hasExistingIdentity
      ? existingPayload.chatThreadBinding
      : "unbound",
    chatThreadId,
    toolCallId: draft.toolCallId,
    name: draft.name,
    source: draft.source,
    status:
      hasExistingIdentity && existingPayload.status === "saving"
        ? "saving"
        : draft.status,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
};

type SetCreateDocumentDraftPayloadStatusOptions = {
  payload: CreateDocumentDraftPayload;
  status: "ready" | "saving";
};

export const setCreateDocumentDraftPayloadStatus = ({
  payload,
  status,
}: SetCreateDocumentDraftPayloadStatusOptions): CreateDocumentDraftPayload => {
  if (payload.status === "persisted") {
    return payload;
  }
  return {
    originChatMessageId: payload.originChatMessageId,
    originChatThreadId: payload.originChatThreadId,
    chatThreadBinding: payload.chatThreadBinding,
    chatThreadId: payload.chatThreadId,
    toolCallId: payload.toolCallId,
    name: payload.name,
    source: payload.source,
    status,
    ...(payload.workspaceId === undefined
      ? {}
      : { workspaceId: payload.workspaceId }),
  };
};

const isReadyDraftOutput = (
  output: unknown,
): output is { destination: "draft"; fileName: string; success: true } =>
  typeof output === "object" &&
  output !== null &&
  "success" in output &&
  output.success === true &&
  "destination" in output &&
  output.destination === "draft" &&
  "fileName" in output &&
  typeof output.fileName === "string";

export const findReadyCreateDocumentDraftMessageId = (
  messages: readonly ChatMessage[],
  toolCallId: string,
): string | null => {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const hasDraft = message.parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.name === "create-document" &&
        part.id === toolCallId &&
        part.state === "complete" &&
        isReadyDraftOutput(part.output),
    );
    if (hasDraft) {
      return message.id;
    }
  }
  return null;
};

export const replaceReadyCreateDocumentDraftOutput = (
  messages: readonly ChatMessage[],
  toolCallId: string,
  output: CreateDocumentMatterOutput,
): ChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = message.parts.map((part) => {
      if (
        part.type !== "tool-call" ||
        part.name !== "create-document" ||
        part.id !== toolCallId ||
        part.state !== "complete" ||
        !isReadyDraftOutput(part.output)
      ) {
        return part;
      }
      return { ...part, output };
    });
    return parts.some((part, index) => part !== message.parts[index])
      ? { ...message, parts }
      : message;
  });

export const terminalizeUnsettledCreateDocumentDraft = (
  messages: readonly ChatMessage[],
  toolCallId: string,
): ChatMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const parts = message.parts.map((part) =>
      part.type === "tool-call" &&
      part.name === "create-document" &&
      part.id === toolCallId &&
      part.state === "input-complete" &&
      part.output === undefined
        ? { ...part, state: "error" as const }
        : part,
    );
    return parts.some((part, index) => part !== message.parts[index])
      ? { ...message, parts }
      : message;
  });

export const buildCreateDocumentDownloadFileName = (name: string): string => {
  let sanitized = "";
  for (const character of name) {
    sanitized += UNSAFE_DOWNLOAD_FILENAME_CHARACTERS.includes(character)
      ? "_"
      : character;
  }
  sanitized = sanitized.split("..").join("__");
  let firstNonDot = 0;
  while (sanitized.at(firstNonDot) === ".") {
    firstNonDot += 1;
  }
  let lastNonDot = sanitized.length;
  while (lastNonDot > firstNonDot && sanitized.at(lastNonDot - 1) === ".") {
    lastNonDot -= 1;
  }
  const safeBase =
    `${firstNonDot > 0 ? "_" : ""}${sanitized.slice(
      firstNonDot,
      lastNonDot,
    )}${lastNonDot < sanitized.length ? "_" : ""}` || "document";
  return `${safeBase.slice(
    0,
    MAX_DOWNLOAD_FILENAME_LENGTH - DOWNLOAD_EXTENSION.length,
  )}${DOWNLOAD_EXTENSION}`;
};

export const normalizeCreateDocumentInput = (
  input: unknown,
): Partial<CreateDocumentInput> | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const normalized: Partial<CreateDocumentInput> = {};
  if ("name" in input && typeof input.name === "string") {
    normalized.name = input.name;
  }
  let source: string | null = null;
  if ("source" in input && typeof input.source === "string") {
    source = input.source;
  } else if ("markdown" in input && typeof input.markdown === "string") {
    source = input.markdown;
  }
  if (source !== null) {
    normalized.source = source;
  }

  return normalized;
};

const getCreateDocumentInput = (
  part: Extract<ChatPart, { type: "tool-call" }>,
): Partial<CreateDocumentInput> | null => {
  if (part.input !== undefined) {
    return normalizeCreateDocumentInput(part.input);
  }
  if (part.state !== "input-streaming") {
    return null;
  }
  // Partial streaming input has not crossed a validation boundary yet. Parse
  // it only for this progressive preview; completed calls use canonical input.
  return normalizeCreateDocumentInput(parsePartialJSON(part.arguments));
};

export const selectCreateDocumentDrafts = (
  messages: readonly {
    id: string;
    role: string;
    parts: readonly ChatPart[];
  }[],
): CreateDocumentDraft[] => {
  const drafts: CreateDocumentDraft[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      const isStreamingDraft =
        part.type === "tool-call" &&
        part.name === "create-document" &&
        (part.state === "awaiting-input" || part.state === "input-streaming") &&
        part.output === undefined;
      const isUnresolvedReadyDraft =
        part.type === "tool-call" &&
        part.name === "create-document" &&
        part.state === "input-complete" &&
        part.output === undefined;
      const isSettledReadyDraft =
        part.type === "tool-call" &&
        part.name === "create-document" &&
        part.state === "complete" &&
        isReadyDraftOutput(part.output);
      if (
        !isStreamingDraft &&
        !isUnresolvedReadyDraft &&
        !isSettledReadyDraft
      ) {
        continue;
      }
      const input = getCreateDocumentInput(part);
      drafts.push({
        messageId: message.id,
        toolCallId: part.id,
        name: input?.name ?? "",
        source: input?.source ?? "",
        status: isStreamingDraft ? "streaming" : "ready",
      });
    }
  }
  return drafts;
};

export const selectUnsettledCreateDocumentDrafts = (
  messages: readonly {
    id: string;
    role: string;
    parts: readonly ChatPart[];
  }[],
): CreateDocumentDraft[] => {
  const message = messages.at(-1);
  if (message?.role !== "assistant") {
    return [];
  }
  const drafts: CreateDocumentDraft[] = [];
  for (const part of message.parts) {
    if (
      part.type !== "tool-call" ||
      part.name !== "create-document" ||
      part.state !== "input-complete" ||
      part.output !== undefined
    ) {
      continue;
    }
    const input = normalizeCreateDocumentInput(part.input);
    drafts.push({
      messageId: message.id,
      toolCallId: part.id,
      name: input?.name ?? "",
      source: input?.source ?? "",
      status: "ready",
    });
  }
  return drafts;
};

export const selectSettleableCreateDocumentDrafts = (
  messages: Parameters<typeof selectUnsettledCreateDocumentDrafts>[0],
  status: ChatClientState,
): CreateDocumentDraft[] =>
  isChatClientRequestActive(status)
    ? []
    : selectUnsettledCreateDocumentDrafts(messages);

/** IDs of create-document calls that can no longer produce a usable draft. */
export const selectTerminalCreateDocumentDraftIds = (
  messages: readonly { role: string; parts: readonly ChatPart[] }[],
): readonly string[] => {
  const terminalIds: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "tool-call" || part.name !== "create-document") {
        continue;
      }
      switch (part.state) {
        case "error":
          terminalIds.push(part.id);
          break;
        case "awaiting-input":
        case "input-streaming":
        case "input-complete":
        case "complete":
        case "approval-requested":
        case "approval-responded":
          break;
        default:
          part satisfies never;
      }
    }
  }
  return terminalIds;
};

export const isCreateDocumentDraftSettlementActive = (
  messages: readonly { role: string; parts: readonly ChatPart[] }[],
  toolCallId: string,
): boolean => {
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type !== "tool-call" ||
        part.name !== "create-document" ||
        part.id !== toolCallId
      ) {
        continue;
      }
      return (
        (part.state === "input-complete" && part.output === undefined) ||
        (part.state === "complete" && isReadyDraftOutput(part.output))
      );
    }
  }
  return false;
};
