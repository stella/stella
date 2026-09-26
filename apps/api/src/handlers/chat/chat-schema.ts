import { isStandardSchema, parseWithStandardSchema } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import type { Static } from "elysia";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_RICH_PART_LIMITS,
  CHAT_RUN_MODE,
  CHAT_TURN_INTENT,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
  isSafeIdValue,
  parseResourceRef,
  resourceRef,
  RESOURCE_TYPE,
  type BrowserClientCapability,
  type ChatEditApplyMode,
  type ChatRunMode,
  type DocxEditRepresentation,
} from "@stll/api-contract";

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
  isChatPart,
  isIncomingChatPart,
  isChatTextPart,
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
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withNullsOmitted } from "@/api/lib/json-value";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

export {
  CHAT_EDIT_APPLY_MODE,
  CHAT_RUN_MODE,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
};
export type { ChatEditApplyMode, ChatRunMode, DocxEditRepresentation };

const rawMessageProperties = {
  id: tSafeId("chatMessage"),
  metadata: t.Optional(t.Unknown()),
  parts: t.Array(t.Unknown()),
};

const rawMessageSchema = t.Object(
  {
    ...rawMessageProperties,
    role: t.Union([
      t.Literal("system"),
      t.Literal("user"),
      t.Literal("assistant"),
    ]),
  },
  { additionalProperties: true },
);

const rawAssistantContinuationMessageSchema = t.Object(
  { ...rawMessageProperties, role: t.Literal("assistant") },
  { additionalProperties: true },
);

const userContextSchema = t.Object({
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
      /**
       * Folio's normalized text hash of the block at snapshot time. Shown to
       * the model so it can echo it as `precondition.blockTextHash` on a
       * `suggest_changes` operation, which makes an edit against a block that
       * changed since this snapshot skip instead of landing on the wrong text.
       */
      blockTextHash: t.Optional(t.String()),
    }),
  ),
});

/**
 * One active document the chat can be bound to.
 *
 * Closed, always: what each kind means is resolved server-side from the ids it
 * carries, so an unknown property is a client trying to tell the model
 * something the server never looked up — a fabricated email citation, wording
 * an act does not have. Going through this constructor is what makes a new
 * kind closed by construction instead of by remembering the option.
 */
const activeContextSchema = <TShape extends Parameters<typeof t.Object>[0]>(
  properties: TShape,
) => t.Object(properties, { additionalProperties: false });

export const activeFileSchema = activeContextSchema({
  entityId: tSafeId("entity"),
  fileFieldId: t.Optional(tSafeId("field")),
  fileName: t.String(),
  supportsDocxEdits: t.Optional(t.Boolean()),
  docxEditSnapshot: t.Optional(docxEditSnapshotSchema),
});

export const activeDraftSchema = activeContextSchema({
  originChatMessageId: tSafeId("chatMessage"),
  originChatThreadId: tSafeId("chatThread"),
  toolCallId: t.String(),
  fileName: t.String(),
  docxEditSnapshot: docxEditSnapshotSchema,
});

/**
 * Template Studio surface: the user is authoring a reusable DOCX
 * template (org-scoped, not a workspace entity). The snapshot mirrors
 * the active-file one so `suggest_changes` operations target the same
 * block-id space; the Studio client converts queued operations into
 * in-document suggestions.
 */
export const activeTemplateSchema = activeContextSchema({
  templateId: tSafeId("template"),
  fileName: t.String(),
  docxEditSnapshot: t.Optional(docxEditSnapshotSchema),
});

export const activeDecisionSchema = activeContextSchema({
  decisionId: tSafeId("caseLawDecision"),
});

/**
 * The statute consolidation open in the legal reader. Only the id travels:
 * the act's identity, its text and the reader's marks on it are resolved
 * server-side from the corpus, so a client cannot dictate what the model is
 * told an act says.
 */
export const activeStatuteSchema = activeContextSchema({
  documentId: tSafeId("legislationDocument"),
});

export const activeExternalSchema = activeContextSchema({
  connectorSlug: t.Optional(t.String()),
  provider: t.Optional(t.String()),
  snippet: t.Optional(t.String()),
  sourceToolName: t.Optional(t.String()),
  text: t.Optional(t.String()),
  title: t.String(),
  url: t.String(),
});

