import {
  isStandardSchema,
  parseWithStandardSchema,
  type SchemaInput,
} from "@tanstack/ai";
import { Result } from "better-result";
import { deepEquals } from "bun";
import type { Static } from "elysia";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, SafeDbError } from "@/api/db";
import type { StoredFileRef } from "@/api/handlers/chat/attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "@/api/handlers/chat/attachment-validation";
import {
  isChatPart,
  isChatTextPart,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { CHAT_TOOL_SCOPE } from "@/api/handlers/chat/tools/tool-scope";
import type {
  ChatMention,
  ChatMessage,
  ChatMessageMetadata,
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";

const rawMessageSchema = t.Object(
  {
    id: tSafeId("chatMessage"),
    role: t.Union([
      t.Literal("system"),
      t.Literal("user"),
      t.Literal("assistant"),
    ]),
    metadata: t.Optional(t.Any()),
    parts: t.Array(t.Any()),
  },
  { additionalProperties: true },
);

export const userContextSchema = t.Object({
  userName: t.String(),
  locale: t.String(),
  timezone: t.String(),
  wordEditAuthorName: t.Optional(t.String()),
  wordEditShortcut: t.Optional(t.String()),
});

const docxEditSnapshotSchema = t.Object({
  canApplyEdits: t.Optional(t.Boolean()),
  blocks: t.Array(
    t.Object({
      id: t.String(),
      kind: t.Union([
        t.Literal("heading"),
        t.Literal("listItem"),
        t.Literal("paragraph"),
      ]),
      text: t.String(),
      displayLabel: t.Optional(t.String()),
      styleId: t.Optional(t.String()),
    }),
  ),
});

export const activeFileSchema = t.Object({
  entityId: tSafeId("entity"),
  fileFieldId: t.Optional(tSafeId("field")),
  fileName: t.String(),
  supportsDocxEdits: t.Optional(t.Boolean()),
  docxEditSnapshot: t.Optional(docxEditSnapshotSchema),
});

/**
 * Template Studio surface: the user is authoring a reusable DOCX
 * template (org-scoped, not a workspace entity). The snapshot mirrors
 * the active-file one so `apply-active-docx-edits` operations target
 * the same block-id space; the Studio client converts queued
 * operations into in-document suggestions.
 */
export const activeTemplateSchema = t.Object({
  templateId: tSafeId("template"),
  fileName: t.String(),
  docxEditSnapshot: t.Optional(docxEditSnapshotSchema),
});

export const activeDecisionSchema = t.Object({
  decisionId: tSafeId("caseLawDecision"),
});

export const activeExternalSchema = t.Object({
  connectorSlug: t.Optional(t.String()),
  provider: t.Optional(t.String()),
  snippet: t.Optional(t.String()),
  sourceToolName: t.Optional(t.String()),
  text: t.Optional(t.String()),
  title: t.String(),
  url: t.String(),
});

export const activeSkillSchema = t.Object({
  skillId: t.Optional(tSafeId("agentSkill")),
  skillName: t.String({ minLength: 1, maxLength: 64 }),
});

export const sendMessageBodySchema = t.Object({
  threadId: tSafeId("chatThread"),
  workspaceId: t.Optional(tSafeId("workspace")),
  sendMode: t.Union([
    t.Literal(CHAT_SEND_MODE.anonymized),
    t.Literal(CHAT_SEND_MODE.rawOverride),
  ]),
  /**
   * Matters the chat draws context from. Empty (or omitted) means
   * "no matters pinned" — the AI discovers matters lazily via the
   * readonly read API. Non-empty narrows tool authorization so
   * requested matterRefs must be a subset of this set. The set is
   * persisted on the chat thread so subsequent turns reuse it
   * without re-sending.
   */
  contextMatterIds: t.Optional(t.Array(tSafeId("workspace"))),
  message: rawMessageSchema,
  truncateAfterMessageId: t.Optional(tSafeId("chatMessage")),
  /**
   * Optional named tool scope for this turn. Only server-defined
   * scope names validate; the server maps the name to a fixed tool
   * allowlist (see `tools/tool-scope.ts`), so a client can narrow
   * but never widen the turn's tool surface.
   */
  toolScope: t.Optional(t.Literal(CHAT_TOOL_SCOPE.suggestTemplateFields)),
  userContext: t.Optional(userContextSchema),
  activeFile: t.Optional(activeFileSchema),
  activeTemplate: t.Optional(activeTemplateSchema),
  activeDecision: t.Optional(activeDecisionSchema),
  activeExternal: t.Optional(activeExternalSchema),
  activeSkill: t.Optional(activeSkillSchema),
  devModelId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:/-]+$",
    }),
  ),
});

