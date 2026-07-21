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
import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { StoredFileRef } from "@/api/handlers/chat/attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "@/api/handlers/chat/attachment-validation";
import {
  chatMessageFromPersisted,
  getAwaitingUserInteractions,
  getResumedUserInteraction,
  hasServerOwnedChatPartType,
  isIncomingChatPart,
  isChatTextPart,
  restoreServerOwnedChatParts,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { CHAT_TOOL_SCOPE } from "@/api/handlers/chat/tools/tool-scope";
import type {
  ChatMention,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessageRole,
  ChatPart,
  PersistableChatMessage,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";

export const CHAT_RUN_MODE = { agent: "agent" } as const;
export type ChatRunMode = (typeof CHAT_RUN_MODE)[keyof typeof CHAT_RUN_MODE];

const rawMessageSchema = t.Object(
  {
    id: tSafeId("chatMessage"),
    role: t.Union([
      t.Literal("system"),
      t.Literal("user"),
      t.Literal("assistant"),
    ]),
    metadata: t.Optional(t.Unknown()),
    parts: t.Array(t.Unknown()),
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

export const activeDraftSchema = t.Object({
  originChatMessageId: tSafeId("chatMessage"),
  originChatThreadId: tSafeId("chatThread"),
  toolCallId: t.String(),
  fileName: t.String(),
  docxEditSnapshot: docxEditSnapshotSchema,
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

/**
 * Which of the two DOCX-edit review modes a chat turn uses -- they are
 * mutually exclusive tool surfaces, not independent toggles:
 * - `manual`: `apply-active-docx-edits` (client-executed). Operations are
 *   queued into the browser review panel; the user reviews and applies
 *   each suggestion themselves.
 * - `auto`: `edit_workspace_document` (server-executed). Operations are
 *   applied headlessly and written straight to a new entity version.
 * `getChatTools` registers exactly one of the two tools for a given mode,
 * never both, so the model is never handed a choice between them.
 */
export const CHAT_EDIT_APPLY_MODE = {
  manual: "manual",
  auto: "auto",
} as const;
export type ChatEditApplyMode =
  (typeof CHAT_EDIT_APPLY_MODE)[keyof typeof CHAT_EDIT_APPLY_MODE];

/**
 * Default review mode: AI edits auto-apply as tracked changes (attributed
 * to the acting user's configured author name), writing a new version
 * directly. The user can switch to manual (queued) review or direct
 * (non-tracked) rewrite via the mode selectors. A single constant so the
 * default is easy to change later.
 */
export const DEFAULT_CHAT_EDIT_APPLY_MODE: ChatEditApplyMode =
  CHAT_EDIT_APPLY_MODE.auto;

/**
 * The redline representation `edit_workspace_document` (the `auto` review
 * mode) writes operations with. Distinct from folio's own `mode` (the
 * `FolioAIEditApplyMode` the `@stll/folio-core` apply layer accepts) and
 * from the manual flow's per-suggestion `appliedMode` -- named separately so
 * the three never get confused at a call site. `suggested` is deliberately
 * excluded: that representation exists for the manual queued-review flow,
 * which this setting does not apply to.
 */
export const DOCX_EDIT_REPRESENTATION = {
  trackedChanges: "tracked-changes",
  direct: "direct",
} as const;
export type DocxEditRepresentation =
  (typeof DOCX_EDIT_REPRESENTATION)[keyof typeof DOCX_EDIT_REPRESENTATION];

export const DEFAULT_DOCX_EDIT_REPRESENTATION: DocxEditRepresentation =
  DOCX_EDIT_REPRESENTATION.trackedChanges;

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
  turnIntent: t.Optional(t.Literal(CHAT_TURN_INTENT.regenerate)),
  /**
   * Optional named tool scope for this turn. Only server-defined
   * scope names validate; the server maps the name to a fixed tool
   * allowlist (see `tools/tool-scope.ts`), so a client can narrow
   * but never widen the turn's tool surface.
   */
  toolScope: t.Optional(t.Literal(CHAT_TOOL_SCOPE.suggestTemplateFields)),
  /**
   * Execution mode for this turn. Absent (the default) runs the normal
   * server-side chat model with the user's selected model, tools, and MCP.
   * `"agent"` explicitly requests an agent-sandbox run (plan 050); the request
   * fails when the deployment has not enabled and fully configured that
   * engine. Making this an explicit opt-in means a normal, BYOK, or
   * model-selected chat is never silently rerouted into a sandbox just because
   * the engine is enabled.
   * A single-value literal today; it grows to a union as engines/harnesses land.
   */
  runMode: t.Optional(t.Literal(CHAT_RUN_MODE.agent)),
  userContext: t.Optional(userContextSchema),
  activeDraft: t.Optional(activeDraftSchema),
  activeFile: t.Optional(activeFileSchema),
  activeTemplate: t.Optional(activeTemplateSchema),
  activeDecision: t.Optional(activeDecisionSchema),
  activeExternal: t.Optional(activeExternalSchema),
  activeSkill: t.Optional(activeSkillSchema),
  /**
   * Which DOCX-edit review mode this turn uses; omitted means
   * `DEFAULT_CHAT_EDIT_APPLY_MODE`. Threaded into `getChatTools`, which
   * registers exactly one of `apply-active-docx-edits` (manual) /
   * `edit_workspace_document` (auto) accordingly -- never both.
   */
  editApplyMode: t.Optional(
    t.Union([
      t.Literal(CHAT_EDIT_APPLY_MODE.manual),
      t.Literal(CHAT_EDIT_APPLY_MODE.auto),
    ]),
  ),
  /**
   * Redline representation for the `auto` review mode only; omitted means
   * `DEFAULT_DOCX_EDIT_REPRESENTATION`. Ignored in `manual` mode, where the
   * human picks the representation at accept time.
   */
  docxEditRepresentation: t.Optional(
    t.Union([
      t.Literal(DOCX_EDIT_REPRESENTATION.trackedChanges),
      t.Literal(DOCX_EDIT_REPRESENTATION.direct),
    ]),
  ),
  devModelId: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:/-]+$",
    }),
  ),
});