// Any version parses so a tab running an older or newer web build can still
// chat; `resolveBrowserClientCapability` decides whether the tool registers.
// `t.Integer` would also admit numeric strings, so this is a whole number.
const browserClientSchema = t.Object(
  {
    protocolVersion: t.Number({ minimum: 1, multipleOf: 1 }),
  },
  { additionalProperties: false },
);

/**
 * The browser tool is offered only to a client speaking this server's
 * extension protocol; another version chats without it.
 */
export const resolveBrowserClientCapability = (
  browserClient: Static<typeof browserClientSchema> | undefined,
): BrowserClientCapability | undefined =>
  browserClient?.protocolVersion === BROWSER_CONTROL_PROTOCOL_VERSION
    ? { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }
    : undefined;

export const activeSkillSchema = activeContextSchema({
  skillId: tSafeId("agentSkill"),
  skillName: t.String({ minLength: 1, maxLength: 64 }),
});

const agUiRunIdSchema = t.String({ minLength: 1, maxLength: 256 });
const agUiResumeSchema = t.Array(
  t.Union([
    t.Object(
      {
        interruptId: t.String({ minLength: 1, maxLength: 512 }),
        status: t.Literal("resolved"),
        // AG-UI intentionally defines resume payloads as application-owned JSON.
        payload: t.Optional(t.Unknown()),
      },
      { additionalProperties: false },
    ),
    t.Object(
      {
        interruptId: t.String({ minLength: 1, maxLength: 512 }),
        status: t.Literal("cancelled"),
      },
      { additionalProperties: false },
    ),
  ]),
  { minItems: 1, maxItems: 128 },
);

