import type { ContentPartSource } from "@tanstack/ai";
import type { ToolCallPart as TanStackToolCallPart } from "@tanstack/ai-client";
import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import { Buffer } from "node:buffer";

import {
  isBoundedBase64Content,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import {
  TANSTACK_TOOL_CALL_STATE_LIFECYCLE,
  TANSTACK_TOOL_RESULT_STATE_LIFECYCLE,
} from "@/api/handlers/chat/tanstack-chat-lifecycle";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
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
  PersistableTerminalAssistantMessage,
  PersistedChatMessageContent,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  isPersistedJsonValue,
  proveParsedToolInput,
  proveParsedToolOutput,
  provePersistedChatMessageContentV3,
  provePersistedJsonArray,
  provePersistedJsonValue,
} from "@/api/lib/chat/persisted-message-content";
import type {
  PersistedToolInput,
  PersistedToolResultContent,
} from "@/api/lib/chat/persisted-message-content";
import { LIMITS } from "@/api/lib/limits";
import { isUserFileUrl, parseUserFileId } from "@/api/lib/user-files/types";

const IMAGE_MIME_PREFIX = "image/";

export type ChatAttachmentInput = {
  filename?: string | undefined;
  mimeType: string;
  placeholder?: string | undefined;
  url: string;
};

export const attachTerminalTurnOutcome = ({
  message,
  turnOutcome,
}: {
  message: PersistableChatMessage;
  turnOutcome: NonNullable<ChatMessageMetadata["turnOutcome"]>;
}): PersistableTerminalAssistantMessage => {
  const terminalMessage = toPersistableChatMessage({
    ...message,
    metadata: { ...message.metadata, turnOutcome },
  });
  if (!isPersistableTerminalAssistantMessage(terminalMessage)) {
    panic("Terminal chat turn must be an assistant message with an outcome");
  }
  return terminalMessage;
};

const isPersistableTerminalAssistantMessage = (
  message: PersistableChatMessage,
): message is PersistableTerminalAssistantMessage =>
  message.role === "assistant" && message.metadata?.turnOutcome !== undefined;

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
  if (content.version === 3) {
    return normalizePersistedV3ChatMessageContent(content);
  }

  if (content.version === 2) {
    return {
      metadata: content.metadata ?? {},
      parts: normalizeLegacyPersistedToolInputs(content.data),
    };
  }

  const normalized = normalizeLegacyMessagePartsToTanStack(
    normalizeLegacyRawToolInputs(content.data),
  );
  return {
    metadata: normalized.metadata,
    parts: normalizeLegacyPersistedToolInputs(normalized.parts),
  };
};

const normalizeLegacyPersistedToolInputs = (
  parts: readonly ChatPart[],
): ChatPart[] => parts.map(normalizeLegacyPersistedToolInput);

const normalizeLegacyPersistedToolInput = (part: ChatPart): ChatPart => {
  if (
    part.type !== "tool-call" ||
    part.input !== undefined ||
    part.state === "awaiting-input" ||
    part.state === "input-streaming"
  ) {
    return part;
  }

  const parsed = Result.try((): unknown => JSON.parse(part.arguments));
  if (Result.isError(parsed)) {
    return part;
  }
  const input =
    parsed.value !== null && typeof parsed.value === "object"
      ? parsed.value
      : {};
  const candidate: unknown = { ...part, input };
  if (!isChatPart(candidate) || candidate.type !== "tool-call") {
    panic(`Stored legacy tool call ${part.id} has invalid input`);
  }
  return candidate;
};

type PersistedV3Part = PersistedChatMessageContentV3["data"][number];