export type ChatSendRequest = Static<typeof sendMessageBodySchema>;

type RawIncomingMessage = Static<typeof rawMessageSchema>;
export type IncomingUserContext = Static<typeof userContextSchema>;
export type IncomingActiveFile = Static<typeof activeFileSchema>;
export type IncomingActiveDraft = Static<typeof activeDraftSchema>;
export type IncomingActiveTemplate = Static<typeof activeTemplateSchema>;
export type IncomingActiveDecision = Static<typeof activeDecisionSchema>;
export type IncomingActiveExternal = Static<typeof activeExternalSchema>;
export type IncomingActiveSkill = Static<typeof activeSkillSchema>;

type ValidateMessageInput = {
  message: RawIncomingMessage;
  persistedMessage: {
    content: PersistedChatMessageContent;
    role: ChatMessageRole;
  } | null;
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
const CONTINUATION_TOOL_CALL_TRANSITIONS = {
  "approval-requested": ["approval-requested", "approval-responded"],
  "approval-responded": ["approval-responded"],
  "awaiting-input": ["awaiting-input"],
  complete: ["complete"],
  error: ["error"],
  "input-complete": ["input-complete", "complete", "error"],
  "input-streaming": ["input-streaming"],
} as const satisfies Record<
  ChatToolCallPart["state"],
  readonly ChatToolCallPart["state"][]
>;
const TOOL_CALL_OUTPUT_VALIDATION = {
  "awaiting-input": "schema",
  "approval-requested": "schema",
  "approval-responded": "schema",
  complete: "schema",
  error: "error",
  "input-complete": "schema",
  "input-streaming": "schema",
} as const satisfies Record<ChatToolCallPart["state"], "error" | "schema">;
const TOOL_RESULT_VALIDATION = {
  complete: "output",
  error: "error",
  streaming: "incomplete",
} as const satisfies Record<
  ChatToolResultPart["state"],
  "error" | "incomplete" | "output"
>;
type ValidatedToolCallPart =
  | {
      type: "error";
      name: string;
      error: string | undefined;
    }
  | {
      type: "schema";
      name: string;
      output: { type: "absent" } | { type: "present"; value: unknown };
    };

export const validateMessage = async ({
  message,
  persistedMessage,
  safeDb,
  threadId,
  tools,
  userId,
}: ValidateMessageInput): Promise<ValidateMessageResult> =>
  await Result.gen(async function* () {
    const partsResult = validateIncomingChatParts({
      message,
      persistedMessage,
    });
    if (Result.isError(partsResult)) {
      return Result.err(partsResult.error);
    }

    const metadataResult = validateIncomingChatMetadata(message.metadata);
    if (Result.isError(metadataResult)) {
      return Result.err(metadataResult.error);
    }

    const metadata = restoreServerOwnedChatMetadata({
      incomingMetadata: metadataResult.value,
      message,
      persistedMessage,
    });

    const validatedMessage = toPersistableChatMessage({
      id: message.id,
      role: message.role,
      parts: partsResult.value,
      ...(metadata === undefined ? {} : { metadata }),
    });
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
          limit: storedFileRefs.length,
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

const restoreServerOwnedChatMetadata = ({
  incomingMetadata,
  message,
  persistedMessage,
}: {
  incomingMetadata: ChatMessageMetadata | undefined;
  message: RawIncomingMessage;
  persistedMessage: ValidateMessageInput["persistedMessage"];
}): ChatMessageMetadata | undefined => {
  if (message.role !== "assistant" || persistedMessage?.role !== "assistant") {
    return incomingMetadata;
  }

  const persistedMetadata = chatMessageFromPersisted({
    id: message.id,
    role: persistedMessage.role,
    content: persistedMessage.content,
  }).metadata;
  const restored: ChatMessageMetadata = {
    ...incomingMetadata,
    ...(persistedMetadata?.serverProvenance === undefined
      ? {}
      : { serverProvenance: persistedMetadata.serverProvenance }),
    ...(persistedMetadata?.activeDraftContext === undefined
      ? {}
      : { activeDraftContext: persistedMetadata.activeDraftContext }),
    ...(persistedMetadata?.sourceDocuments === undefined
      ? {}
      : { sourceDocuments: persistedMetadata.sourceDocuments }),
    ...(persistedMetadata?.turnOutcome === undefined
      ? {}
      : { turnOutcome: persistedMetadata.turnOutcome }),
  };
  return isChatMessageMetadataEmpty(restored) ? undefined : restored;
};

const validateIncomingChatParts = ({
  message,
  persistedMessage,
}: {
  message: RawIncomingMessage;
  persistedMessage: ValidateMessageInput["persistedMessage"];
}): Result<ChatPart[], HandlerError<400>> => {
  const validatedParts: ChatPart[] = [];
  for (const part of message.parts) {
    if (isIncomingChatPart(part)) {
      validatedParts.push(part);
      continue;
    }
    // Assistant continuations echo the complete client-side message. Ignore
    // every client copy of server-owned presentation output; the canonical
    // persisted copies are restored below. User messages cannot carry them.
    if (message.role === "assistant" && hasServerOwnedChatPartType(part)) {
      continue;
    }
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid chat message part",
      }),
    );
  }

  const persistedParts =
    message.role === "assistant" && persistedMessage?.role === "assistant"
      ? chatMessageFromPersisted({
          id: message.id,
          role: persistedMessage.role,
          content: persistedMessage.content,
        }).parts
      : [];
  if (message.role === "assistant" && persistedMessage?.role === "assistant") {
    const continuationIntegrityResult = validateContinuationToolCallIntegrity({
      incomingParts: validatedParts,
      persistedParts,
    });
    if (Result.isError(continuationIntegrityResult)) {
      return Result.err(continuationIntegrityResult.error);
    }
  }
  return Result.ok(
    restoreServerOwnedChatParts({
      incomingParts: validatedParts,
      persistedParts,
    }),
  );
};

