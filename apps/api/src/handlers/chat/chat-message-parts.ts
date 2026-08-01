import type {
  AudioPart,
  ContentPartSource,
  UIResourcePart,
  VideoPart,
} from "@tanstack/ai";
import { panic } from "better-result";
import { Buffer } from "node:buffer";

import {
  isBoundedBase64Content,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import type {
  ChatAttachmentMetadata,
  ChatAttachmentPart,
  ChatMessage,
  ChatMessageContentCandidate,
  ChatMessageContent,
  ChatMessageMetadata,
  ChatMessageRole,
  ChatPart,
  ChatTanStackPart,
  PersistableChatPartType,
  PersistableChatMessageCandidate,
  PersistableChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isUserFileUrl, parseUserFileId } from "@/api/lib/user-files/types";

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

export const isChatDocumentPart = (part: unknown): part is ChatAttachmentPart =>
  isChatAttachmentPart(part) && part.type === "document";

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
  return toPersistableChatMessage({
    id,
    role,
    parts: normalized.parts,
    ...(isChatMessageMetadataEmpty(normalized.metadata)
      ? {}
      : { metadata: normalized.metadata }),
  });
};

export const chatMessageContentFromMessage = (
  message: PersistableChatMessage,
): ChatMessageContent =>
  toChatMessageContent({
    version: 2,
    data: message.parts,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  });

type ChatPartClientAcceptance = "accept" | "server-only";
type ChatPartProviderVisibility = "model" | "ui-only";
type InvalidChatPartHandling = "drop" | "panic";

// Rich output parts are issued by the trusted stream processor. Accepting
// them from the request body would let a client mint active HTML or remote
// media and have the server return it as trusted persisted history.
const CHAT_PART_CLIENT_ACCEPTANCE = {
  audio: "server-only",
  document: "accept",
  image: "accept",
  "structured-output": "accept",
  text: "accept",
  thinking: "accept",
  "tool-call": "accept",
  "tool-result": "accept",
  "ui-resource": "server-only",
  video: "server-only",
} as const satisfies Record<PersistableChatPartType, ChatPartClientAcceptance>;

// Bounded rich output is external presentation data, so an invalid instance
// is dropped without sacrificing surrounding text. Malformed core protocol
// parts still indicate an SDK/programmer contract violation and fail loudly.
const INVALID_CHAT_PART_HANDLING = {
  audio: "drop",
  document: "panic",
  image: "panic",
  "structured-output": "panic",
  text: "panic",
  thinking: "panic",
  "tool-call": "panic",
  "tool-result": "panic",
  "ui-resource": "drop",
  video: "drop",
} as const satisfies Record<PersistableChatPartType, InvalidChatPartHandling>;

// These parts are presentation output, not conversation context. TanStack
// currently omits UI resources during model conversion; keeping the policy
// explicit here also prevents audio/video replay into a model that may not
// support those modalities on the next turn.
const CHAT_PART_PROVIDER_VISIBILITY = {
  audio: "ui-only",
  document: "model",
  image: "model",
  "structured-output": "model",
  text: "model",
  thinking: "model",
  "tool-call": "model",
  "tool-result": "model",
  "ui-resource": "ui-only",
  video: "ui-only",
} as const satisfies Record<
  PersistableChatPartType,
  ChatPartProviderVisibility
>;

export const isProviderVisibleChatPart = (part: ChatPart): boolean =>
  CHAT_PART_PROVIDER_VISIBILITY[part.type] === "model";