const sendMessageCommonProperties = {
  threadId: tSafeId("chatThread"),
  runId: agUiRunIdSchema,
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
   * Execution mode for this turn. Absent runs normal server-side chat;
   * `"agent"` explicitly requests the configured agent sandbox.
   */
  runMode: t.Optional(t.Literal(CHAT_RUN_MODE.agent)),
  userContext: t.Optional(userContextSchema),
  activeDraft: t.Optional(activeDraftSchema),
  activeFile: t.Optional(activeFileSchema),
  activeTemplate: t.Optional(activeTemplateSchema),
  activeDecision: t.Optional(activeDecisionSchema),
  activeExternal: t.Optional(activeExternalSchema),
  activeSkill: t.Optional(activeSkillSchema),
  activeStatute: t.Optional(activeStatuteSchema),
  browserClient: t.Optional(browserClientSchema),
  /**
   * Which DOCX-edit review mode this turn uses; omitted means
   * `DEFAULT_CHAT_EDIT_APPLY_MODE`. Threaded into `getChatTools`, which
   * registers exactly one `suggest_changes` variant accordingly: the
   * client-executed queue (manual) or the server-executed apply (auto).
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
};

const noResumeBodySchema = t.Object(
  {
    ...sendMessageCommonProperties,
    message: rawMessageSchema,
  },
  { additionalProperties: false },
);

const nativeAssistantContinuationBodySchema = t.Object(
  {
    ...sendMessageCommonProperties,
    message: rawAssistantContinuationMessageSchema,
    parentRunId: agUiRunIdSchema,
    resume: agUiResumeSchema,
  },
  { additionalProperties: false },
);

export const sendMessageBodySchema = t.Union([
  noResumeBodySchema,
  nativeAssistantContinuationBodySchema,
]);

export type ChatSendRequest = Static<typeof sendMessageBodySchema>;

const agUiMessageEnvelopeSchema = t.Object(
  {
    id: t.String({ minLength: 1, maxLength: 512 }),
    role: t.Union([
      t.Literal("developer"),
      t.Literal("system"),
      t.Literal("assistant"),
      t.Literal("user"),
      t.Literal("tool"),
      t.Literal("activity"),
      t.Literal("reasoning"),
    ]),
  },
  {
    // Message bodies are the upstream AG-UI discriminated union plus
    // TanStack's `parts` extension. Stella does not consume this mirrored
    // history: `forwardedProps.message` below is the strict mutation input.
    additionalProperties: true,
  },
);

/**
 * Canonical AG-UI RunAgentInput envelope emitted by TanStack's connection
 * adapter. Stella-specific, strictly validated inputs live in forwardedProps;
 * correlation and resume fields stay protocol-native at the top level.
 */
const agUiEnvelopeCommonProperties = {
  threadId: tSafeId("chatThread"),
  runId: agUiRunIdSchema,
  state: t.Object({}, { additionalProperties: true }),
  messages: t.Array(agUiMessageEnvelopeSchema, { maxItems: 4096 }),
  tools: t.Array(
    t.Object(
      {
        name: t.String({ minLength: 1, maxLength: 512 }),
        description: t.String({ maxLength: 16_384 }),
        parameters: t.Optional(t.Unknown()),
        metadata: t.Optional(t.Record(t.String(), t.Unknown())),
      },
      { additionalProperties: false },
    ),
    { maxItems: 512 },
  ),
  context: t.Array(
    t.Object(
      {
        description: t.String({ maxLength: 16_384 }),
        value: t.String({ maxLength: 1_000_000 }),
      },
      { additionalProperties: false },
    ),
    { maxItems: 512 },
  ),
};

export const agUiSendMessageBodySchema = t.Union([
  t.Object(
    {
      ...agUiEnvelopeCommonProperties,
      forwardedProps: noResumeBodySchema,
      // TanStack mirrors forwardedProps under legacy `data`; validating both
      // prevents an untyped shadow payload from crossing the route boundary.
      data: noResumeBodySchema,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      ...agUiEnvelopeCommonProperties,
      forwardedProps: nativeAssistantContinuationBodySchema,
      data: nativeAssistantContinuationBodySchema,
      parentRunId: agUiRunIdSchema,
      resume: agUiResumeSchema,
    },
    { additionalProperties: false },
  ),
]);

type RawIncomingMessage = Static<typeof rawMessageSchema>;
type AgUiResume = Static<typeof agUiResumeSchema>;
export type IncomingUserContext = Static<typeof userContextSchema>;
export type IncomingActiveFile = Static<typeof activeFileSchema>;
export type IncomingActiveDraft = Static<typeof activeDraftSchema>;
export type IncomingActiveTemplate = Static<typeof activeTemplateSchema>;
export type IncomingActiveDecision = Static<typeof activeDecisionSchema>;
export type IncomingActiveExternal = Static<typeof activeExternalSchema>;
export type IncomingActiveSkill = Static<typeof activeSkillSchema>;
export type IncomingActiveStatute = Static<typeof activeStatuteSchema>;

/**
 * Every active document a turn may carry, by the body field that carries it.
 *
 * The send body below is the source of truth; this map is held equal to its
 * `active*` fields at compile time, so a new active document is a type error
 * here until it is declared, and the schema test enumerates this map rather
 * than a hand-written list that could go stale.
 */
export const ACTIVE_CONTEXT_SCHEMAS = {
  activeDecision: activeDecisionSchema,
  activeDraft: activeDraftSchema,
  activeExternal: activeExternalSchema,
  activeFile: activeFileSchema,
  activeSkill: activeSkillSchema,
  activeStatute: activeStatuteSchema,
  activeTemplate: activeTemplateSchema,
} as const;

type ActiveContextBodyKey = Extract<
  keyof typeof sendMessageCommonProperties,
  `active${string}`
>;

type UndeclaredActiveContextKey = Exclude<
  ActiveContextBodyKey,
  keyof typeof ACTIVE_CONTEXT_SCHEMAS
>;
type UnusedActiveContextSchema = Exclude<
  keyof typeof ACTIVE_CONTEXT_SCHEMAS,
  ActiveContextBodyKey
>;

true satisfies UndeclaredActiveContextKey extends never ? true : never;
true satisfies UnusedActiveContextSchema extends never ? true : never;

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
  resume?: AgUiResume | undefined;
};

type ValidateMessageResult = Result<
  {
    message: PersistableChatMessage;
    storedFileRefs: StoredFileRef[];
  },
  HandlerError<400 | 403 | 404> | SafeDbError
>;