/**
 * A client continuation may supply the result of an awaited interaction, but
 * it must not change the canonical call that requested it. In particular, the
 * provider-visible name, arguments, and input remain server-authored.
 */
const validateContinuationToolCallIntegrity = ({
  incomingParts,
  persistedParts,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
}): Result<void, HandlerError<400>> => {
  const canonicalCalls = persistedParts.filter(
    (part): part is ChatToolCallPart => part.type === "tool-call",
  );
  const incomingCalls = incomingParts.filter(
    (part): part is ChatToolCallPart => part.type === "tool-call",
  );
  if (incomingCalls.length !== canonicalCalls.length) {
    return invalidContinuationToolCall();
  }
  for (const [index, canonicalCall] of canonicalCalls.entries()) {
    const incomingCall = incomingCalls.at(index);
    if (
      incomingCall === undefined ||
      incomingCall.id !== canonicalCall.id ||
      !isPermittedContinuationToolCallTransition({
        canonicalCall,
        incomingCall,
      })
    ) {
      return invalidContinuationToolCall();
    }
  }

  const resumedInteraction = getResumedUserInteraction({
    parts: [...incomingParts],
    role: "assistant",
  });
  if (resumedInteraction === null) {
    return Result.ok();
  }
  const awaitedInteractions = getAwaitingUserInteractions({
    parts: [...persistedParts],
    role: "assistant",
  });
  const interaction = awaitedInteractions.find(
    (candidate) =>
      candidate.toolCallId === resumedInteraction.toolCallId &&
      candidate.type === resumedInteraction.type,
  );
  if (interaction === undefined) {
    return invalidContinuationToolCall();
  }
  return Result.ok();
};