const normalizePersistedV3ChatMessageContent = (
  content: PersistedChatMessageContentV3,
): NormalizedLegacyMessageParts => {
  if (!Array.isArray(content.data)) {
    panic("Stored v3 chat content has invalid data");
  }
  if (
    content.metadata !== undefined &&
    !isPersistedJsonValue(content.metadata)
  ) {
    panic("Stored v3 chat content has invalid metadata");
  }
  const outputByToolCallId = new Map<string, unknown>();
  for (const part of content.data) {
    if (!isRecord(part)) {
      panic("Stored v3 chat content has an invalid part");
    }
    if (part.type === "tool-call" && part.output !== undefined) {
      outputByToolCallId.set(part.id, decodePersistedToolOutput(part.output));
    }
  }

  const parts: ChatPart[] = [];
  for (const part of content.data) {
    parts.push(persistedV3PartToChatPart({ outputByToolCallId, part }));
  }
  return { metadata: content.metadata ?? {}, parts };
};

const persistedV3PartToChatPart = ({
  outputByToolCallId,
  part,
}: {
  outputByToolCallId: ReadonlyMap<string, unknown>;
  part: PersistedV3Part;
}): ChatPart => {
  if (part.type === "tool-call") {
    const persistedInput = decodePersistedToolInput(part.input);
    const input = persistedToolInputToChatInput(persistedInput);
    const output = outputByToolCallId.get(part.id);
    if (part.metadata !== undefined && !isPersistedJsonValue(part.metadata)) {
      panic("Stored v3 tool call has invalid metadata");
    }
    const candidate: unknown = {
      ...(part.approval === undefined ? {} : { approval: part.approval }),
      arguments:
        persistedInput.status === "raw"
          ? persistedInput.rawArguments
          : stringifyPersistedJsonValue(persistedInput.value),
      id: part.id,
      ...(input === undefined ? {} : { input }),
      ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
      name: part.name,
      ...(part.output === undefined ? {} : { output }),
      state: part.state,
      type: "tool-call",
    };
    if (!isChatPart(candidate) || candidate.type !== "tool-call") {
      panic("Stored v3 tool call is not a valid chat part");
    }
    return candidate;
  }

  if (part.type === "tool-result") {
    const content = persistedV3ToolResultContent({
      outputByToolCallId,
      part,
    });
    const candidate: unknown = {
      content,
      ...(part.error === undefined ? {} : { error: part.error }),
      state: part.state,
      toolCallId: part.toolCallId,
      type: "tool-result",
    };
    if (!isChatPart(candidate) || candidate.type !== "tool-result") {
      panic("Stored v3 tool result is not a valid chat part");
    }
    return candidate;
  }

  if (!isChatPart(part)) {
    panic("Stored v3 non-tool part is not a valid chat part");
  }
  return part;
};

const persistedV3ToolResultContent = ({
  outputByToolCallId,
  part,
}: {
  outputByToolCallId: ReadonlyMap<string, unknown>;
  part: Extract<PersistedV3Part, { type: "tool-result" }>;
}): unknown => {
  if (part.content !== undefined) {
    return persistedToolResultContentToChatContent(
      part.content,
      outputByToolCallId.get(part.toolCallId),
    );
  }
  const output = outputByToolCallId.get(part.toolCallId);
  if (output !== undefined) {
    return stringifyPersistedJsonValue(output);
  }
  if (part.state === "error") {
    return null;
  }
  return panic("Stored v3 tool result has no content or paired output");
};

const persistedToolInputToChatInput = (input: PersistedToolInput): unknown =>
  input.status === "parsed" ? input.value : undefined;

const decodePersistedToolInput = (input: unknown): PersistedToolInput => {
  if (!isRecord(input)) {
    return panic("Stored v3 tool call has invalid input");
  }
  if (input["status"] === "raw") {
    return typeof input["rawArguments"] === "string"
      ? { rawArguments: input["rawArguments"], status: "raw" }
      : panic("Stored v3 tool call has invalid raw arguments");
  }
  if (input["status"] === "parsed" && "value" in input) {
    return proveParsedToolInput(input["value"]);
  }
  return panic("Stored v3 tool call has invalid input state");
};

const decodePersistedToolOutput = (output: unknown): unknown => {
  if (!isRecord(output) || !("value" in output)) {
    return panic("Stored v3 tool call has invalid output");
  }
  return proveParsedToolOutput(output["value"]).value;
};