type ChatToolCallPart = Extract<ChatPart, { type: "tool-call" }>;
type ChatToolResultPart = Extract<ChatPart, { type: "tool-result" }>;
type PersistedToolCallPart = Extract<
  PersistedChatMessageContentV3["data"][number],
  { type: "tool-call" }
>;
type DistributiveKeyof<T> = T extends unknown ? keyof T : never;
type ContinuationToolCallProperty = DistributiveKeyof<
  ChatToolCallPart | PersistedToolCallPart
>;
const CONTINUATION_TOOL_CALL_PROPERTY_DISPOSITION = {
  approval: "state-specific",
  arguments: "state-independent",
  id: "state-independent",
  input: "state-independent",
  metadata: "state-independent",
  name: "state-independent",
  output: "state-specific",
  state: "state-specific",
  type: "state-independent",
} as const satisfies Record<
  ContinuationToolCallProperty,
  "state-independent" | "state-specific"
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
      part: ChatToolCallPart;
    }
  | {
      type: "schema";
      name: string;
      output: { type: "absent" } | { type: "present"; value: unknown };
      part: ChatToolCallPart;
    };

type ValidatedToolPayload =
  | { type: "input-only"; input: unknown }
  | { type: "input-output"; input: unknown; output: unknown };

const withValidatedToolPayload = ({
  part,
  payload,
}: {
  part: ChatToolCallPart;
  payload: ValidatedToolPayload;
}): ChatToolCallPart => {
  const candidate: unknown =
    payload.type === "input-only"
      ? { ...part, input: payload.input }
      : { ...part, input: payload.input, output: payload.output };
  if (!isChatPart(candidate) || candidate.type !== "tool-call") {
    panic("Validated chat tool payload violates the tool-call contract");
  }
  return candidate;
};

