import type { ContentPartSource } from "@tanstack/ai";

import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import type {
  ChatAttachmentMetadata,
  ChatAttachmentPart,
  ChatMessage,
  ChatMessageContent,
  ChatMessageMetadata,
  ChatMessageRole,
  ChatPart,
  ChatTanStackPart,
  PersistableChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import {
  isUserFileUrl,
  parseUserFileId,
} from "@/api/handlers/user-files/types";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";

const IMAGE_MIME_PREFIX = "image/";

export type ChatAttachmentInput = {
  filename?: string | undefined;
  mimeType: string;
  placeholder?: string | undefined;
  url: string;
};

export type LegacyAiSdkFilePart = {
  filename?: string | undefined;
  mediaType: string;
  placeholder?: string | undefined;
  type: "file";
  url: string;
};

export type LegacyAiSdkTextPart = {
  text: string;
  type: "text";
};

export type NormalizedLegacyMessageParts = {
  metadata: ChatMessageMetadata;
  parts: ChatPart[];
};

type PersistedChatMessageRow = {
  content: PersistedChatMessageContent;
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

export const isChatTextPart = (
  part: ChatPart,
): part is Extract<ChatTanStackPart, { type: "text" }> =>
  part.type === "text" && "content" in part && typeof part.content === "string";

export const chatPartText = (part: ChatPart): string | null => {
  if (isChatTextPart(part)) {
    return part.content;
  }
  return null;
};

export const createChatTextPart = (content: string): ChatPart => ({
  type: "text",
  content,
});

export const isChatAttachmentPart = (
  part: unknown,
): part is ChatAttachmentPart =>
  isRecord(part) &&
  (part["type"] === "image" || part["type"] === "document") &&
  "source" in part &&
  isRecord(part["source"]) &&
  "value" in part["source"] &&
  typeof part["source"]["value"] === "string";

export const getChatAttachmentUrl = (part: ChatAttachmentPart): string =>
  part.source.value;

export const getChatAttachmentMimeType = (part: ChatAttachmentPart): string => {
  const { source } = part;
  if ("mimeType" in source && typeof source.mimeType === "string") {
    return source.mimeType;
  }
  return "application/octet-stream";
};

export const getChatAttachmentFilename = (
  part: ChatAttachmentPart,
): string | undefined => part.metadata?.filename;

export const getChatAttachmentPlaceholder = (
  part: ChatAttachmentPart,
): string | undefined => part.metadata?.placeholder;

export const createChatAttachmentPart = ({
  filename,
  mimeType,
  placeholder,
  url,
}: ChatAttachmentInput): ChatAttachmentPart => {
  const source: ContentPartSource = {
    type: "url",
    value: url,
    mimeType,
  };
  const metadata: ChatAttachmentMetadata = {
    ...(filename === undefined ? {} : { filename }),
    ...(placeholder === undefined ? {} : { placeholder }),
  };
  const metadataPatch = Object.keys(metadata).length === 0 ? {} : { metadata };

  if (mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return {
      type: "image",
      source,
      ...metadataPatch,
    };
  }

  return {
    type: "document",
    source,
    ...metadataPatch,
  };
};

export const isLegacyAiSdkTextPart = (
  part: unknown,
): part is LegacyAiSdkTextPart =>
  isRecord(part) && part["type"] === "text" && typeof part["text"] === "string";

export const isLegacyAiSdkFilePart = (
  part: unknown,
): part is LegacyAiSdkFilePart =>
  isRecord(part) &&
  part["type"] === "file" &&
  typeof part["mediaType"] === "string" &&
  typeof part["url"] === "string";

export const legacyAiSdkTextPartToTanStack = (
  part: LegacyAiSdkTextPart,
): Extract<ChatTanStackPart, { type: "text" }> => ({
  type: "text",
  content: part.text,
});

export const legacyAiSdkFilePartToTanStack = (
  part: LegacyAiSdkFilePart,
): ChatAttachmentPart =>
  createChatAttachmentPart({
    filename: part.filename,
    mimeType: part.mediaType,
    placeholder: part.placeholder,
    url: part.url,
  });

export const normalizeLegacyMessagePartsToTanStack = (
  parts: readonly unknown[],
): NormalizedLegacyMessageParts => {
  const normalized: ChatPart[] = [];
  const metadata: ChatMessageMetadata = {};
  for (const part of parts) {
    if (isLegacyAiSdkTextPart(part)) {
      normalized.push(legacyAiSdkTextPartToTanStack(part));
      continue;
    }
    if (isLegacyAiSdkFilePart(part)) {
      normalized.push(legacyAiSdkFilePartToTanStack(part));
      continue;
    }
    if (isLegacyAnonRestorationsPart(part)) {
      metadata.anonRestorations = mergeAnonRestorations(
        metadata.anonRestorations,
        part.data,
      );
      continue;
    }
    if (isLegacyMentionsPart(part)) {
      metadata.mentions = part.data;
      continue;
    }
    if (isLegacySourceDocumentPart(part)) {
      const sourceDocuments = metadata.sourceDocuments;
      metadata.sourceDocuments = [...arrayOrEmpty(sourceDocuments), part.data];
      continue;
    }
    if (isLegacyToolPart(part)) {
      const converted = legacyToolPartToTanStack(part);
      if (converted) {
        normalized.push(converted);
      }
      continue;
    }
    if (isChatPart(part)) {
      normalized.push(part);
    }
  }
  return { metadata, parts: normalized };
};

export const normalizePersistedChatMessageContent = (
  content: PersistedChatMessageContent,
): NormalizedLegacyMessageParts => {
  if (content.version === 2) {
    return {
      metadata: content.metadata ?? {},
      parts: content.data,
    };
  }

  return normalizeLegacyMessagePartsToTanStack(
    normalizeLegacyRawToolInputs(content.data),
  );
};

export const chatMessageFromPersisted = ({
  content,
  id,
  role,
}: PersistedChatMessageRow): PersistableChatMessage => {
  const normalized = normalizePersistedChatMessageContent(content);
  return {
    id,
    role,
    parts: normalized.parts,
    ...(isChatMessageMetadataEmpty(normalized.metadata)
      ? {}
      : { metadata: normalized.metadata }),
  };
};

export const chatMessageContentFromMessage = (
  message: ChatMessage,
): ChatMessageContent => ({
  version: 2,
  data: message.parts,
  ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
});

export const toProviderVisibleMessage = (
  message: ChatMessage,
): ChatMessage | null => {
  if (message.parts.length === 0) {
    return null;
  }
  return message;
};

export const toProviderVisibleMessages = (
  messages: readonly ChatMessage[],
): ChatMessage[] => {
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    const next = toProviderVisibleMessage(message);
    if (next) {
      visible.push(next);
    }
  }
  return visible;
};

export const getUserFileIdFromAttachmentPart = (
  part: ChatAttachmentPart,
): SafeId<"userFile"> | null => {
  const url = getChatAttachmentUrl(part);
  if (!isUserFileUrl(url)) {
    return null;
  }
  return parseUserFileId(url);
};

export const isChatPart = (part: unknown): part is ChatPart => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }

  switch (part["type"]) {
    case "text":
      return typeof part["content"] === "string";
    case "image":
    case "document":
      return isContentPartWithSource(part);
    case "audio":
    case "video":
      return false;
    case "tool-call":
      return (
        typeof part["id"] === "string" &&
        typeof part["name"] === "string" &&
        typeof part["arguments"] === "string" &&
        isTanStackToolCallState(part["state"])
      );
    case "tool-result":
      return (
        typeof part["toolCallId"] === "string" &&
        isTanStackToolResultContent(part["content"]) &&
        isTanStackToolResultState(part["state"]) &&
        (!("error" in part) || typeof part["error"] === "string")
      );
    case "thinking":
      return typeof part["content"] === "string";
    case "structured-output":
      return "data" in part;
    default:
      return false;
  }
};

