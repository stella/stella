// Frozen pre-cutover conversion for the one-time v3 data migration. Runtime
// readers must never import this module.
import { panic, Result, TaggedError } from "better-result";
import { deepEquals } from "bun";

import {
  createChatAttachmentPart,
  isChatPart,
  mergeAnonRestorations,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { normalizeStoredChatToolExecutor } from "@/api/handlers/chat/legacy-tool-compat";
import type {
  ChatAttachmentPart,
  ChatMessageMetadata,
  ChatPart,
  ChatTanStackPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { arrayOrEmpty } from "@/api/lib/array";
import { isPersistedJsonValue } from "@/api/lib/chat/persisted-message-content";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

export class LegacyChatContentError extends TaggedError(
  "LegacyChatContentError",
)<{
  message: string;
  reason: "invalid-legacy-part";
}> {}

const invalidLegacyPart = (
  message = "Stored legacy chat content has an invalid or unsupported part",
): never => {
  throw new LegacyChatContentError({ message, reason: "invalid-legacy-part" });
};

const isOptionalString = (value: unknown) =>
  value === undefined || typeof value === "string";
const isOptionalNullableString = (value: unknown) =>
  value === null || isOptionalString(value);

type LegacyAiSdkFilePart = {
  filename?: string | undefined;
  mediaType: string;
  placeholder?: string | undefined;
  type: "file";
  url: string;
};

type LegacyAiSdkTextPart = {
  text: string;
  type: "text";
};

type NormalizedLegacyMessageParts = {
  metadata: ChatMessageMetadata;
  parts: ChatPart[];
};

const isLegacyAiSdkTextPart = (part: unknown): part is LegacyAiSdkTextPart =>
  isRecord(part) && part["type"] === "text" && typeof part["text"] === "string";

const isLegacyAiSdkFilePart = (part: unknown): part is LegacyAiSdkFilePart =>
  isRecord(part) &&
  part["type"] === "file" &&
  typeof part["mediaType"] === "string" &&
  typeof part["url"] === "string" &&
  isOptionalString(part["filename"]) &&
  isOptionalString(part["placeholder"]);

const legacyAiSdkTextPartToTanStack = (
  part: LegacyAiSdkTextPart,
): Extract<ChatTanStackPart, { type: "text" }> => ({
  type: "text",
  content: part.text,
});

const legacyAiSdkFilePartToTanStack = (
  part: LegacyAiSdkFilePart,
): ChatAttachmentPart =>
  createChatAttachmentPart({
    filename:
      part.filename === undefined ? undefined : sanitizeFilename(part.filename),
    mimeType: part.mediaType,
    placeholder: part.placeholder,
    url: part.url,
  });

const normalizeLegacyMessagePartsToTanStack = (
  parts: readonly unknown[],
): NormalizedLegacyMessageParts => {
  const normalized: ChatPart[] = [];
  const metadata: ChatMessageMetadata = {};
  for (const part of parts) {
    if (!isPersistedJsonValue(part)) {
      invalidLegacyPart();
    }
    if (
      isRecord(part) &&
      part["type"] === "text" &&
      "text" in part &&
      !isLegacyAiSdkTextPart(part)
    ) {
      invalidLegacyPart();
    }
    if (isChatPart(part)) {
      normalized.push(validateV2Part(part));
      continue;
    }
    if (isLegacyAiSdkTextPart(part)) {
      normalized.push(legacyAiSdkTextPartToTanStack(part));
      continue;
    }
    if (isLegacyAiSdkFilePart(part)) {
      normalized.push(validateV2Part(legacyAiSdkFilePartToTanStack(part)));
      continue;
    }
    if (isLegacyAnonRestorationsPart(part)) {
      const merged = mergeAnonRestorations(
        metadata.anonRestorations,
        part.data,
      );
      if (merged.conflicts > 0) {
        invalidLegacyPart(
          "Stored legacy restorations would lose a conflicting value",
        );
      }
      metadata.anonRestorations = merged.restorations;
      continue;
    }
    if (isLegacyMentionsPart(part)) {
      if (
        metadata.mentions !== undefined &&
        !deepEquals(metadata.mentions, part.data)
      ) {
        invalidLegacyPart(
          "Stored legacy mentions would overwrite a previous part",
        );
      }
      metadata.mentions = part.data;
      continue;
    }
    if (isLegacySourceDocumentPart(part)) {
      const sourceDocuments = metadata.sourceDocuments;
      const documents = arrayOrEmpty(sourceDocuments).slice();
      documents.push(part.data);
      metadata.sourceDocuments = documents;
      continue;
    }
    if (isLegacyToolPart(part)) {
      const converted = legacyToolPartToTanStack(part);
      if (converted === null) {
        return invalidLegacyPart();
      }
      normalized.push(converted);
      continue;
    }
    invalidLegacyPart();
  }
  return { metadata, parts: normalized };
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

const isLegacyAnonRestorationsPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["anonRestorations"]>;
  type: "data-stella-anon-restorations";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-anon-restorations" &&
  isRecord(part["data"]) &&
  Array.isArray(part["data"]["pairs"]) &&
  part["data"]["pairs"].every(
    (pair) =>
      isRecord(pair) &&
      typeof pair["placeholder"] === "string" &&
      typeof pair["original"] === "string",
  );

const isLegacyMentionsPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["mentions"]>;
  type: "data-stella-mentions";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-mentions" &&
  isRecord(part["data"]) &&
  Array.isArray(part["data"]["mentions"]) &&
  part["data"]["mentions"].every(
    (mention) =>
      isRecord(mention) &&
      typeof mention["id"] === "string" &&
      typeof mention["label"] === "string" &&
      (mention["category"] === "entity" ||
        mention["category"] === "workspace") &&
      isOptionalNullableString(mention["workspaceId"]),
  );

const isLegacySourceDocumentPart = (
  part: unknown,
): part is {
  data: NonNullable<ChatMessageMetadata["sourceDocuments"]>[number];
  type: "data-stella-source-document";
} =>
  isRecord(part) &&
  part["type"] === "data-stella-source-document" &&
  isRecord(part["data"]) &&
  typeof part["data"]["kind"] === "string" &&
  typeof part["data"]["title"] === "string" &&
  isOptionalString(part["data"]["entityId"]) &&
  isOptionalString(part["data"]["entityRef"]) &&
  isOptionalString(part["data"]["matterRef"]) &&
  isOptionalString(part["data"]["mention"]) &&
  isOptionalNullableString(part["data"]["mimeType"]) &&
  isOptionalNullableString(part["data"]["workspaceId"]);

const isLegacyToolPart = (
  part: unknown,
): part is Record<string, unknown> & { type: string } => {
  if (!isRecord(part) || typeof part["type"] !== "string") {
    return false;
  }
  if (part["type"] === "dynamic-tool") {
    return typeof part["toolName"] === "string";
  }
  return (
    part["type"].startsWith("tool-") &&
    part["type"] !== "tool-call" &&
    part["type"] !== "tool-result"
  );
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
    ...("metadata" in part ? { metadata: part["metadata"] } : {}),
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
    case "awaiting-input":
      return "input-complete" as const;
    default:
      return invalidLegacyPart();
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
  if (approval === undefined) {
    return {};
  }
  if (!isRecord(approval)) {
    return invalidLegacyPart();
  }
  const id = getStringProperty(approval, "id");
  const needsApproval = approval["needsApproval"];
  const approved = approval["approved"];
  if (
    !id ||
    typeof needsApproval !== "boolean" ||
    (approved !== undefined && typeof approved !== "boolean")
  ) {
    return invalidLegacyPart();
  }
  return {
    approval: {
      id,
      needsApproval,
      ...(typeof approved === "boolean" ? { approved } : {}),
    },
  };
};

type CreateDocumentInput = {
  name: string;
  source: string;
};
type CreateDocumentOutput =
  | {
      success: true;
      fileName: string;
      entityId: string;
      fieldId: string;
      workspaceId: string;
      entityRef: string;
      matterRef: string;
      href: string;
      mention: string;
    }
  | {
      success: false;
      message: string;
    };

const CREATE_DOCUMENT_TOOL_PART_TYPE = "tool-create-document";
// Old outputs predate route IDs. Empty IDs pass historical-message validation
// while keeping the web "open created document" affordance hidden.
const LEGACY_MISSING_ROUTE_ID = "";

const normalizeLegacyRawToolInputs = (parts: readonly unknown[]): unknown[] =>
  parts.map((part) => normalizeLegacyRawCreateDocumentPart(part));

const normalizeCreateDocumentInput = (
  input: unknown,
): CreateDocumentInput | null => {
  const name = getLegacyStringProperty(input, "name");
  const source =
    getLegacyStringProperty(input, "source") ??
    getLegacyStringProperty(input, "markdown");
  if (!name || !source) {
    return null;
  }

  return { name, source };
};

const normalizeCreateDocumentOutput = (
  output: unknown,
): CreateDocumentOutput | null => {
  if (!isRecord(output)) {
    return null;
  }

  if (output["success"] === false) {
    const message = getLegacyStringProperty(output, "message");
    return message ? { success: false, message } : null;
  }

  if (output["success"] !== true) {
    return null;
  }

  const fileName = getLegacyStringProperty(output, "fileName");
  const entityRef = getLegacyStringProperty(output, "entityRef");
  const matterRef = getLegacyStringProperty(output, "matterRef");
  const href = getLegacyStringProperty(output, "href");
  const mention = getLegacyStringProperty(output, "mention");
  if (!fileName || !entityRef || !matterRef || !href || !mention) {
    return null;
  }

  return {
    success: true,
    fileName,
    entityId:
      getLegacyStringProperty(output, "entityId") ?? LEGACY_MISSING_ROUTE_ID,
    fieldId:
      getLegacyStringProperty(output, "fieldId") ?? LEGACY_MISSING_ROUTE_ID,
    workspaceId:
      getLegacyStringProperty(output, "workspaceId") ?? LEGACY_MISSING_ROUTE_ID,
    entityRef,
    matterRef,
    href,
    mention,
  };
};

const normalizeLegacyRawCreateDocumentPart = (part: unknown): unknown => {
  if (!isRecord(part) || part["type"] !== CREATE_DOCUMENT_TOOL_PART_TYPE) {
    return part;
  }

  const rawInput = part["input"];
  if (
    isRecord(rawInput) &&
    (!isOptionalString(rawInput["name"]) ||
      !isOptionalString(rawInput["source"]) ||
      !isOptionalString(rawInput["markdown"]))
  ) {
    return invalidLegacyPart();
  }
  const rawOutput = part["output"];
  if (
    isRecord(rawOutput) &&
    ((rawOutput["success"] !== undefined &&
      typeof rawOutput["success"] !== "boolean") ||
      ![
        "message",
        "fileName",
        "entityId",
        "fieldId",
        "workspaceId",
        "entityRef",
        "matterRef",
        "href",
        "mention",
      ].every((key) => isOptionalString(rawOutput[key])))
  ) {
    return invalidLegacyPart();
  }
  const input = normalizeCreateDocumentInput(rawInput);
  const output = normalizeCreateDocumentOutput(rawOutput);
  if (!input && !output) {
    return part;
  }

  return {
    ...part,
    ...(input && { input }),
    ...(output && { output }),
  };
};

const getLegacyStringProperty = (
  value: unknown,
  key: string,
): string | null => {
  if (!isRecord(value)) {
    return null;
  }

  const property = value[key];
  return typeof property === "string" ? property : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeStringifyToolArguments = (value: unknown): string => {
  const serialized = Result.try((): unknown => JSON.stringify(value));
  return Result.isOk(serialized) && typeof serialized.value === "string"
    ? serialized.value
    : "{}";
};

const getStringProperty = (
  value: Record<string, unknown>,
  key: string,
): string | null => {
  const property = value[key];
  return typeof property === "string" ? property : null;
};

export const convertLegacyChatContent = (
  content: unknown,
): PersistedChatMessageContentV3 => {
  if (!isRecord(content) || !Array.isArray(content["data"])) {
    return panic("Stored legacy chat content has invalid data");
  }
  const version = content["version"];
  if (version !== 1 && version !== 2) {
    return panic("Legacy chat conversion requires version 1 or 2");
  }
  if (version === 1 && content["metadata"] !== undefined) {
    return invalidLegacyPart(
      "Stored v1 chat content has unsupported envelope metadata",
    );
  }
  const normalized =
    version === 1
      ? normalizeLegacyMessagePartsToTanStack(
          normalizeLegacyRawToolInputs(content["data"]),
        )
      : normalizeV2Content(content);
  const proved = Result.try({
    try: () =>
      toPersistedChatMessageContentV3({
        data: (version === 1
          ? normalized.parts
          : normalizeLegacyPersistedToolInputs(normalized.parts)
        ).map(normalizeStoredChatToolExecutor),
        ...(Object.keys(normalized.metadata).length > 0 ||
        (version === 2 && content["metadata"] !== undefined)
          ? { metadata: normalized.metadata }
          : {}),
      }),
    catch: () =>
      new LegacyChatContentError({
        message: "Stored legacy chat parts cannot be proved as v3",
        reason: "invalid-legacy-part",
      }),
  });
  if (proved.isErr()) {
    throw proved.error;
  }
  return proved.value;
};

const normalizeV2Content = (
  content: Record<string, unknown>,
): NormalizedLegacyMessageParts => {
  const parts = content["data"];
  if (!Array.isArray(parts)) {
    return invalidLegacyPart("Stored v2 chat content has invalid parts");
  }
  const metadata = content["metadata"];
  if (metadata !== undefined && !isLegacyMetadata(metadata)) {
    return invalidLegacyPart("Stored v2 chat content has invalid metadata");
  }
  return { parts: parts.map(validateV2Part), metadata: metadata ?? {} };
};

const validateV2Part = (part: unknown): ChatPart => {
  if (!isChatPart(part) || !isPersistedJsonValue(part)) {
    return invalidLegacyPart("Stored v2 chat content has invalid parts");
  }
  if (part.type === "tool-call") {
    if (!part.id || !part.name) {
      return invalidLegacyPart();
    }
    legacyToolApprovalToTanStack(
      "approval" in part ? part.approval : undefined,
    );
  }
  return part;
};

const isLegacyMetadata = (value: unknown): value is ChatMessageMetadata => {
  if (!isRecord(value) || !isPersistedJsonValue(value)) {
    return false;
  }
  if (
    value["anonRestorations"] !== undefined &&
    !isLegacyAnonRestorationsPart({
      type: "data-stella-anon-restorations",
      data: value["anonRestorations"],
    })
  ) {
    return false;
  }
  if (
    value["mentions"] !== undefined &&
    !isLegacyMentionsPart({
      type: "data-stella-mentions",
      data: value["mentions"],
    })
  ) {
    return false;
  }
  const sourceDocuments = value["sourceDocuments"];
  return (
    sourceDocuments === undefined ||
    (Array.isArray(sourceDocuments) &&
      sourceDocuments.every((data) =>
        isLegacySourceDocumentPart({
          type: "data-stella-source-document",
          data,
        }),
      ))
  );
};
