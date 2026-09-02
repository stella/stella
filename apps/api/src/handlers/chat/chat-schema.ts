import { isStandardSchema, parseWithStandardSchema } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import type { Static } from "elysia";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_RICH_PART_LIMITS,
  CHAT_RUN_MODE,
  CHAT_TURN_INTENT,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
  isSafeIdValue,
  parseResourceRef,
  resourceRef,
  RESOURCE_TYPE,
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
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { normalizeChatMessageHtml } from "@/api/lib/markdown/chat-message";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

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

export const activeFileSchema = t.Object(
  {
    entityId: tSafeId("entity"),
    fileFieldId: t.Optional(tSafeId("field")),
    fileName: t.String(),
    supportsDocxEdits: t.Optional(t.Boolean()),
    docxEditSnapshot: t.Optional(docxEditSnapshotSchema),
  },
  { additionalProperties: false },
);

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
 * the active-file one so `suggest_changes` operations target the same
 * block-id space; the Studio client converts queued operations into
 * in-document suggestions.
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
  /**
   * Which DOCX-edit review mode this turn uses; omitted means
   * `DEFAULT_CHAT_EDIT_APPLY_MODE`. Threaded into `getChatTools`, which
   * registers exactly one of `suggest_changes` (manual) /
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
      parts: partsResult.value,
      ...(metadata === undefined ? {} : { metadata }),
    });
    const toolValidationResult = validateToolCallParts({
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

const validateIncomingChatParts = ({
  message,
  persistedMessage,
  resume,
}: {
  message: RawIncomingMessage;
  persistedMessage: ValidateMessageInput["persistedMessage"];
  resume: AgUiResume | undefined;
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
      resume,
    });
    if (Result.isError(continuationIntegrityResult)) {
      return Result.err(continuationIntegrityResult.error);
    }
    return Result.ok(
      applyValidatedContinuationTransitions({
        incomingParts: validatedParts,
        persistedParts,
      }),
    );
  }
  return Result.ok(validatedParts);
};

const applyValidatedContinuationTransitions = ({
  incomingParts,
  persistedParts,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
}): ChatPart[] => {
  const incomingCalls = new Map(
    incomingParts.flatMap((part) =>
      part.type === "tool-call" ? [[part.id, part] as const] : [],
    ),
  );
  const transitionedCallIds = new Set<string>();
  const mergedParts = persistedParts.map((part) => {
    if (part.type !== "tool-call") {
      return part;
    }
    const incomingCall = incomingCalls.get(part.id);
    if (incomingCall === undefined) {
      return normalizeContinuationToolArguments({
        call: part,
        canonicalCall: part,
      });
    }
    if (incomingCall.state !== part.state) {
      transitionedCallIds.add(part.id);
    }
    return normalizeContinuationToolArguments({
      call: incomingCall,
      canonicalCall: part,
    });
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
 * A client continuation may supply the result of an awaited interaction, but
 * it must not change the canonical call that requested it. In particular, the
 * provider-visible name, arguments, and input remain server-authored.
 */