const invalidContinuationToolCall = (): Result<never, HandlerError<400>> =>
  Result.err(
    new HandlerError({
      status: 400,
      message: "Chat continuation does not match its awaited interaction",
    }),
  );

const isPermittedContinuationToolCallTransition = ({
  canonicalCall,
  incomingCall,
}: {
  canonicalCall: ChatToolCallPart;
  incomingCall: ChatToolCallPart;
}): boolean => {
  let stateTransitionAllowed = false;
  for (const allowedState of CONTINUATION_TOOL_CALL_TRANSITIONS[
    canonicalCall.state
  ]) {
    if (allowedState === incomingCall.state) {
      stateTransitionAllowed = true;
      break;
    }
  }
  if (
    !stateTransitionAllowed ||
    incomingCall.name !== canonicalCall.name ||
    !deepEquals(incomingCall.arguments, canonicalCall.arguments) ||
    !deepEquals(incomingCall.input, canonicalCall.input)
  ) {
    return false;
  }

  if (incomingCall.state === canonicalCall.state) {
    return deepEquals(incomingCall, canonicalCall);
  }
  if (
    canonicalCall.state === "approval-requested" &&
    incomingCall.state === "approval-responded"
  ) {
    if (!("approval" in canonicalCall) || !("approval" in incomingCall)) {
      return false;
    }
    return (
      incomingCall.approval.id === canonicalCall.approval.id &&
      incomingCall.approval.needsApproval ===
        canonicalCall.approval.needsApproval &&
      canonicalCall.approval.approved === undefined &&
      typeof incomingCall.approval.approved === "boolean" &&
      deepEquals(incomingCall.output, canonicalCall.output)
    );
  }
  if (
    canonicalCall.state === "input-complete" &&
    (incomingCall.state === "complete" || incomingCall.state === "error")
  ) {
    const canonicalApproval =
      "approval" in canonicalCall ? canonicalCall.approval : undefined;
    const incomingApproval =
      "approval" in incomingCall ? incomingCall.approval : undefined;
    return deepEquals(incomingApproval, canonicalApproval);
  }
  return false;
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

  const docxEditPreferences = metadata["docxEditPreferences"];
  if (docxEditPreferences !== undefined) {
    const parsed = parseDocxEditPreferencesMetadata(docxEditPreferences);
    if (parsed === null) {
      return Result.err(invalidChatMetadataError());
    }
    validated.docxEditPreferences = parsed;
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

const parseDocxEditPreferencesMetadata = (
  value: unknown,
): ChatMessageMetadata["docxEditPreferences"] | null => {
  if (!isJsonRecord(value)) {
    return null;
  }

  const editApplyMode = value["editApplyMode"];
  const docxEditRepresentation = value["docxEditRepresentation"];
  if (
    editApplyMode !== undefined &&
    editApplyMode !== "manual" &&
    editApplyMode !== "auto"
  ) {
    return null;
  }
  if (
    docxEditRepresentation !== undefined &&
    docxEditRepresentation !== "tracked-changes" &&
    docxEditRepresentation !== "direct"
  ) {
    return null;
  }
  if (editApplyMode === undefined && docxEditRepresentation === undefined) {
    return null;
  }

  return {
    ...(editApplyMode === undefined ? {} : { editApplyMode }),
    ...(docxEditRepresentation === undefined ? {} : { docxEditRepresentation }),
  };
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
  metadata.activeDraftContext === undefined &&
  metadata.anonRestorations === undefined &&
  metadata.docxEditPreferences === undefined &&
  metadata.mentions === undefined &&
  metadata.serverProvenance === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.turnOutcome === undefined &&
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

  if (TOOL_CALL_OUTPUT_VALIDATION[part.state] === "error") {
    const errorOutputResult = validateToolCallErrorOutput(part);
    if (Result.isError(errorOutputResult)) {
      return Result.err(errorOutputResult.error);
    }
    return Result.ok({
      type: "error",
      name: part.name,
      error: errorOutputResult.value,
    });
  }

  if (part.output === undefined) {
    return Result.ok({
      type: "schema",
      name: part.name,
      output: { type: "absent" },
    });
  }

  const outputResult = validateToolPayload({
    payload: part.output,
    payloadName: "output",
    schema: tool.outputSchema,
    toolName: part.name,
  });
  if (Result.isError(outputResult)) {
    return Result.err(outputResult.error);
  }
  return Result.ok({
    type: "schema",
    name: part.name,
    output: { type: "present", value: outputResult.value },
  });
};

const validateToolCallErrorOutput = (
  part: ChatToolCallPart,
): Result<string | undefined, HandlerError<400>> => {
  const output: unknown = part.output;
  if (output === undefined) {
    return Result.ok(undefined);
  }
  if (
    typeof output !== "object" ||
    output === null ||
    !("error" in output) ||
    typeof output.error !== "string" ||
    output.error.length === 0
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Invalid chat tool call error output: ${part.id}`,
      }),
    );
  }
  return Result.ok(output.error);
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
  const validation = TOOL_RESULT_VALIDATION[part.state];
  if (validation === "incomplete") {
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

  if (validation === "error") {
    if (toolCall.type !== "error") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Chat tool result state does not match call: ${part.toolCallId}`,
        }),
      );
    }
    return validateToolErrorResult(part, toolCall.error);
  }

  if (toolCall.type !== "schema" || toolCall.output.type === "absent") {
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

  if (!deepEquals(outputResult.value, toolCall.output.value)) {
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
  toolCallError: string | undefined,
): Result<void, HandlerError<400>> => {
  const contentResult = parseToolResultContent(part.content);
  if (Result.isError(contentResult)) {
    return Result.err(contentResult.error);
  }

  if (
    !part.error ||
    (toolCallError !== undefined && toolCallError !== part.error)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Invalid chat tool error result: ${part.toolCallId}`,
      }),
    );
  }

  // TanStack currently emits two error-result encodings that can both return
  // on an assistant continuation: client-executed failures carry `null`
  // content plus `error`, while server-executed failures carry the same error
  // in both fields. Accept only those exact shapes so a persisted server error
  // can round-trip without widening the boundary to arbitrary content.
  if (contentResult.value === null) {
    return Result.ok();
  }
  if (
    typeof contentResult.value === "object" &&
    Object.keys(contentResult.value).length === 1 &&
    "error" in contentResult.value &&
    contentResult.value.error === part.error
  ) {
    return Result.ok();
  }

  return Result.err(
    new HandlerError({
      status: 400,
      message: `Invalid chat tool error result: ${part.toolCallId}`,
    }),
  );
};

const parseToolArguments = (
  value: string,
): Result<unknown, HandlerError<400>> => {
  const parsed = Result.try({
    try: () => parseJsonUnknown(value),
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
    try: () => parseJsonUnknown(content),
    catch: () => content,
  });
  if (Result.isError(parsed)) {
    return Result.ok(content);
  }
  return Result.ok(parsed.value);
};

const parseJsonUnknown = (value: string): unknown => JSON.parse(value);

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

  const normalizedParts: ChatPart[] = [];
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