export const toProviderVisibleMessage = (
  message: ChatMessage,
): ChatMessage | null => {
  const parts: ChatPart[] = [];
  for (const part of message.parts) {
    if (isProviderVisibleChatPart(part)) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === message.parts.length
    ? message
    : { ...message, parts };
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

const isHttpUrl = (value: string): boolean => {
  if (value.length > LIMITS.chatRichMediaUrlMaxChars || !URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

const isMediaPart = (
  part: Record<string, unknown>,
  mimePrefix: "audio/" | "video/",
): boolean => {
  if (!isContentPartWithSource(part)) {
    return false;
  }
  const { source } = part;
  if (
    source.mimeType !== undefined &&
    source.mimeType.length > LIMITS.chatRichMediaMimeTypeMaxChars
  ) {
    return false;
  }
  if (source.type === "data") {
    return (
      source.mimeType?.startsWith(mimePrefix) === true &&
      isBoundedBase64Content(source.value, LIMITS.chatRichMediaInlineMaxChars)
    );
  }
  return (
    (source.mimeType === undefined || source.mimeType.startsWith(mimePrefix)) &&
    isHttpUrl(source.value)
  );
};

const isUiResourcePart = (part: Record<string, unknown>): boolean => {
  if (
    !isRecord(part["resource"]) ||
    typeof part["toolCallId"] !== "string" ||
    part["toolCallId"].length === 0 ||
    part["toolCallId"].length > LIMITS.chatRichPartIdentifierMaxChars ||
    typeof part["toolName"] !== "string" ||
    part["toolName"].length === 0 ||
    part["toolName"].length > LIMITS.chatRichPartIdentifierMaxChars ||
    ("serverId" in part &&
      part["serverId"] !== undefined &&
      (typeof part["serverId"] !== "string" ||
        part["serverId"].length > LIMITS.chatRichPartIdentifierMaxChars)) ||
    ("meta" in part && part["meta"] !== undefined && !isRecord(part["meta"]))
  ) {
    return false;
  }

  const resource = part["resource"];
  if (
    typeof resource["uri"] !== "string" ||
    !resource["uri"].startsWith("ui://") ||
    resource["uri"].length > LIMITS.chatUiResourceUriMaxChars ||
    resource["mimeType"] !== MCP_APP_RESOURCE_MIME_TYPE
  ) {
    return false;
  }

  const text = resource["text"];
  const blob = resource["blob"];
  if (typeof text === "string") {
    return (
      typeof blob !== "string" &&
      text.length > 0 &&
      text.length <= LIMITS.chatUiResourceContentMaxChars
    );
  }
  return (
    typeof blob === "string" &&
    isBoundedBase64Content(blob, LIMITS.chatUiResourceContentMaxChars)
  );
};

type ChatPartValidator = (part: Record<string, unknown>) => boolean;

type ChatPartPersistence = "drop" | "persist";

// Every TanStack part must receive an explicit persistence policy. A future SDK
// variant fails typecheck here until it is deliberately persisted or dropped.
const CHAT_PART_PERSISTENCE = {
  audio: "persist",
  document: "persist",
  image: "persist",
  "structured-output": "persist",
  text: "persist",
  thinking: "persist",
  "tool-call": "persist",
  "tool-result": "persist",
  "ui-resource": "persist",
  video: "persist",
} as const satisfies Record<ChatTanStackPart["type"], ChatPartPersistence>;

// Validators are independently exhaustive over the persistable subset, so a
// part cannot enter the persistence boundary without structural validation.
const CHAT_PART_VALIDATORS = {
  audio: (part) => isMediaPart(part, "audio/"),
  document: isContentPartWithSource,
  image: isContentPartWithSource,
  "structured-output": (part) => "data" in part,
  text: (part) => typeof part["content"] === "string",
  thinking: (part) => typeof part["content"] === "string",
  "tool-call": (part) =>
    typeof part["id"] === "string" &&
    typeof part["name"] === "string" &&
    typeof part["arguments"] === "string" &&
    isTanStackToolCallState(part["state"]),
  "tool-result": (part) =>
    typeof part["toolCallId"] === "string" &&
    isTanStackToolResultContent(part["content"]) &&
    isTanStackToolResultState(part["state"]) &&
    (!("error" in part) || typeof part["error"] === "string"),
  "ui-resource": isUiResourcePart,
  video: (part) => isMediaPart(part, "video/"),
} satisfies Record<PersistableChatPartType, ChatPartValidator>;

const isChatPartPersistenceType = (
  type: string,
): type is keyof typeof CHAT_PART_PERSISTENCE =>
  Object.hasOwn(CHAT_PART_PERSISTENCE, type);

const chatPartPersistenceFor = (
  type: keyof typeof CHAT_PART_PERSISTENCE,
): ChatPartPersistence => CHAT_PART_PERSISTENCE[type];

const isChatPartType = (
  type: string,
): type is keyof typeof CHAT_PART_VALIDATORS =>
  Object.hasOwn(CHAT_PART_VALIDATORS, type);

export const isChatPart = (part: unknown): part is ChatPart => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }
  const type = part["type"];
  if (
    !isChatPartPersistenceType(type) ||
    chatPartPersistenceFor(type) === "drop"
  ) {
    return false;
  }
  return isChatPartType(type) && CHAT_PART_VALIDATORS[type](part);
};

export const isIncomingChatPart = (part: unknown): part is ChatPart =>
  isChatPart(part) && CHAT_PART_CLIENT_ACCEPTANCE[part.type] === "accept";

export const hasServerOwnedChatPartType = (part: unknown): boolean => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }
  const { type } = part;
  return (
    isChatPartPersistenceType(type) &&
    CHAT_PART_CLIENT_ACCEPTANCE[type] === "server-only"
  );
};

export const isServerOwnedChatPart = (
  part: ChatPart,
): part is AudioPart | UIResourcePart | VideoPart =>
  CHAT_PART_CLIENT_ACCEPTANCE[part.type] === "server-only";