const persistedToolResultContentToChatContent = (
  content: PersistedToolResultContent,
  pairedOutput: unknown,
): unknown => {
  const decoded = decodePersistedToolResultContent(content);
  switch (decoded.type) {
    case "paired-output-parts":
      return provePersistedJsonArray(pairedOutput);
    case "parts":
      return decoded.value;
    case "text":
      return decoded.value;
    default:
      decoded satisfies never;
      return panic(`Unhandled decoded: ${String(decoded)}`);
  }
};

const decodePersistedToolResultContent = (
  content: unknown,
): PersistedToolResultContent => {
  if (!isRecord(content)) {
    return panic("Stored v3 tool result has invalid content");
  }
  if (content["type"] === "paired-output-parts") {
    return { type: "paired-output-parts" };
  }
  if (content["type"] === "text" && typeof content["value"] === "string") {
    return { type: "text", value: content["value"] };
  }
  if (content["type"] === "parts") {
    return { type: "parts", value: provePersistedJsonArray(content["value"]) };
  }
  return panic("Stored v3 tool result has invalid content state");
};

const stringifyPersistedJsonValue = (value: unknown): string => {
  if (!isPersistedJsonValue(value)) {
    panic("Stored canonical tool value is not JSON-serializable");
  }
  const serialized: unknown = JSON.stringify(value);
  if (typeof serialized !== "string") {
    panic("Stored canonical tool value is not JSON-serializable");
  }
  return serialized;
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
): PersistedChatMessageContentV3 =>
  toPersistedChatMessageContentV3({
    data: message.parts,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  });

type ChatPartClientAcceptance = "accept" | "server-only";
type ChatPartProviderVisibility = "model" | "ui-only";
type InvalidChatPartHandling = "drop" | "panic";
type ChatPartPolicy = {
  clientAcceptance: ChatPartClientAcceptance;
  invalidHandling: InvalidChatPartHandling;
  providerVisibility: ChatPartProviderVisibility;
};