type RawIncomingMessage = Static<typeof rawMessageSchema>;
export type IncomingUserContext = Static<typeof userContextSchema>;
export type IncomingActiveFile = Static<typeof activeFileSchema>;
export type IncomingActiveTemplate = Static<typeof activeTemplateSchema>;
export type IncomingActiveDecision = Static<typeof activeDecisionSchema>;
export type IncomingActiveExternal = Static<typeof activeExternalSchema>;
export type IncomingActiveSkill = Static<typeof activeSkillSchema>;

type ValidateMessageInput = {
  message: RawIncomingMessage;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  tools: ChatToolMap;
  userId: SafeId<"user">;
};

type ValidateMessageResult = Result<
  {
    message: PersistableChatMessage;
    storedFileRefs: StoredFileRef[];
  },
  HandlerError<400 | 403 | 404> | SafeDbError
>;

type ChatToolSchema = SchemaInput | undefined;
type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
type ChatToolResultPart = Extract<ChatPart, { type: "tool-result" }>;
type ValidatedToolCallPart = {
  name: string;
  hasOutput: boolean;
  output: unknown;
};

export const validateMessage = async ({
  message,
  safeDb,
  threadId,
  tools,
  userId,
}: ValidateMessageInput): Promise<ValidateMessageResult> =>
  await Result.gen(async function* () {
    const partsResult = validateIncomingChatParts(message.parts);
    if (Result.isError(partsResult)) {
      return Result.err(partsResult.error);
    }

    const metadataResult = validateIncomingChatMetadata(message.metadata);
    if (Result.isError(metadataResult)) {
      return Result.err(metadataResult.error);
    }

    const validatedMessage: PersistableChatMessage = {
      id: message.id,
      role: message.role,
      parts: partsResult.value,
      ...(metadataResult.value === undefined
        ? {}
        : { metadata: metadataResult.value }),
    };
    const toolValidationResult = validateToolCallParts({
      message: validatedMessage,
      tools,
    });

    if (Result.isError(toolValidationResult)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid chat message",
          cause: toolValidationResult.error,
        }),
      );
    }

    const storedFileRefsResult = validateChatFileParts({
      parts: validatedMessage.parts,
    });

    if (Result.isError(storedFileRefsResult)) {
      return Result.err(storedFileRefsResult.error);
    }

    const storedFileRefs = storedFileRefsResult.value;

    if (storedFileRefs.length === 0) {
      return Result.ok({
        message: validatedMessage,
        storedFileRefs,
      });
    }

    const files = yield* Result.await(
      safeDb((tx) =>
        // SAFETY: bounded by the `id IN (...)` set of this one message's stored file refs (userFiles.id is the PK), itself capped by LIMITS.chatContextFilesPerMessage.
        // eslint-disable-next-line require-query-limit/require-query-limit
        tx.query.userFiles.findMany({
          where: {
            id: { in: storedFileRefs.map((ref) => ref.id) },
            userId: { eq: userId },
          },
          columns: {
            id: true,
            threadId: true,
            mimeType: true,
          },
        }),
      ),
    );

    const storedFileValidationResult = validateStoredFileRefs({
      refs: storedFileRefs,
      files,
      threadId,
    });

    if (Result.isError(storedFileValidationResult)) {
      return Result.err(storedFileValidationResult.error);
    }

    return Result.ok({
      message: validatedMessage,
      storedFileRefs,
    });
  });

const validateIncomingChatParts = (
  parts: readonly unknown[],
): Result<ChatPart[], HandlerError<400>> => {
  const validatedParts: ChatPart[] = [];
  for (const part of parts) {
    if (!isChatPart(part)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid chat message part",
        }),
      );
    }
    validatedParts.push(part);
  }
  return Result.ok(validatedParts);
};