export const applyChatPartPersistenceBudget = (parts: readonly ChatPart[]) => {
  const acceptedParts: ChatPart[] = [];
  const droppedPartTypes: string[] = [];
  let richPartBytes = 0;
  let richPartCount = 0;

  for (const part of parts) {
    if (!isServerOwnedChatPart(part)) {
      acceptedParts.push(part);
      continue;
    }

    const partBytes = Buffer.byteLength(JSON.stringify(part), "utf8");
    if (
      richPartCount >= LIMITS.chatRichPartsPerMessageMax ||
      richPartBytes + partBytes > LIMITS.chatRichPartsTotalMaxBytes
    ) {
      droppedPartTypes.push(part.type);
      continue;
    }

    acceptedParts.push(part);
    richPartBytes += partBytes;
    richPartCount += 1;
  }

  return {
    droppedPartTypes,
    parts: acceptedParts,
    richPartBytes,
    richPartCount,
  };
};

export const restoreServerOwnedChatParts = ({
  incomingParts,
  persistedParts,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
}): ChatPart[] => {
  const restored: ChatPart[] = [];
  for (const part of incomingParts) {
    if (!isServerOwnedChatPart(part)) {
      restored.push(part);
    }
  }
  for (const [index, part] of persistedParts.entries()) {
    if (isServerOwnedChatPart(part)) {
      restored.splice(Math.min(index, restored.length), 0, part);
    }
  }
  return restored;
};

const normalizeMediaSource = (source: ContentPartSource): ContentPartSource => {
  if (source.type === "data") {
    return {
      type: "data",
      value: source.value,
      mimeType: source.mimeType,
    };
  }
  return {
    type: "url",
    value: source.value,
    ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }),
  };
};

const normalizeChatPartForPersistence = (part: ChatPart): ChatPart => {
  switch (part.type) {
    case "audio":
      return {
        type: "audio",
        source: normalizeMediaSource(part.source),
      };
    case "video":
      return {
        type: "video",
        source: normalizeMediaSource(part.source),
      };
    case "ui-resource": {
      const { resource } = part;
      const normalizedResource =
        resource.text === undefined
          ? {
              uri: resource.uri,
              mimeType: MCP_APP_RESOURCE_MIME_TYPE,
              blob:
                resource.blob ??
                panic("Validated UI resource has no text or blob"),
            }
          : {
              uri: resource.uri,
              mimeType: MCP_APP_RESOURCE_MIME_TYPE,
              text: resource.text,
            };
      return {
        type: "ui-resource",
        resource: normalizedResource,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        ...(part.serverId === undefined ? {} : { serverId: part.serverId }),
      };
    }
    case "document":
    case "image":
    case "structured-output":
    case "text":
    case "thinking":
    case "tool-call":
    case "tool-result":
      return part;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
};

type ChatPartPersistenceDecision =
  | { type: "drop"; partType: string }
  | { type: "persist"; part: ChatPart };

export const classifyChatPartForPersistence = (
  part: unknown,
): ChatPartPersistenceDecision => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    panic("Cannot classify a malformed chat part for persistence");
  }
  const type = part["type"];
  if (!isChatPartPersistenceType(type)) {
    panic(`Cannot classify unknown chat part type: ${type}`);
  }
  if (chatPartPersistenceFor(type) === "drop") {
    return { type: "drop", partType: type };
  }
  if (!isChatPart(part)) {
    if (INVALID_CHAT_PART_HANDLING[type] === "drop") {
      return { type: "drop", partType: type };
    }
    panic(`Cannot persist malformed chat part type: ${type}`);
  }
  return { type: "persist", part: normalizeChatPartForPersistence(part) };
};

const isPersistableChatMessage = (
  message: PersistableChatMessageCandidate,
): message is PersistableChatMessage => message.parts.every(isChatPart);

const normalizeChatPartsForPersistence = (
  parts: readonly ChatPart[],
): ChatPart[] => {
  const normalized: ChatPart[] = [];
  for (const part of parts) {
    normalized.push(normalizeChatPartForPersistence(part));
  }
  return applyChatPartPersistenceBudget(normalized).parts;
};

export const toPersistableChatMessage = (
  message: PersistableChatMessageCandidate,
): PersistableChatMessage => {
  if (!isPersistableChatMessage(message)) {
    panic("Cannot mark a chat message with unsupported parts as persistable");
  }
  const normalized = {
    id: message.id,
    role: message.role,
    parts: normalizeChatPartsForPersistence(message.parts),
    ...(message.createdAt === undefined
      ? {}
      : { createdAt: message.createdAt }),
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  };
  if (!isPersistableChatMessage(normalized)) {
    panic("Normalized chat message violates the persistence policy");
  }
  return normalized;
};

const isChatMessageContent = (
  content: ChatMessageContentCandidate,
): content is ChatMessageContent => content.data.every(isChatPart);

export const toChatMessageContent = (
  content: ChatMessageContentCandidate,
): ChatMessageContent => {
  if (!isChatMessageContent(content)) {
    panic("Cannot persist chat message content with unsupported parts");
  }
  const normalized = {
    version: content.version,
    data: normalizeChatPartsForPersistence(content.data),
    ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
  };
  if (!isChatMessageContent(normalized)) {
    panic("Normalized chat content violates the persistence policy");
  }
  return normalized;
};

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
  metadata.serverProvenance === undefined &&
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