const isContentPartWithSource = (
  part: Record<string, unknown>,
): part is Record<string, unknown> & {
  source: { type: "data" | "url"; value: string; mimeType?: string };
} =>
  isRecord(part["source"]) &&
  (part["source"]["type"] === "data" || part["source"]["type"] === "url") &&
  typeof part["source"]["value"] === "string" &&
  (!("mimeType" in part["source"]) ||
    typeof part["source"]["mimeType"] === "string");

const isLegacyAnonRestorationsPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["anonRestorations"]>;
  type: "data-stella-anon-restorations";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-anon-restorations" &&
  isRecord(part["data"]) &&
  Array.isArray(part["data"]["pairs"]);

const isLegacyMentionsPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["mentions"]>;
  type: "data-stella-mentions";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-mentions" &&
  isRecord(part["data"]) &&
  Array.isArray(part["data"]["mentions"]);

const isLegacySourceDocumentPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["sourceDocuments"]>[number];
  type: "data-stella-source-document";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-source-document" &&
  isRecord(part["data"]);

const isLegacyToolPart = (
  part: unknown,
): part is Record<string, unknown> & { type: string } => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }
  if (part["type"] === "dynamic-tool") {
    return typeof part["toolName"] === "string";
  }
  return part["type"].startsWith("tool-") && part["type"] !== "tool-result";
};