export const validateMessage = async ({
  message,
  persistedMessage,
  resume,
  safeDb,
  threadId,
  tools,
  userId,
}: ValidateMessageInput): Promise<ValidateMessageResult> =>
  await Result.gen(async function* () {
    const partsResult = validateIncomingChatParts({
      message,
      persistedMessage,
      resume,
    });
    if (Result.isError(partsResult)) {
      return Result.err(partsResult.error);
    }

    const metadataResult = validateIncomingChatMetadata(message.metadata);
    if (Result.isError(metadataResult)) {
      return Result.err(metadataResult.error);
    }

    const metadata = resolveValidatedChatMetadata({
      incomingMetadata: metadataResult.value,
      message,
      persistedMessage,
    });

    const candidateMessage = toPersistableChatMessage({
      id: message.id,
      role: message.role,
      parts: partsResult.value.parts,
      ...(metadata === undefined ? {} : { metadata }),
    });
    const toolValidationResult = validateToolCallParts({
      clientAuthoredCallIds: partsResult.value.clientAuthoredCallIds,
      message: candidateMessage,
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

    const validatedMessage = toPersistableChatMessage({
      ...candidateMessage,
      parts: toolValidationResult.value,
    });

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

const resolveValidatedChatMetadata = ({
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

  return chatMessageFromPersisted({
    id: message.id,
    role: persistedMessage.role,
    content: persistedMessage.content,
  }).metadata;
};

/**
 * `clientAuthoredCallIds` names the tool calls whose content the client
 * contributed to. On a continuation that is only the awaited calls it answered:
 * every other part is the server's own persisted copy, valid against the tool
 * set of the run that wrote it, and is not judged against this request's. Which
 * tools a request registers depends on state that moves between two requests
 * (installed skills, feature flags, roles, connectors, composer mode), so
 * re-judging history would reject the server's own turn. `undefined` means the
 * whole message is client-authored.
 */
type ValidatedIncomingChatParts = {
  clientAuthoredCallIds: ReadonlySet<string> | undefined;
  parts: ChatPart[];
};

const validateIncomingChatParts = ({
  message,
  persistedMessage,
  resume,
}: {
  message: RawIncomingMessage;
  persistedMessage: ValidateMessageInput["persistedMessage"];
  resume: AgUiResume | undefined;
}): Result<ValidatedIncomingChatParts, HandlerError<400>> => {
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
    const continuationResult = validateContinuationToolCallIntegrity({
      incomingParts: validatedParts,
      persistedParts,
      resume,
    });
    if (Result.isError(continuationResult)) {
      return Result.err(continuationResult.error);
    }
    const clientAuthoredCallIds = new Set<string>();
    for (const [callId, validatedCall] of continuationResult.value) {
      if (validatedCall.type === "transitioned") {
        clientAuthoredCallIds.add(callId);
      }
    }
    return Result.ok({
      clientAuthoredCallIds,
      parts: applyValidatedContinuationTransitions({
        incomingParts: validatedParts,
        persistedParts,
        validatedCallsById: continuationResult.value,
      }),
    });
  }
  return Result.ok({ clientAuthoredCallIds: undefined, parts: validatedParts });
};

const applyValidatedContinuationTransitions = ({
  incomingParts,
  persistedParts,
  validatedCallsById,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
  validatedCallsById: ReadonlyMap<string, ValidatedContinuationToolCall>;
}): ChatPart[] => {
  const transitionedCallIds = new Set<string>();
  const mergedParts = persistedParts.map((part) => {
    if (part.type !== "tool-call") {
      return part;
    }
    const validatedCall = validatedCallsById.get(part.id);
    if (validatedCall === undefined) {
      return canonicalizeToolCall(part);
    }
    if (validatedCall.type === "transitioned") {
      transitionedCallIds.add(part.id);
    }
    return validatedCall.call;
  });
  const resultCallIds = new Set(
    persistedParts.flatMap((part) =>
      part.type === "tool-result" ? [part.toolCallId] : [],
    ),
  );

  for (const part of incomingParts) {
    if (
      part.type !== "tool-result" ||
      resultCallIds.has(part.toolCallId) ||
      !transitionedCallIds.has(part.toolCallId)
    ) {
      continue;
    }
    const callIndex = mergedParts.findIndex(
      (candidate) =>
        candidate.type === "tool-call" && candidate.id === part.toolCallId,
    );
    if (callIndex === -1) {
      continue;
    }
    mergedParts.splice(callIndex + 1, 0, {
      type: "tool-result",
      toolCallId: part.toolCallId,
      content: part.content,
      state: part.state,
      ...(part.error === undefined ? {} : { error: part.error }),
    });
    resultCallIds.add(part.toolCallId);
  }

  return mergedParts;
};

/**
 * A client continuation may supply the result of an awaited interaction, but it
 * must not change which call was made or with what input: id, name, and input
 * value stay server-authored, and only output, state, and the approval response
 * may move.
 *
 * How the input is spelled is not part of that property. The persisted v3 part
 * keeps only the adapter-normalized input and recomputes `arguments` from it,
 * while the client echoes the raw provider text, which strict tool schemas widen
 * with nulls for absent optionals. Both are the same call, so `input` is
 * compared by value with that null-widening folded on both sides, and the server
 * copy is restored onto the accepted call.
 */
type ValidatedContinuationToolCall =
  | { type: "transitioned"; call: ChatToolCallPart }
  | { type: "unchanged"; call: ChatToolCallPart };

const validateContinuationToolCallIntegrity = ({
  incomingParts,
  persistedParts,
  resume,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
  resume: AgUiResume | undefined;
}): Result<
  ReadonlyMap<string, ValidatedContinuationToolCall>,
  HandlerError<400>
> => {
  const canonicalCalls = persistedParts.filter(
    (part): part is ChatToolCallPart => part.type === "tool-call",
  );
  const incomingCalls = incomingParts.filter(
    (part): part is ChatToolCallPart => part.type === "tool-call",
  );
  const canonicalCallsById = new Map(
    canonicalCalls.map((call) => [call.id, call] as const),
  );
  const incomingCallsById = new Map<string, ChatToolCallPart>();
  const validatedCallsById = new Map<string, ValidatedContinuationToolCall>();
  for (const incomingCall of incomingCalls) {
    const canonicalCall = canonicalCallsById.get(incomingCall.id);
    if (canonicalCall === undefined || incomingCallsById.has(incomingCall.id)) {
      return invalidContinuationToolCall();
    }
    incomingCallsById.set(incomingCall.id, incomingCall);

    const validatedCallResult = validateContinuationToolCallTransition({
      canonicalCall,
      incomingCall,
    });
    if (Result.isError(validatedCallResult)) {
      return Result.err(validatedCallResult.error);
    }
    validatedCallsById.set(incomingCall.id, validatedCallResult.value);
  }

  const awaitedInteractions = getAwaitingUserInteractions({
    parts: [...persistedParts],
    role: "assistant",
  });
  if (
    awaitedInteractions.some(
      ({ toolCallId }) => !incomingCallsById.has(toolCallId),
    )
  ) {
    return invalidContinuationToolCall();
  }
  if (resume !== undefined) {
    const awaitedInterrupts: {
      interaction: (typeof awaitedInteractions)[number];
      interruptId: string;
    }[] = [];
    for (const awaited of awaitedInteractions) {
      const call = canonicalCalls.find(
        (candidate) => candidate.id === awaited.toolCallId,
      );
      if (call === undefined) {
        continue;
      }
      if (awaited.type === "approval") {
        if (!("approval" in call)) {
          continue;
        }
        awaitedInterrupts.push({
          interaction: awaited,
          interruptId: call.approval.id,
        });
        continue;
      }
      awaitedInterrupts.push({
        interaction: awaited,
        interruptId: `client_tool_${call.id}`,
      });
    }
    const resumedInteractions = [...validatedCallsById.values()].flatMap(
      (validatedCall) => {
        if (validatedCall.type === "unchanged") {
          return [];
        }
        const resumed = getResumedUserInteraction({
          awaited: awaitedInteractions,
          message: { parts: [validatedCall.call], role: "assistant" },
        });
        return resumed === null
          ? []
          : [{ call: validatedCall.call, interaction: resumed }];
      },
    );
    if (
      awaitedInterrupts.length !== awaitedInteractions.length ||
      resume.length !== awaitedInterrupts.length ||
      resume.some((resolution) => {
        const awaited = awaitedInterrupts.find(
          (candidate) => candidate.interruptId === resolution.interruptId,
        );
        if (awaited === undefined) {
          return true;
        }
        const transition = resumedInteractions.find(
          ({ interaction }) =>
            interaction.toolCallId === awaited.interaction.toolCallId &&
            interaction.type === awaited.interaction.type,
        );
        if (resolution.status === "cancelled") {
          return transition !== undefined;
        }
        if (transition === undefined) {
          return true;
        }
        if (awaited.interaction.type === "approval") {
          return (
            !("approval" in transition.call) ||
            !deepEquals(resolution.payload, {
              approved: transition.call.approval.approved,
            })
          );
        }
        return !deepEquals(resolution.payload, transition.call.output);
      })
    ) {
      return invalidContinuationToolCall();
    }
  }
  return Result.ok(validatedCallsById);
};

const invalidContinuationToolCall = (): Result<never, HandlerError<400>> =>
  Result.err(
    new HandlerError({
      code: CHAT_CONTINUATION_REJECTED_ERROR_CODE,
      status: 400,
      message: "Chat continuation does not match its awaited interaction",
    }),
  );

/**
 * The persisted call is the base of every continuation. This is intentionally
 * a positive projection: a client can contribute only the response fields
 * copied by `validateContinuationToolCallTransition`. New SDK or persistence fields
 * therefore remain server-owned without another denylist entry.
 */
const canonicalizeToolCall = (
  canonicalCall: ChatToolCallPart,
): ChatToolCallPart => {
  const input = canonicalCall.input;
  const argumentsText =
    input === undefined ? undefined : JSON.stringify(canonicalCall.input);
  const candidate: unknown = {
    ...canonicalCall,
    arguments:
      typeof argumentsText === "string"
        ? argumentsText
        : canonicalCall.arguments,
    input,
  };
  if (!isChatPart(candidate) || candidate.type !== "tool-call") {
    panic("Canonical chat tool call violates the tool-call contract");
  }
  return candidate;
};

const canonicalToolCallBase = (
  canonicalCall: ChatToolCallPart,
): Record<string, unknown> => {
  const canonicalValue: unknown = canonicalCall;
  if (!isRecord(canonicalValue)) {
    panic("Canonical chat tool call is not an object");
  }
  const base: Record<string, unknown> = {};
  for (const [property, disposition] of Object.entries(
    CONTINUATION_TOOL_CALL_PROPERTY_DISPOSITION,
  )) {
    if (
      disposition === "state-independent" &&
      Object.hasOwn(canonicalValue, property)
    ) {
      base[property] = canonicalValue[property];
    }
  }
  const input: unknown = canonicalCall.input;
  const argumentsText =
    input === undefined ? undefined : JSON.stringify(canonicalCall.input);
  return {
    ...base,
    arguments:
      typeof argumentsText === "string"
        ? argumentsText
        : canonicalCall.arguments,
    input,
  };
};

const validateContinuationToolCallTransition = ({
  canonicalCall,
  incomingCall,
}: {
  canonicalCall: ChatToolCallPart;
  incomingCall: ChatToolCallPart;
}): Result<ValidatedContinuationToolCall, HandlerError<400>> => {
  if (incomingCall.state === canonicalCall.state) {
    return Result.ok({
      type: "unchanged",
      call: canonicalizeToolCall(canonicalCall),
    });
  }
  if (
    incomingCall.name !== canonicalCall.name ||
    !deepEquals(
      withNullsOmitted(incomingCall.input),
      withNullsOmitted(canonicalCall.input),
    )
  ) {
    return invalidContinuationToolCall();
  }
  const canonicalBase = canonicalToolCallBase(canonicalCall);

  switch (canonicalCall.state) {
    case "approval-requested": {
      if (
        incomingCall.state !== "approval-responded" ||
        !("approval" in canonicalCall) ||
        !("approval" in incomingCall) ||
        incomingCall.approval.id !== canonicalCall.approval.id ||
        incomingCall.approval.needsApproval !==
          canonicalCall.approval.needsApproval ||
        canonicalCall.approval.approved !== undefined ||
        typeof incomingCall.approval.approved !== "boolean" ||
        !deepEquals(incomingCall.output, canonicalCall.output)
      ) {
        return invalidContinuationToolCall();
      }
      const output: unknown = canonicalCall.output;
      const candidate: unknown = {
        ...canonicalBase,
        approval: {
          approved: incomingCall.approval.approved,
          id: canonicalCall.approval.id,
          needsApproval: canonicalCall.approval.needsApproval,
        },
        ...(output === undefined ? {} : { output }),
        state: incomingCall.state,
      };
      if (!isChatPart(candidate) || candidate.type !== "tool-call") {
        panic("Validated chat tool call violates the tool-call contract");
      }
      return Result.ok({ type: "transitioned", call: candidate });
    }
    case "input-complete": {
      if (incomingCall.state !== "complete" && incomingCall.state !== "error") {
        return invalidContinuationToolCall();
      }
      const output: unknown = incomingCall.output;
      const candidate: unknown = {
        ...canonicalBase,
        output,
        state: incomingCall.state,
      };
      if (!isChatPart(candidate) || candidate.type !== "tool-call") {
        panic("Validated chat tool call violates the tool-call contract");
      }
      return Result.ok({ type: "transitioned", call: candidate });
    }
    case "approval-responded":
    case "awaiting-input":
    case "complete":
    case "error":
    case "input-streaming":
      return invalidContinuationToolCall();
    default:
      canonicalCall.state satisfies never;
      return panic(`Unhandled tool-call state: ${String(canonicalCall.state)}`);
  }
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

const isSafeIdInput = (value: unknown): value is string =>
  typeof value === "string" && isSafeIdValue(value);

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
  if (
    !isJsonRecord(value) ||
    !Array.isArray(value["mentions"]) ||
    value["mentions"].length > CHAT_RICH_PART_LIMITS.mentionsMax
  ) {
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
      !isSafeIdInput(id) ||
      typeof label !== "string" ||
      (category !== "entity" && category !== "workspace")
    ) {
      return null;
    }
    if (category === "workspace") {
      const resourceValue = mention["resource"];
      const parsedResource = parseResourceRef(resourceValue);
      if (
        (resourceValue !== undefined && parsedResource === null) ||
        (parsedResource !== null &&
          (parsedResource.type !== RESOURCE_TYPE.WORKSPACE ||
            parsedResource.id !== id))
      ) {
        return null;
      }
      mentions.push({
        category,
        id,
        label,
        resource:
          parsedResource ??
          resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: brandPersistedWorkspaceId(id),
          }),
      });
      continue;
    }
    const workspaceId = mention["workspaceId"];
    if (workspaceId !== null && !isSafeIdInput(workspaceId)) {
      return null;
    }
    const resourceValue = mention["resource"];
    const parsedResource = parseResourceRef(resourceValue);
    if (
      (resourceValue !== undefined && parsedResource === null) ||
      (parsedResource !== null &&
        (parsedResource.type !== RESOURCE_TYPE.ENTITY ||
          parsedResource.id !== id))
    ) {
      return null;
    }
    mentions.push({
      category,
      id,
      label,
      resource:
        parsedResource ??
        resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: brandPersistedEntityId(id),
        }),
      workspaceId,
    });
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
  metadata.refContext === undefined &&
  metadata.refEncoding === undefined &&
  metadata.serverProvenance === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.turnOutcome === undefined &&
  metadata.usage === undefined;

export const validateToolCallParts = ({
  allowPartialInput = false,
  clientAuthoredCallIds,
  message,
  tools,
}: {
  allowPartialInput?: boolean;
  /** See `ValidatedIncomingChatParts`; `undefined` validates every call. */
  clientAuthoredCallIds?: ReadonlySet<string> | undefined;
  message: ChatMessage;
  tools: ChatToolMap;
}): Result<ChatPart[], HandlerError<400>> => {
  const toolCallsById = new Map<string, ValidatedToolCallPart>();
  const serverAuthoredCallIds = new Set<string>();
  const parts: ChatPart[] = [];

  for (const part of message.parts) {
    if (part.type === "tool-call") {
      if (toolCallsById.has(part.id) || serverAuthoredCallIds.has(part.id)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `Duplicate chat tool call id: ${part.id}`,
          }),
        );
      }

      if (
        clientAuthoredCallIds !== undefined &&
        !clientAuthoredCallIds.has(part.id)
      ) {
        serverAuthoredCallIds.add(part.id);
        parts.push(part);
        continue;
      }

      const toolCallResult = validateToolCallPart({
        allowPartialInput,
        part,
        tools,
      });
      if (Result.isError(toolCallResult)) {
        return Result.err(toolCallResult.error);
      }

      toolCallsById.set(part.id, toolCallResult.value);
      parts.push(toolCallResult.value.part);
      continue;
    }

    if (
      part.type !== "tool-result" ||
      serverAuthoredCallIds.has(part.toolCallId)
    ) {
      parts.push(part);
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
    parts.push(part);
  }
  return Result.ok(parts);
};