const validateIncomingChatMetadata = (
  metadata: unknown,
): Result<ChatMessageMetadata | undefined, HandlerError<400>> => {
  if (metadata === undefined) {
    return Result.ok(undefined);
  }

  if (!isJsonRecord(metadata)) {
    return Result.err(invalidChatMetadataError());
  }

  const validated: ChatMessageMetadata = {};

  const anonRestorations = metadata["anonRestorations"];
  if (anonRestorations !== undefined) {
    const parsed = parseAnonRestorationsMetadata(anonRestorations);
    if (parsed === null) {
      return Result.err(invalidChatMetadataError());
    }
    validated.anonRestorations = parsed;
  }

  const mentions = metadata["mentions"];
  if (mentions !== undefined) {
    const parsed = parseMentionsMetadata(mentions);
    if (parsed === null) {
      return Result.err(invalidChatMetadataError());
    }
    validated.mentions = parsed;
  }

  const sourceDocuments = metadata["sourceDocuments"];
  if (sourceDocuments !== undefined) {
    const parsed = parseSourceDocumentsMetadata(sourceDocuments);
    if (parsed === null) {
      return Result.err(invalidChatMetadataError());
    }
    validated.sourceDocuments = parsed;
  }

  const usage = metadata["usage"];
  if (usage !== undefined) {
    const parsed = parseUsageMetadata(usage);
    if (parsed === null) {
      return Result.err(invalidChatMetadataError());
    }
    validated.usage = parsed;
  }

  return Result.ok(
    isChatMessageMetadataEmpty(validated) ? undefined : validated,
  );
};

const invalidChatMetadataError = () =>
  new HandlerError({
    status: 400,
    message: "Invalid chat message metadata",
  });

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseAnonRestorationsMetadata = (
  value: unknown,
): ChatMessageMetadata["anonRestorations"] | null => {
  if (!isJsonRecord(value) || !Array.isArray(value["pairs"])) {
    return null;
  }

  const pairs = [];
  for (const pair of value["pairs"]) {
    if (!isJsonRecord(pair)) {
      return null;
    }
    const placeholder = pair["placeholder"];
    const original = pair["original"];
    if (typeof placeholder !== "string" || typeof original !== "string") {
      return null;
    }
    pairs.push({ placeholder, original });
  }

  return { pairs };
};

const parseMentionsMetadata = (
  value: unknown,
): ChatMessageMetadata["mentions"] | null => {
  if (!isJsonRecord(value) || !Array.isArray(value["mentions"])) {
    return null;
  }

  const mentions: NonNullable<ChatMessageMetadata["mentions"]>["mentions"] = [];
  for (const mention of value["mentions"]) {
    if (!isJsonRecord(mention)) {
      return null;
    }
    const category = mention["category"];
    const id = mention["id"];
    const label = mention["label"];
    if (
      typeof id !== "string" ||
      typeof label !== "string" ||
      (category !== "entity" && category !== "workspace")
    ) {
      return null;
    }
    if (category === "workspace") {
      mentions.push({ category, id, label });
      continue;
    }
    const workspaceId = mention["workspaceId"];
    if (typeof workspaceId !== "string" && workspaceId !== null) {
      return null;
    }
    mentions.push({ category, id, label, workspaceId });
  }

  return { mentions };
};

const parseSourceDocumentsMetadata = (
  value: unknown,
): ChatMessageMetadata["sourceDocuments"] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const documents = [];
  for (const document of value) {
    if (!isJsonRecord(document)) {
      return null;
    }

    const entityId = document["entityId"];
    const kind = document["kind"];
    const mimeType = document["mimeType"];
    const title = document["title"];
    const workspaceId = document["workspaceId"];
    if (
      typeof entityId !== "string" ||
      typeof kind !== "string" ||
      (typeof mimeType !== "string" && mimeType !== null) ||
      typeof title !== "string" ||
      (typeof workspaceId !== "string" && workspaceId !== null)
    ) {
      return null;
    }

    const parsed: NonNullable<ChatMessageMetadata["sourceDocuments"]>[number] =
      { entityId, kind, mimeType, title, workspaceId };
    for (const key of ["entityRef", "matterRef", "mention"] as const) {
      const optionalValue = document[key];
      if (optionalValue === undefined) {
        continue;
      }
      if (typeof optionalValue !== "string") {
        return null;
      }
      parsed[key] = optionalValue;
    }
    documents.push(parsed);
  }

  return documents;
};