const legacyToolPartToTanStack = (
  part: Record<string, unknown> & { type: string },
): ChatPart | null => {
  const name = legacyToolName(part);
  const id =
    getStringProperty(part, "toolCallId") ?? getStringProperty(part, "id");
  if (!name || !id) {
    return null;
  }

  const input = Reflect.get(part, "input");
  const next: unknown = {
    type: "tool-call" as const,
    id,
    name,
    arguments: safeStringifyToolArguments(input ?? {}),
    state: legacyToolStateToTanStack(part["state"]),
    ...("input" in part ? { input } : {}),
    ...("output" in part ? { output: Reflect.get(part, "output") } : {}),
    ...legacyToolApprovalToTanStack(part["approval"]),
  };

  return isChatPart(next) ? next : null;
};

const legacyToolName = (
  part: Record<string, unknown> & { type: string },
): string | null => {
  if (part.type === "dynamic-tool") {
    const toolName = getStringProperty(part, "toolName");
    return toolName?.startsWith("mcp__") ? toolName : null;
  }
  return part.type.slice("tool-".length);
};

const legacyToolStateToTanStack = (state: unknown) => {
  switch (state) {
    case "input-streaming":
      return "input-streaming" as const;
    case "input-available":
    case "input-complete":
      return "input-complete" as const;
    case "approval-requested":
      return "approval-requested" as const;
    case "approval-responded":
      return "approval-responded" as const;
    case "output-available":
    case "output-error":
    case "complete":
      return "complete" as const;
    default:
      return "input-complete" as const;
  }
};

const legacyToolApprovalToTanStack = (
  approval: unknown,
):
  | {
      approval: {
        approved?: boolean | undefined;
        id: string;
        needsApproval: boolean;
      };
    }
  | Record<string, never> => {
  if (!isRecord(approval)) {
    return {};
  }
  const id = getStringProperty(approval, "id");
  const needsApproval = approval["needsApproval"];
  if (!id || typeof needsApproval !== "boolean") {
    return {};
  }
  const approved = approval["approved"];
  return {
    approval: {
      id,
      needsApproval,
      ...(typeof approved === "boolean" ? { approved } : {}),
    },
  };
};

const isTanStackToolCallState = (value: unknown): boolean =>
  value === "awaiting-input" ||
  value === "input-streaming" ||
  value === "input-complete" ||
  value === "approval-requested" ||
  value === "approval-responded" ||
  value === "complete";

const isTanStackToolResultState = (value: unknown): boolean =>
  value === "streaming" || value === "complete" || value === "error";

const isTanStackToolResultContent = (value: unknown): boolean =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every(isTanStackToolResultContentPart));

const isTanStackToolResultContentPart = (part: unknown): boolean => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }

  if (part["type"] === "text") {
    return typeof part["content"] === "string";
  }

  return (
    (part["type"] === "image" ||
      part["type"] === "audio" ||
      part["type"] === "video" ||
      part["type"] === "document") &&
    isContentPartWithSource(part)
  );
};

const mergeAnonRestorations = (
  current: ChatMessageMetadata["anonRestorations"],
  next: NonNullable<ChatMessageMetadata["anonRestorations"]>,
): NonNullable<ChatMessageMetadata["anonRestorations"]> => ({
  pairs: [...(current === undefined ? [] : current.pairs), ...next.pairs],
});

const isChatMessageMetadataEmpty = (metadata: ChatMessageMetadata): boolean =>
  metadata.anonRestorations === undefined &&
  metadata.mentions === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.usage === undefined;

const safeStringifyToolArguments = (value: unknown): string => {
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "{}";
  } catch {
    return "{}";
  }
};

const getStringProperty = (
  value: Record<string, unknown>,
  key: string,
): string | null => {
  const property = value[key];
  return typeof property === "string" ? property : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
