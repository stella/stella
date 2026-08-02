import type { ChatPart, ChatUITools } from "@/components/chat/chat-ui-tools";

type CreateDocumentInput = ChatUITools["create-document"]["input"];

export const CREATE_DOCUMENT_DRAFT_VIEW = "create-document-draft";

export type CreateDocumentDraftPayload = {
  toolCallId: string;
  name: string;
  source: string;
  status: "streaming" | "ready";
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
  left.name === right.name &&
  left.source === right.source &&
  left.status === right.status;

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

export const selectCreateDocumentDrafts = (
  messages: readonly { role: string; parts: readonly ChatPart[] }[],
): CreateDocumentDraft[] => {
  const drafts: CreateDocumentDraft[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (
        part.type !== "tool-call" ||
        part.name !== "create-document" ||
        (part.state !== "input-streaming" && part.state !== "input-complete") ||
        part.output !== undefined
      ) {
        continue;
      }
      const input = normalizeCreateDocumentInput(part.input);
      drafts.push({
        toolCallId: part.id,
        name: input?.name ?? "",
        source: input?.source ?? "",
        status: part.state === "input-streaming" ? "streaming" : "ready",
      });
    }
  }
  return drafts;
};