const parseUsageMetadata = (
  value: unknown,
): ChatMessageMetadata["usage"] | null => {
  if (!isJsonRecord(value)) {
    return null;
  }

  const completionTokens = value["completionTokens"];
  const promptTokens = value["promptTokens"];
  const totalTokens = value["totalTokens"];
  if (
    typeof completionTokens !== "number" ||
    typeof promptTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }

  const usage: NonNullable<ChatMessageMetadata["usage"]> = {
    completionTokens,
    promptTokens,
    totalTokens,
  };
  const completionTokensDetails = value["completionTokensDetails"];
  if (completionTokensDetails === undefined) {
    return usage;
  }
  if (!isJsonRecord(completionTokensDetails)) {
    return null;
  }
  const reasoningTokens = completionTokensDetails["reasoningTokens"];
  if (reasoningTokens !== undefined) {
    if (typeof reasoningTokens !== "number") {
      return null;
    }
    usage.completionTokensDetails = { reasoningTokens };
  }
  return usage;
};

const isChatMessageMetadataEmpty = (metadata: ChatMessageMetadata): boolean =>
  metadata.anonRestorations === undefined &&
  metadata.mentions === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.usage === undefined;

const validateToolCallParts = ({
  message,
  tools,
}: {
  message: ChatMessage;
  tools: ChatToolMap;
}): Result<void, HandlerError<400>> => {
  const toolCallsById = new Map<string, ValidatedToolCallPart>();

  for (const part of message.parts) {
    if (part.type === "tool-call") {
      if (toolCallsById.has(part.id)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `Duplicate chat tool call id: ${part.id}`,
          }),
        );
      }

      const toolCallResult = validateToolCallPart({ part, tools });
      if (Result.isError(toolCallResult)) {
        return Result.err(toolCallResult.error);
      }

      toolCallsById.set(part.id, toolCallResult.value);
      continue;
    }

    if (part.type !== "tool-result") {
      continue;
    }

    const toolResult = validateToolResultPart({
      part,
      toolCallsById,
      tools,
    });
    if (Result.isError(toolResult)) {
      return Result.err(toolResult.error);
    }
  }
  return Result.ok();
};

const validateToolCallPart = ({
  part,
  tools,
}: {
  part: ChatToolCallPart;
  tools: ChatToolMap;
}): Result<ValidatedToolCallPart, HandlerError<400>> => {
  const tool = tools[part.name];
  if (tool === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Unknown chat tool: ${part.name}`,
      }),
    );
  }

  const argumentsResult = parseToolArguments(part.arguments);
  if (Result.isError(argumentsResult)) {
    return Result.err(argumentsResult.error);
  }

  const validatedArgumentsResult = validateToolPayload({
    payload: argumentsResult.value,
    payloadName: "arguments",
    schema: tool.inputSchema,
    toolName: part.name,
  });
  if (Result.isError(validatedArgumentsResult)) {
    return Result.err(validatedArgumentsResult.error);
  }

  if (part.input !== undefined) {
    const inputResult = validateToolPayload({
      payload: part.input,
      payloadName: "input",
      schema: tool.inputSchema,
      toolName: part.name,
    });
    if (Result.isError(inputResult)) {
      return Result.err(inputResult.error);
    }
    if (!deepEquals(inputResult.value, validatedArgumentsResult.value)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Chat tool input does not match arguments for ${part.name}`,
        }),
      );
    }
  }

  let hasOutput = false;
  let validatedOutput: unknown = undefined;
  if (part.output !== undefined) {
    const outputResult = validateToolPayload({
      payload: part.output,
      payloadName: "output",
      schema: tool.outputSchema,
      toolName: part.name,
    });
    if (Result.isError(outputResult)) {
      return Result.err(outputResult.error);
    }
    validatedOutput = outputResult.value;
    hasOutput = true;
  }

  return Result.ok({ hasOutput, name: part.name, output: validatedOutput });
};