// Rich output parts are issued by the trusted stream processor. Accepting
// them from the request body would let a client mint active HTML or remote
// media and have the server return it as trusted persisted history.
// Bounded rich output is external presentation data, so an invalid instance
// is dropped without sacrificing surrounding text. Malformed core protocol
// parts still indicate an SDK/programmer contract violation and fail loudly.
// These parts are presentation output, not conversation context. TanStack
// currently omits UI resources during model conversion; keeping the policy
// explicit here also prevents audio/video replay into a model that may not
// support those modalities on the next turn.
const CHAT_PART_POLICY = {
  audio: {
    clientAcceptance: "server-only",
    invalidHandling: "drop",
    providerVisibility: "ui-only",
  },
  document: {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  image: {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  "structured-output": {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  text: {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  thinking: {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  "tool-call": {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  "tool-result": {
    clientAcceptance: "accept",
    invalidHandling: "panic",
    providerVisibility: "model",
  },
  "ui-resource": {
    clientAcceptance: "server-only",
    invalidHandling: "drop",
    providerVisibility: "ui-only",
  },
  video: {
    clientAcceptance: "server-only",
    invalidHandling: "drop",
    providerVisibility: "ui-only",
  },
} as const satisfies Record<PersistableChatPartType, ChatPartPolicy>;

export const isProviderVisibleChatPart = (part: ChatPart): boolean =>
  CHAT_PART_POLICY[part.type].providerVisibility === "model";

export const toProviderVisibleMessage = (
  message: ChatMessage,
): ChatMessage | null => {
  if (
    message.metadata?.turnOutcome?.type === "cancelled" ||
    message.metadata?.turnOutcome?.type === "failed" ||
    message.metadata?.turnOutcome?.type === "interrupted"
  ) {
    return null;
  }
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

/**
 * Whether a client-executed tool call (ask-user, or any tool without a server
 * `execute`) still awaits its client resolution. A server-executed call never
 * ends a run in `input-complete`: the agent loop executes every tool of a
 * model turn before it decides whether to call the model again, so at run end
 * an `input-complete` call is by construction one the client must resolve.
 */
const CLIENT_TOOL_STATE_AWAITS_RESOLUTION = {
  "approval-requested": false,
  "approval-responded": false,
  // A terminal stream can end while the provider has only announced a call or
  // is still emitting its JSON arguments. Neither state carries usable input,
  // so neither may take durable turn ownership.
  "awaiting-input": false,
  complete: false,
  error: false,
  "input-complete": true,
  "input-streaming": false,
} as const satisfies Record<TanStackToolCallState, boolean>;

const clientToolInteractionType = (name: string): "ask-user" | "client-tool" =>
  name === ASK_USER_TOOL_NAME ? "ask-user" : "client-tool";

type AwaitingUserInteraction = Extract<
  NonNullable<ChatMessageMetadata["turnOutcome"]>,
  { type: "awaiting-user" }
>["interaction"];

type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;

type ChatApprovalMetadata = NonNullable<
  TanStackToolCallPart<never>["approval"]
>;

const isChatApprovalMetadata = (
  value: unknown,
): value is ChatApprovalMetadata =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["needsApproval"] === "boolean" &&
  (value["approved"] === undefined || typeof value["approved"] === "boolean");

const toChatToolCallPart = (value: unknown): ChatToolCallPart => {
  if (!isChatPart(value) || value.type !== "tool-call") {
    return panic("Cannot terminalize malformed chat tool call");
  }
  return value;
};

const getChatToolCallExtension = (
  part: ChatToolCallPart,
  property: "approval" | "metadata",
): unknown => {
  switch (property) {
    case "approval":
      return "approval" in part ? part.approval : undefined;
    case "metadata":
      return "metadata" in part ? part.metadata : undefined;
    default:
      property satisfies never;
      return panic(`Unhandled property: ${String(property)}`);
  }
};

const terminalToolCallError = (part: ChatToolCallPart): ChatToolCallPart => {
  const metadata = getChatToolCallExtension(part, "metadata");
  return toChatToolCallPart({
    arguments: part.arguments,
    id: part.id,
    name: part.name,
    state: "error",
    type: "tool-call",
    ...(metadata === undefined ? {} : { metadata }),
  });
};

const cancelPendingToolCallPart = (
  part: ChatToolCallPart,
): ChatToolCallPart => {
  switch (part.state) {
    case "approval-requested": {
      const approval = getChatToolCallExtension(part, "approval");
      if (!isChatApprovalMetadata(approval)) {
        return terminalToolCallError(part);
      }
      return toChatToolCallPart({
        ...part,
        approval: { ...approval, approved: false },
        state: "approval-responded",
      });
    }
    case "awaiting-input":
    case "input-streaming":
    case "input-complete":
      // Do not leave a partial or client-owned call in a state that a fresh
      // hydration can execute after its owning turn was superseded. Omitting
      // input/approval/output also removes now-invalid user controls.
      return terminalToolCallError(part);
    case "approval-responded":
    case "complete":
    case "error":
      return part;
    default:
      part.state satisfies never;
      return panic(`Unhandled state: ${String(part.state)}`);
  }
};

/**
 * Keep a terminal assistant message internally consistent: metadata records
 * its turn's outcome, and its parts no longer expose an approval or input
 * control that belongs to that terminated turn.
 */
export const cancelPendingChatToolCalls = (
  message: PersistableChatMessage,
): PersistableChatMessage => {
  const parts = message.parts.map((part) =>
    part.type === "tool-call" ? cancelPendingToolCallPart(part) : part,
  );
  return { ...message, parts };
};

/**
 * Every approval-requested call remains actionable. A chat turn is owned by
 * its assistant message, not by whichever pending approval happened to arrive
 * first in the stream.
 */
export const getAwaitingUserInteractions = (
  message: Pick<ChatMessage, "metadata" | "parts" | "role"> | null,
): AwaitingUserInteraction[] => {
  const turnOutcome = message?.metadata?.turnOutcome;
  if (
    message?.role !== "assistant" ||
    (turnOutcome !== undefined && turnOutcome.type !== "awaiting-user")
  ) {
    return [];
  }
  const interactions: AwaitingUserInteraction[] = [];
  for (const part of message.parts) {
    if (part.type !== "tool-call") {
      continue;
    }
    if (part.state === "approval-requested") {
      interactions.push({ type: "approval", toolCallId: part.id });
      continue;
    }
    if (CLIENT_TOOL_STATE_AWAITS_RESOLUTION[part.state]) {
      interactions.push({
        type: clientToolInteractionType(part.name),
        toolCallId: part.id,
      });
    }
  }
  return interactions;
};

export const getAwaitingUserInteraction = (
  message: Pick<ChatMessage, "parts" | "role"> | null,
): AwaitingUserInteraction | null =>
  getAwaitingUserInteractions(message).at(0) ?? null;

/**
 * Whether an incoming tool-call state answers an awaited interaction:
 * `resolved` carries the client's answer, `unchanged` leaves the call as it
 * was awaited (an untouched call while a later interaction in the same
 * message is answered, or a cancelled resume), and `null` is not an answer.
 */
const CLIENT_INTERACTION_RESOLUTION = {
  approval: {
    "approval-requested": "unchanged",
    "approval-responded": "resolved",
    "awaiting-input": null,
    complete: null,
    error: null,
    "input-complete": null,
    "input-streaming": null,
  },
  "ask-user": {
    "approval-requested": null,
    "approval-responded": null,
    "awaiting-input": null,
    complete: "resolved",
    // A client-executed failure round-trips as an error result.
    error: "resolved",
    "input-complete": "unchanged",
    "input-streaming": null,
  },
  "client-tool": {
    "approval-requested": null,
    "approval-responded": null,
    "awaiting-input": null,
    complete: "resolved",
    error: "resolved",
    "input-complete": "unchanged",
    "input-streaming": null,
  },
} as const satisfies Record<
  AwaitingUserInteraction["type"],
  Record<TanStackToolCallState, "resolved" | "unchanged" | null>
>;

type GetResumedUserInteractionOptions = {
  /** Interactions the persisted turn awaits (`getAwaitingUserInteractions`). */
  awaited: readonly AwaitingUserInteraction[];
  message: Pick<ChatMessage, "parts" | "role">;
};

/**
 * Return the awaited interaction a client continuation is resolving. The turn
 * store compares this identity with its canonical awaited interaction before
 * any client-supplied assistant parts replace history. Resolution is defined
 * against the awaited set, never by tool name or state alone: a completed
 * server tool in the same message is not an answer to anything.
 */
export const getResumedUserInteraction = ({
  awaited,
  message,
}: GetResumedUserInteractionOptions): AwaitingUserInteraction | null => {
  if (message.role !== "assistant" || awaited.length === 0) {
    return null;
  }
  const awaitedByToolCallId = new Map(
    awaited.map(
      (interaction) => [interaction.toolCallId, interaction] as const,
    ),
  );
  let unchangedInteraction: AwaitingUserInteraction | null = null;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type !== "tool-call") {
      continue;
    }
    const interaction = awaitedByToolCallId.get(part.id);
    if (interaction === undefined) {
      continue;
    }
    const resolution =
      CLIENT_INTERACTION_RESOLUTION[interaction.type][part.state];
    if (resolution === "resolved") {
      return interaction;
    }
    // Prefer an explicit answer elsewhere in the message. An awaited call the
    // continuation leaves untouched still names the turn it belongs to: a
    // cancelled native resume keeps the call as awaited, and the turn must
    // still find its owner.
    if (resolution === "unchanged") {
      unchangedInteraction = interaction;
    }
  }
  return unchangedInteraction;
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

const isBoundedJsonRecord = (
  value: Record<string, unknown>,
  maxBytes: number,
): boolean => {
  const serialized = Result.try((): unknown => JSON.stringify(value));
  return (
    Result.isOk(serialized) &&
    typeof serialized.value === "string" &&
    Buffer.byteLength(serialized.value, "utf-8") <= maxBytes
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
    ("meta" in part &&
      part["meta"] !== undefined &&
      (!isRecord(part["meta"]) ||
        !isBoundedJsonRecord(part["meta"], LIMITS.chatRichPartsTotalMaxBytes)))
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

type TanStackStructuredOutputStatus = Extract<
  ChatTanStackPart,
  { type: "structured-output" }
>["status"];

const TANSTACK_STRUCTURED_OUTPUT_STATUSES = {
  complete: true,
  error: true,
  streaming: true,
} as const satisfies Record<TanStackStructuredOutputStatus, true>;

const isTanStackStructuredOutputStatus = (
  value: unknown,
): value is TanStackStructuredOutputStatus =>
  typeof value === "string" &&
  Object.hasOwn(TANSTACK_STRUCTURED_OUTPUT_STATUSES, value);

const isStructuredOutputPart = (part: Record<string, unknown>): boolean => {
  const status = part["status"];
  if (
    !isTanStackStructuredOutputStatus(status) ||
    typeof part["raw"] !== "string" ||
    ("reasoning" in part &&
      part["reasoning"] !== undefined &&
      typeof part["reasoning"] !== "string")
  ) {
    return false;
  }

  switch (status) {
    case "streaming":
      return !("errorMessage" in part && part["errorMessage"] !== undefined);
    case "complete":
      return "data" in part && part["data"] !== undefined;
    case "error":
      return typeof part["errorMessage"] === "string";
    default:
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
  }
};

// Validators are independently exhaustive over the persistable subset, so a
// part cannot enter the persistence boundary without structural validation.
const CHAT_PART_VALIDATORS = {
  audio: (part) => isMediaPart(part, "audio/"),
  document: isContentPartWithSource,
  image: isContentPartWithSource,
  "structured-output": isStructuredOutputPart,
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

type TanStackToolCallState = Extract<
  ChatTanStackPart,
  { type: "tool-call" }
>["state"];

type TanStackToolResultState = Extract<
  ChatTanStackPart,
  { type: "tool-result" }
>["state"];

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
  isChatPart(part) && CHAT_PART_POLICY[part.type].clientAcceptance === "accept";

export const hasServerOwnedChatPartType = (part: unknown): boolean => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }
  const { type } = part;
  return (
    isChatPartPersistenceType(type) &&
    CHAT_PART_POLICY[type].clientAcceptance === "server-only"
  );
};

export const isServerOwnedChatPart = (part: ChatPart): boolean =>
  CHAT_PART_POLICY[part.type].clientAcceptance === "server-only";

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

    const partBytes = Buffer.byteLength(JSON.stringify(part), "utf-8");
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
  switch (source.type) {
    case "data":
      return {
        type: "data",
        value: source.value,
        mimeType: source.mimeType,
      };
    case "url":
      return {
        type: "url",
        value: source.value,
        ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }),
      };
    default: {
      source satisfies never;
      return panic(`Unhandled source: ${String(source)}`);
    }
  }
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
        ...(part.meta === undefined ? {} : { meta: part.meta }),
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
      part satisfies never;
      return panic(`Unhandled part: ${String(part)}`);
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
    if (CHAT_PART_POLICY[type].invalidHandling === "drop") {
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

/**
 * Encode one message for the v3 JSONB representation. Canonical tool input and
 * output are stored directly; TanStack wire strings are reconstructed only by
 * `normalizePersisted...` on read.
 */
type PersistedChatMessageContentV3Source = Omit<
  ChatMessageContentCandidate,
  "version"
>;

export const toPersistedChatMessageContentV3 = (
  content: PersistedChatMessageContentV3Source,
): PersistedChatMessageContentV3 => {
  if (!content.data.every(isChatPart)) {
    panic("Cannot persist chat message content with unsupported parts");
  }
  const normalized = normalizeChatPartsForPersistence(content.data);
  const outputsByToolCallId = new Map<string, unknown>();
  for (const part of normalized) {
    if (part.type === "tool-call" && part.output !== undefined) {
      outputsByToolCallId.set(part.id, part.output);
    }
  }
  const data = normalized.map((part) =>
    chatPartToPersistedV3Part({ outputsByToolCallId, part }),
  );
  if (
    content.metadata !== undefined &&
    !isPersistedJsonValue(content.metadata)
  ) {
    panic("Cannot persist non-JSON chat metadata");
  }
  return provePersistedChatMessageContentV3(
    {
      data,
      ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
      version: 3,
    },
    isPersistedV3Part,
  );
};

const chatPartToPersistedV3Part = ({
  outputsByToolCallId,
  part,
}: {
  outputsByToolCallId: ReadonlyMap<string, unknown>;
  part: ChatPart;
}): PersistedV3Part => {
  if (part.type === "tool-call") {
    const approval = "approval" in part ? part.approval : undefined;
    const metadata = "metadata" in part ? part.metadata : undefined;
    const input = persistedToolInputFromChatPart(part);
    return {
      ...(approval === undefined ? {} : { approval }),
      id: part.id,
      input,
      ...(metadata === undefined
        ? {}
        : { metadata: provePersistedJsonValue(metadata) }),
      name: part.name,
      ...(part.output === undefined
        ? {}
        : { output: proveParsedToolOutput(part.output) }),
      state: part.state,
      type: "tool-call",
    };
  }
  if (part.type === "tool-result") {
    const output = outputsByToolCallId.get(part.toolCallId);
    const hasPairedOutput = part.state !== "streaming" && output !== undefined;
    let content: PersistedToolResultContent | undefined;
    if (!hasPairedOutput) {
      content = persistedToolResultContentFromChatContent(part.content);
    } else if (Array.isArray(part.content)) {
      if (!deepEquals(part.content, output)) {
        panic(`Tool result ${part.toolCallId} disagrees with canonical output`);
      }
      content = { type: "paired-output-parts" };
    } else if (part.content !== stringifyPersistedJsonValue(output)) {
      content = { type: "text", value: part.content };
    }
    return {
      ...(content === undefined ? {} : { content }),
      ...(part.error === undefined ? {} : { error: part.error }),
      state: part.state,
      toolCallId: part.toolCallId,
      type: "tool-result",
    };
  }
  return part;
};

const persistedToolInputFromChatPart = (
  part: Extract<ChatPart, { type: "tool-call" }>,
): PersistedToolInput => {
  if (part.state === "awaiting-input" || part.state === "input-streaming") {
    return { rawArguments: part.arguments, status: "raw" };
  }
  if (part.input === undefined) {
    return { rawArguments: part.arguments, status: "raw" };
  }
  return proveParsedToolInput(part.input);
};

const persistedToolResultContentFromChatContent = (
  content: Extract<ChatPart, { type: "tool-result" }>["content"],
): PersistedToolResultContent => {
  if (Array.isArray(content)) {
    return { type: "parts", value: provePersistedJsonArray(content) };
  }
  return { type: "text", value: content };
};

const isPersistedV3Part = (part: PersistedV3Part): boolean => {
  if (part.type === "tool-call") {
    return part.id.length > 0 && part.name.length > 0;
  }
  if (part.type === "tool-result") {
    return part.toolCallId.length > 0;
  }
  return isChatPart(part);
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

const isTanStackToolCallState = (
  value: unknown,
): value is TanStackToolCallState =>
  typeof value === "string" &&
  Object.hasOwn(TANSTACK_TOOL_CALL_STATE_LIFECYCLE, value);

const isTanStackToolResultState = (
  value: unknown,
): value is TanStackToolResultState =>
  typeof value === "string" &&
  Object.hasOwn(TANSTACK_TOOL_RESULT_STATE_LIFECYCLE, value);

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
  metadata.activeDraftContext === undefined &&
  metadata.anonRestorations === undefined &&
  metadata.mentions === undefined &&
  metadata.refContext === undefined &&
  metadata.refEncoding === undefined &&
  metadata.serverProvenance === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.turnOutcome === undefined &&
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