const validateContinuationToolCallIntegrity = ({
  incomingParts,
  persistedParts,
  resume,
}: {
  incomingParts: readonly ChatPart[];
  persistedParts: readonly ChatPart[];
  resume: AgUiResume | undefined;
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

  const awaitedInteractions = getAwaitingUserInteractions({
    parts: [...persistedParts],
    role: "assistant",
  });
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
    const resumedInteractions = incomingCalls.flatMap((call, index) => {
      const canonicalCall = canonicalCalls.at(index);
      if (canonicalCall === undefined || canonicalCall.state === call.state) {
        return [];
      }
      const resumed = getResumedUserInteraction({
        awaited: awaitedInteractions,
        message: { parts: [call], role: "assistant" },
      });
      return resumed === null ? [] : [{ call, interaction: resumed }];
    });
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
  return Result.ok();
};

const invalidContinuationToolCall = (): Result<never, HandlerError<400>> =>
  Result.err(
    new HandlerError({
      status: 400,
      message: "Chat continuation does not match its awaited interaction",
    }),
  );

const APPROVAL_RESPONSE_MUTABLE_TOOL_CALL_PROPERTIES = new Set([
  "approval",
  "state",
]);
const TOOL_OUTPUT_MUTABLE_TOOL_CALL_PROPERTIES = new Set(["output", "state"]);

// Persisted tool input uses durable IDs while provider-facing `arguments`
// retain model refs. A client snapshot rebuilds both fields from visible input;
// derive that second accepted representation from the server-owned input.
const toClientVisibleCanonicalToolCall = (
  canonicalCall: ChatToolCallPart,
): ChatToolCallPart => {
  if (canonicalCall.input === undefined) {
    return canonicalCall;
  }
  const argumentsText = JSON.stringify(canonicalCall.input);
  return typeof argumentsText === "string"
    ? { ...canonicalCall, arguments: argumentsText }
    : canonicalCall;
};

const normalizeContinuationToolArguments = ({
  call,
  canonicalCall,
}: {
  call: ChatToolCallPart;
  canonicalCall: ChatToolCallPart;
}): ChatToolCallPart => {
  const clientCanonicalCall = toClientVisibleCanonicalToolCall(canonicalCall);
  if (clientCanonicalCall === canonicalCall) {
    return call;
  }
  return {
    ...call,
    arguments: clientCanonicalCall.arguments,
  };
};

const hasOnlyPermittedToolCallChanges = ({
  canonicalCall,
  incomingCall,
  mutableProperties,
}: {
  canonicalCall: ChatToolCallPart;
  incomingCall: ChatToolCallPart;
  mutableProperties: ReadonlySet<string>;
}): boolean => {
  const immutableProperties = (call: ChatToolCallPart) =>
    Object.fromEntries(
      Object.entries(call).filter(([key]) => !mutableProperties.has(key)),
    );
  return deepEquals(
    immutableProperties(incomingCall),
    immutableProperties(canonicalCall),
  );
};

const isPermittedContinuationToolCallTransition = ({
  canonicalCall,
  incomingCall,
}: {
  canonicalCall: ChatToolCallPart;
  incomingCall: ChatToolCallPart;
}): boolean => {
  const clientCanonicalCall = toClientVisibleCanonicalToolCall(canonicalCall);
  let comparableCanonicalCall = canonicalCall;
  if (incomingCall.arguments !== canonicalCall.arguments) {
    if (incomingCall.arguments !== clientCanonicalCall.arguments) {
      return false;
    }
    comparableCanonicalCall = clientCanonicalCall;
  }
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
    !deepEquals(incomingCall.input, canonicalCall.input)
  ) {
    return false;
  }

  if (incomingCall.state === canonicalCall.state) {
    return deepEquals(incomingCall, comparableCanonicalCall);
  }
  if (
    canonicalCall.state === "approval-requested" &&
    incomingCall.state === "approval-responded"
  ) {
    if (!("approval" in canonicalCall) || !("approval" in incomingCall)) {
      return false;
    }
    return (
      hasOnlyPermittedToolCallChanges({
        canonicalCall: comparableCanonicalCall,
        incomingCall,
        mutableProperties: APPROVAL_RESPONSE_MUTABLE_TOOL_CALL_PROPERTIES,
      }) &&
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
    return hasOnlyPermittedToolCallChanges({
      canonicalCall: comparableCanonicalCall,
      incomingCall,
      mutableProperties: TOOL_OUTPUT_MUTABLE_TOOL_CALL_PROPERTIES,
    });
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
  message,
  tools,
}: {
  allowPartialInput?: boolean;
  message: ChatMessage;
  tools: ChatToolMap;
}): Result<ChatPart[], HandlerError<400>> => {
  const toolCallsById = new Map<string, ValidatedToolCallPart>();
  const parts: ChatPart[] = [];

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

    if (part.type !== "tool-result") {
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