const validateToolCallPart = ({
  allowPartialInput,
  part,
  tools,
}: {
  allowPartialInput: boolean;
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

  if (
    allowPartialInput &&
    (part.state === "awaiting-input" || part.state === "input-streaming")
  ) {
    return Result.ok({
      type: "schema",
      name: part.name,
      output: { type: "absent" },
      part,
    });
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
      part: withValidatedToolPayload({
        part,
        payload:
          errorOutputResult.value === undefined
            ? { type: "input-only", input: validatedArgumentsResult.value }
            : {
                type: "input-output",
                input: validatedArgumentsResult.value,
                output: { error: errorOutputResult.value },
              },
      }),
    });
  }

  if (part.output === undefined) {
    return Result.ok({
      type: "schema",
      name: part.name,
      output: { type: "absent" },
      part: withValidatedToolPayload({
        part,
        payload: { type: "input-only", input: validatedArgumentsResult.value },
      }),
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
    part: withValidatedToolPayload({
      part,
      payload: {
        type: "input-output",
        input: validatedArgumentsResult.value,
        output: outputResult.value,
      },
    }),
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
  schema: unknown;
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

      const remainingMentionCapacity =
        CHAT_RICH_PART_LIMITS.mentionsMax - mentions.length;
      if (remainingMentionCapacity > 0) {
        mentions.push(
          ...normalizedText.mentions.slice(0, remainingMentionCapacity),
        );
      }
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