const validateToolResultPart = ({
  part,
  toolCallsById,
  tools,
}: {
  part: ChatToolResultPart;
  toolCallsById: Map<string, ValidatedToolCallPart>;
  tools: ChatToolMap;
}): Result<void, HandlerError<400>> => {
  if (part.state === "streaming") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Incomplete chat tool result: ${part.toolCallId}`,
      }),
    );
  }

  const toolCall = toolCallsById.get(part.toolCallId);
  if (toolCall === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Chat tool result has no matching call: ${part.toolCallId}`,
      }),
    );
  }

  if (part.state === "error") {
    return validateToolErrorResult(part);
  }

  if (!toolCall.hasOutput) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Chat tool result has no paired output: ${part.toolCallId}`,
      }),
    );
  }

  const tool = tools[toolCall.name];
  if (tool === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Unknown chat tool: ${toolCall.name}`,
      }),
    );
  }

  const contentResult = parseToolResultContent(part.content);
  if (Result.isError(contentResult)) {
    return Result.err(contentResult.error);
  }

  const outputResult = validateToolPayload({
    payload: contentResult.value,
    payloadName: "result",
    schema: tool.outputSchema,
    toolName: toolCall.name,
  });
  if (Result.isError(outputResult)) {
    return Result.err(outputResult.error);
  }

  if (!deepEquals(outputResult.value, toolCall.output)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Chat tool result does not match output for ${toolCall.name}`,
      }),
    );
  }

  return Result.ok();
};

const validateToolErrorResult = (
  part: ChatToolResultPart,
): Result<void, HandlerError<400>> => {
  const contentResult = parseToolResultContent(part.content);
  if (Result.isError(contentResult)) {
    return Result.err(contentResult.error);
  }

  if (contentResult.value !== null || !part.error) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Invalid chat tool error result: ${part.toolCallId}`,
      }),
    );
  }

  return Result.ok();
};

const parseToolArguments = (
  value: string,
): Result<unknown, HandlerError<400>> => {
  const parsed = Result.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "Invalid chat tool arguments",
        cause,
      }),
  });
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }

  const parsedValue = parsed.value;
  return Result.ok(
    parsedValue !== null && typeof parsedValue === "object" ? parsedValue : {},
  );
};

const parseToolResultContent = (
  content: ChatToolResultPart["content"],
): Result<unknown, HandlerError<400>> => {
  if (typeof content !== "string") {
    return Result.ok(content);
  }

  const parsed = Result.try({
    try: () => JSON.parse(content) as unknown,
    catch: () => content,
  });
  if (Result.isError(parsed)) {
    return Result.ok(content);
  }
  return Result.ok(parsed.value);
};

const validateToolPayload = ({
  payload,
  payloadName,
  schema,
  toolName,
}: {
  payload: unknown;
  payloadName: "arguments" | "input" | "output" | "result";
  schema: ChatToolSchema;
  toolName: string;
}): Result<unknown, HandlerError<400>> => {
  if (schema === undefined || !isStandardSchema(schema)) {
    return Result.ok(payload);
  }

  const validated = Result.try({
    try: () => parseWithStandardSchema(schema, payload),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: `Invalid chat tool ${payloadName} for ${toolName}`,
        cause,
      }),
  });
  if (Result.isError(validated)) {
    return Result.err(validated.error);
  }
  return Result.ok(validated.value);
};

type ParseMessageProps = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  message: PersistableChatMessage;
};

type ParseMessageResult = {
  mentions: ChatMention[];
  message: PersistableChatMessage;
};

export const parseMessage = ({
  accessibleWorkspaceIds,
  message,
}: ParseMessageProps): ParseMessageResult => {
  if (message.role !== "user") {
    return {
      message,
      mentions: [],
    };
  }

  const normalizedParts: ChatMessage["parts"] = [];
  const mentions: ChatMention[] = [];

  for (const part of message.parts) {
    if (isChatTextPart(part)) {
      const normalizedText = normalizeChatMessageHtml(
        part.content,
        accessibleWorkspaceIds,
      );

      mentions.push(...normalizedText.mentions);
      normalizedParts.push({
        ...part,
        content: normalizedText.text,
      });
      continue;
    }

    normalizedParts.push(part);
  }

  return {
    message: {
      ...message,
      parts: normalizedParts,
    },
    mentions,
  };
};
