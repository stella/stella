import { parsePartialJSON } from "@tanstack/ai-client";

import type { ChatPart, ChatUITools } from "@/components/chat/chat-ui-tools";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

type CreateDocumentInput = ChatUITools["create-document"]["input"];

export const CREATE_DOCUMENT_DRAFT_VIEW = "create-document-draft";

export type CreateDocumentDraftPayload = {
  chatThreadId: ChatThreadId;
  toolCallId: string;
  name: string;
  source: string;
  status: "streaming" | "ready";
  workspaceId?: string | undefined;
};

export const createDocumentDraftTabId = (toolCallId: string) =>
  `${CREATE_DOCUMENT_DRAFT_VIEW}:${toolCallId}`;

export const isCreateDocumentDraftPayload = (
  payload: unknown,
): payload is CreateDocumentDraftPayload => {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  return (
    "toolCallId" in payload &&
    typeof payload.toolCallId === "string" &&
    "chatThreadId" in payload &&
    typeof payload.chatThreadId === "string" &&
    "name" in payload &&
    typeof payload.name === "string" &&
    "source" in payload &&
    typeof payload.source === "string" &&
    "status" in payload &&
    (payload.status === "streaming" || payload.status === "ready")
  );
};

export const isSameCreateDocumentDraftPayload = (
  left: unknown,
  right: CreateDocumentDraftPayload,
): boolean =>
  isCreateDocumentDraftPayload(left) &&
  left.toolCallId === right.toolCallId &&
  left.chatThreadId === right.chatThreadId &&
  left.name === right.name &&
  left.source === right.source &&
  left.status === right.status &&
  left.workspaceId === right.workspaceId;

const DOWNLOAD_EXTENSION = ".docx";
const MAX_DOWNLOAD_FILENAME_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- strips control characters from a browser download name
const UNSAFE_DOWNLOAD_FILENAME_CHARACTERS = /["/\\<>\r\n\0|*?:]/gu;

export type CreateDocumentDraft = {
  toolCallId: string;
  name: string;
  source: string;
  status: "streaming" | "ready";
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

export const buildCreateDocumentDownloadFileName = (name: string): string => {
  const safeBase =
    name
      .replace(UNSAFE_DOWNLOAD_FILENAME_CHARACTERS, "_")
      .replace(/\.\./gu, "__")
      .replace(/^\.+|\.+$/gu, "_") || "document";
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
  // TanStack accumulates partial tool arguments but currently exposes its
  // progressive parse only in internal state. Parse the same raw accumulator
  // here so the inspector can render while the source string is arriving.
  const partialInput: unknown = parsePartialJSON(part.arguments);
  return normalizeCreateDocumentInput(partialInput);
};

export const selectCreateDocumentDrafts = (
  messages: readonly { role: string; parts: readonly ChatPart[] }[],
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
        part.state === "input-streaming" &&
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
  messages: readonly { role: string; parts: readonly ChatPart[] }[],
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
      toolCallId: part.id,
      name: input?.name ?? "",
      source: input?.source ?? "",
      status: "ready",
    });
  }
  return drafts;
};
