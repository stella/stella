import {
  convertSchemaToJsonSchema,
  isStandardSchema,
  parseWithStandardSchema,
} from "@tanstack/ai";
import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserClientCapability,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_EDIT_APPLY_MODE,
  CHAT_RICH_PART_LIMITS,
  CHAT_RUN_MODE,
  CHAT_TURN_INTENT,
  type ChatEditApplyMode,
  type ChatRunMode,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
  type DocxEditRepresentation,
  isSafeIdValue,
  parseResourceRef,
  RESOURCE_TYPE,
  resourceRef,
} from "@stll/api-contract";
import {
  isChatPastedTextPart,
  isServerChatToolCall,
} from "@stll/api-contract/chat";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { StoredFileRef } from "@/api/handlers/chat/attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "@/api/handlers/chat/attachment-validation";
import {
  chatMessageFromPersisted,
  continueStoredChatPart,
  getAwaitingUserInteractions,
  getResumedUserInteraction,
  hasServerOwnedChatPartType,
  isApprovedClientCallAwaitingResult,
  isChatPart,
  isChatTextPart,
  isIncomingChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { validatePrivateReceipts } from "@/api/handlers/chat/chat-secret-validation";
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
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatTool,
  type ChatToolMap,
  registeredChatTool,
} from "@/api/lib/chat/chat-tool-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withModelPlaceholdersOmitted } from "@/api/lib/json-schema/null-optionals";
import { withNullsOmitted } from "@/api/lib/json-value";
import { LIMITS } from "@/api/lib/limits";
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
  id: resourceIdSchema("chatMessage"),
  metadata: v.exactOptional(v.unknown()),
  parts: v.array(v.unknown()),
};

const rawMessageSchema = v.looseObject({
  ...rawMessageProperties,
  role: v.picklist(["system", "user", "assistant"]),
});

const rawAssistantContinuationMessageSchema = v.looseObject({
  ...rawMessageProperties,
  role: v.literal("assistant"),
});

const boundedText = (maxChars: number) =>
  v.pipe(v.string(), v.maxLength(maxChars));

const userContextSchema = v.object({
  userName: boundedText(256),
  // A BCP 47 tag and an IANA zone name.
  locale: boundedText(35),
  timezone: boundedText(64),
  wordEditAuthorName: v.exactOptional(boundedText(256)),
  wordEditShortcut: v.exactOptional(boundedText(64)),
});

const docxEditSnapshotSchema = v.object({
  canApplyEdits: v.exactOptional(v.boolean()),
  blocks: v.pipe(
    v.array(
      v.object({
        id: boundedText(128),
        kind: v.picklist(["heading", "listItem", "paragraph"]),
        text: boundedText(LIMITS.chatDocxSnapshotBlockTextMaxChars),
        displayLabel: v.exactOptional(boundedText(256)),
        styleId: v.exactOptional(boundedText(256)),
        blockTextHash: v.exactOptional(boundedText(128)),
      }),
    ),
    v.maxLength(LIMITS.chatDocxSnapshotBlocksMax),
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
const activeContextSchema = <TShape extends v.ObjectEntries>(
  properties: TShape,
) => v.strictObject(properties);

export const activeFileSchema = activeContextSchema({
  entityId: resourceIdSchema("entity"),
  fileFieldId: v.exactOptional(resourceIdSchema("field")),
  fileName: v.string(),
  supportsDocxEdits: v.exactOptional(v.boolean()),
  docxEditSnapshot: v.exactOptional(docxEditSnapshotSchema),
});

export const activeDraftSchema = activeContextSchema({
  originChatMessageId: resourceIdSchema("chatMessage"),
  originChatThreadId: resourceIdSchema("chatThread"),
  toolCallId: v.string(),
  fileName: v.string(),
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
  templateId: resourceIdSchema("template"),
  fileName: v.string(),
  docxEditSnapshot: v.exactOptional(docxEditSnapshotSchema),
});

export const activeDecisionSchema = activeContextSchema({
  decisionId: resourceIdSchema("caseLawDecision"),
});

/**
 * The statute consolidation open in the legal reader. Only the id travels:
 * the act's identity, its text and the reader's marks on it are resolved
 * server-side from the corpus, so a client cannot dictate what the model is
 * told an act says.
 */
export const activeStatuteSchema = activeContextSchema({
  documentId: resourceIdSchema("legislationDocument"),
});

export const activeExternalSchema = activeContextSchema({
  connectorSlug: v.exactOptional(v.string()),
  provider: v.exactOptional(v.string()),
  snippet: v.exactOptional(v.string()),
  sourceToolName: v.exactOptional(v.string()),
  text: v.exactOptional(v.string()),
  title: v.string(),
  url: v.string(),
});

// Any version parses so a tab running an older or newer web build can still
// chat; `resolveBrowserClientCapability` decides whether the tool registers.
// A JSON number that is whole, not a numeric string.
const browserClientSchema = v.strictObject({
  protocolVersion: v.pipe(v.number(), v.minValue(1), v.multipleOf(1)),
});

/**
 * The browser tool is offered only to a client speaking this server's
 * extension protocol; another version chats without it.
 */
export const resolveBrowserClientCapability = (
  browserClient: v.InferOutput<typeof browserClientSchema> | undefined,
): BrowserClientCapability | undefined =>
  browserClient?.protocolVersion === BROWSER_CONTROL_PROTOCOL_VERSION
    ? { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }
    : undefined;

export const activeSkillSchema = activeContextSchema({
  // A built-in skill has no row: `skillName` alone names it.
  skillId: v.exactOptional(resourceIdSchema("agentSkill")),
  skillName: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});

const agUiRunIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const agUiResumeSchema = v.pipe(
  v.array(
    v.union([
      v.strictObject({
        interruptId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        status: v.literal("resolved"),
        payload: v.exactOptional(v.unknown()),
      }),
      v.strictObject({
        interruptId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        status: v.literal("cancelled"),
      }),
    ]),
  ),
  v.minLength(1),
  v.maxLength(128),
);

const sendMessageCommonProperties = {
  threadId: resourceIdSchema("chatThread"),
  runId: agUiRunIdSchema,
  workspaceId: v.exactOptional(resourceIdSchema("workspace")),
  sendMode: v.union([
    v.literal(CHAT_SEND_MODE.anonymized),
    v.literal(CHAT_SEND_MODE.rawOverride),
  ]),
  /**
   * Matters the chat draws context from. Empty (or omitted) means
   * "no matters pinned" — the AI discovers matters lazily via the
   * readonly read API. Non-empty narrows tool authorization so
   * requested matterRefs must be a subset of this set. The set is
   * persisted on the chat thread so subsequent turns reuse it
   * without re-sending.
   */
  contextMatterIds: v.exactOptional(v.array(resourceIdSchema("workspace"))),
  truncateAfterMessageId: v.exactOptional(resourceIdSchema("chatMessage")),
  turnIntent: v.exactOptional(v.literal(CHAT_TURN_INTENT.regenerate)),
  /**
   * Optional named tool scope for this turn. Only server-defined
   * scope names validate; the server maps the name to a fixed tool
   * allowlist (see `tools/tool-scope.ts`), so a client can narrow
   * but never widen the turn's tool surface.
   */
  toolScope: v.exactOptional(v.literal(CHAT_TOOL_SCOPE.suggestTemplateFields)),
  /**
   * Execution mode for this turn. Absent runs normal server-side chat;
   * `"agent"` explicitly requests the configured agent sandbox.
   */
  runMode: v.exactOptional(v.literal(CHAT_RUN_MODE.agent)),
  userContext: v.exactOptional(userContextSchema),
  activeDraft: v.exactOptional(activeDraftSchema),
  activeFile: v.exactOptional(activeFileSchema),
  activeTemplate: v.exactOptional(activeTemplateSchema),
  activeDecision: v.exactOptional(activeDecisionSchema),
  activeExternal: v.exactOptional(activeExternalSchema),
  activeSkill: v.exactOptional(activeSkillSchema),
  activeStatute: v.exactOptional(activeStatuteSchema),
  browserClient: v.exactOptional(browserClientSchema),
  /**
   * Which DOCX-edit review mode this turn uses; omitted means
   * `DEFAULT_CHAT_EDIT_APPLY_MODE`. Threaded into `getChatTools`, which
   * registers exactly one `suggest_changes` variant accordingly: the
   * client-executed queue (manual) or the server-executed apply (auto).
   */
  editApplyMode: v.exactOptional(
    v.union([
      v.literal(CHAT_EDIT_APPLY_MODE.manual),
      v.literal(CHAT_EDIT_APPLY_MODE.auto),
    ]),
  ),
  /**
   * Redline representation for the `auto` review mode only; omitted means
   * `DEFAULT_DOCX_EDIT_REPRESENTATION`. Ignored in `manual` mode, where the
   * human picks the representation at accept time.
   */
  docxEditRepresentation: v.exactOptional(
    v.union([
      v.literal(DOCX_EDIT_REPRESENTATION.trackedChanges),
      v.literal(DOCX_EDIT_REPRESENTATION.direct),
    ]),
  ),
  devModelId: v.exactOptional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(160),
      v.regex(/^[A-Za-z0-9._:/-]+$/u),
    ),
  ),
};

const noResumeBodySchema = v.strictObject({
  ...sendMessageCommonProperties,
  message: rawMessageSchema,
});

const nativeAssistantContinuationBodySchema = v.strictObject({
  ...sendMessageCommonProperties,
  message: rawAssistantContinuationMessageSchema,
  parentRunId: agUiRunIdSchema,
  resume: agUiResumeSchema,
});

export const sendMessageBodySchema = v.union([
  noResumeBodySchema,
  nativeAssistantContinuationBodySchema,
]);

export type ChatSendRequest = v.InferOutput<typeof sendMessageBodySchema>;

const agUiMessageEnvelopeSchema = v.looseObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  role: v.picklist([
    "developer",
    "system",
    "assistant",
    "user",
    "tool",
    "activity",
    "reasoning",
  ]),
});

/**
 * Canonical AG-UI RunAgentInput envelope emitted by TanStack's connection
 * adapter. Stella-specific, strictly validated inputs live in forwardedProps;
 * correlation and resume fields stay protocol-native at the top level.
 */
const agUiEnvelopeCommonProperties = {
  threadId: resourceIdSchema("chatThread"),
  runId: agUiRunIdSchema,
  state: v.looseObject({}),
  messages: v.pipe(v.array(agUiMessageEnvelopeSchema), v.maxLength(4096)),
  tools: v.pipe(
    v.array(
      v.strictObject({
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        description: v.pipe(v.string(), v.maxLength(16_384)),
        parameters: v.exactOptional(v.unknown()),
        metadata: v.exactOptional(v.record(v.string(), v.unknown())),
      }),
    ),
    v.maxLength(512),
  ),
  context: v.pipe(
    v.array(
      v.strictObject({
        description: v.pipe(v.string(), v.maxLength(16_384)),
        value: v.pipe(v.string(), v.maxLength(1_000_000)),
      }),
    ),
    v.maxLength(512),
  ),
};

export const agUiSendMessageBodySchema = v.union([
  v.strictObject({
    ...agUiEnvelopeCommonProperties,
    forwardedProps: noResumeBodySchema,
    data: noResumeBodySchema,
  }),
  v.strictObject({
    ...agUiEnvelopeCommonProperties,
    forwardedProps: nativeAssistantContinuationBodySchema,
    data: nativeAssistantContinuationBodySchema,
    parentRunId: agUiRunIdSchema,
    resume: agUiResumeSchema,
  }),
]);

type RawIncomingMessage = v.InferOutput<typeof rawMessageSchema>;
type AgUiResume = v.InferOutput<typeof agUiResumeSchema>;
export type IncomingUserContext = v.InferOutput<typeof userContextSchema>;
export type IncomingActiveFile = v.InferOutput<typeof activeFileSchema>;
export type IncomingActiveDraft = v.InferOutput<typeof activeDraftSchema>;
export type IncomingActiveTemplate = v.InferOutput<typeof activeTemplateSchema>;
export type IncomingActiveDecision = v.InferOutput<typeof activeDecisionSchema>;
export type IncomingActiveExternal = v.InferOutput<typeof activeExternalSchema>;
export type IncomingActiveStatute = v.InferOutput<typeof activeStatuteSchema>;

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
  providerMetadata: "state-independent",
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
type DeniedToolOutput = { approved: false; message: string };

// AG-UI history rebuilds a denial as a decision payload, not an execution
// error. Share its exact boundary check between call and result validation.
const isDeniedToolOutput = (value: unknown): value is DeniedToolOutput =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value["approved"] === false &&
  typeof value["message"] === "string" &&
  value["message"].length > 0;

type ValidatedToolCallPart =
  | {
      type: "denied";
      name: string;
      output: DeniedToolOutput;
      part: ChatToolCallPart;
    }
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
  // The validated input is the persisted call's one spelling; the provider
  // text is re-derived from it so no reader of `arguments` sees a strict
  // schema's null-widened optionals (`validateCanonicalToolInput`).
  const argumentsText = JSON.stringify(payload.input);
  const candidate: unknown =
    payload.type === "input-only"
      ? { ...part, arguments: argumentsText, input: payload.input }
      : {
          ...part,
          arguments: argumentsText,
          input: payload.input,
          output: payload.output,
        };
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
      tools,
    });
    if (Result.isError(partsResult)) {
      return Result.err(partsResult.error);
    }
    yield* Result.await(
      validatePrivateReceipts({
        parts: partsResult.value.parts,
        safeDb,
        threadId,
        userId,
      }),
    );

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
  tools,
}: {
  message: RawIncomingMessage;
  persistedMessage: ValidateMessageInput["persistedMessage"];
  resume: AgUiResume | undefined;
  tools: ChatToolMap;
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

  const canonicalMessage =
    message.role === "assistant" && persistedMessage?.role === "assistant"
      ? chatMessageFromPersisted({
          id: message.id,
          role: persistedMessage.role,
          content: persistedMessage.content,
        })
      : null;
  const persistedParts = arrayOrEmpty(canonicalMessage?.parts);
  if (canonicalMessage !== null) {
    const continuationResult = validateContinuationToolCallIntegrity({
      incomingParts: validatedParts,
      persistedMessage: canonicalMessage,
      resume,
      tools,
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
      return continueStoredChatPart(part, canonicalizeToolCall(part));
    }
    if (validatedCall.type === "transitioned") {
      transitionedCallIds.add(part.id);
    }
    return continueStoredChatPart(part, validatedCall.call);
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
    if (
      !mergedParts.some(
        (candidate) =>
          candidate.type === "tool-call" && candidate.id === part.toolCallId,
      )
    ) {
      continue;
    }
    // Appended, as the client appends a result it adds, so the stored
    // message keeps the order the page showed.
    mergedParts.push({
      type: "tool-result",
      toolCallId: part.toolCallId,
      content: part.content,
      state: part.state,
      ...(part.error === undefined ? {} : { error: part.error }),
      ...(part.outcome === undefined ? {} : { outcome: part.outcome }),
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
 * compared after applying the tool schema on both sides, including its defaults
 * and placeholder rules, and the server copy is restored onto the accepted call.
 */
type ValidatedContinuationToolCall =
  | { type: "transitioned"; call: ChatToolCallPart }
  | { type: "unchanged"; call: ChatToolCallPart };

const validateContinuationToolCallIntegrity = ({
  incomingParts,
  persistedMessage,
  resume,
  tools,
}: {
  incomingParts: readonly ChatPart[];
  persistedMessage: ChatMessage;
  resume: AgUiResume | undefined;
  tools: ChatToolMap;
}): Result<
  ReadonlyMap<string, ValidatedContinuationToolCall>,
  HandlerError<400>
> => {
  const canonicalCalls = persistedMessage.parts.filter(
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
      tool: registeredChatTool(tools, canonicalCall.name),
    });
    if (Result.isError(validatedCallResult)) {
      return Result.err(validatedCallResult.error);
    }
    validatedCallsById.set(incomingCall.id, validatedCallResult.value);
  }

  const awaitedInteractions = getAwaitingUserInteractions(persistedMessage);
  const awaitedCallIds = new Set(
    awaitedInteractions.map(({ toolCallId }) => toolCallId),
  );
  if (
    [...validatedCallsById.values()].some(
      (call) =>
        call.type === "transitioned" && !awaitedCallIds.has(call.call.id),
    ) ||
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
  const base = Object.fromEntries(
    Object.entries(CONTINUATION_TOOL_CALL_PROPERTY_DISPOSITION).flatMap(
      ([property, disposition]) =>
        disposition === "state-independent" &&
        Object.hasOwn(canonicalValue, property)
          ? [[property, canonicalValue[property]] as const]
          : [],
    ),
  );
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

/**
 * The continuation's input under the same schema that validated the stored
 * call. The browser echoes provider arguments before defaults were applied.
 * Fold placeholders before parsing, so nullable values remain values while
 * absent optional fields receive the same defaults as the stored input.
 * A call with no known schema (a tool this request does not register, or one
 * without an input schema) keeps the schema-blind fold of every `null`.
 */
const normalizeContinuationInput = (
  tool: ChatTool | undefined,
  value: unknown,
): Result<unknown, HandlerError<400>> => {
  if (tool?.inputSchema === undefined) {
    return Result.ok(withNullsOmitted(value));
  }
  return validateToolPayload({
    payload: withToolInputPlaceholdersOmitted(tool.inputSchema, value),
    payloadName: "input",
    schema: tool.inputSchema,
    toolName: tool.name,
  });
};

const validateContinuationToolCallTransition = ({
  canonicalCall,
  incomingCall,
  tool,
}: {
  canonicalCall: ChatToolCallPart;
  incomingCall: ChatToolCallPart;
  tool: ChatTool | undefined;
}): Result<ValidatedContinuationToolCall, HandlerError<400>> => {
  if (incomingCall.state === canonicalCall.state) {
    return Result.ok({
      type: "unchanged",
      call: canonicalizeToolCall(canonicalCall),
    });
  }
  const incomingInput = normalizeContinuationInput(tool, incomingCall.input);
  const canonicalInput = normalizeContinuationInput(tool, canonicalCall.input);
  if (
    incomingCall.name !== canonicalCall.name ||
    Result.isError(incomingInput) ||
    Result.isError(canonicalInput) ||
    !deepEquals(incomingInput.value, canonicalInput.value)
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
      if (
        isServerChatToolCall(canonicalCall) ||
        (incomingCall.state !== "complete" && incomingCall.state !== "error")
      ) {
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
    case "approval-responded": {
      // The approved call the engine handed to the client: its result.
      if (
        !isApprovedClientCallAwaitingResult(canonicalCall) ||
        !("approval" in canonicalCall) ||
        (incomingCall.state !== "complete" && incomingCall.state !== "error")
      ) {
        return invalidContinuationToolCall();
      }
      const output: unknown = incomingCall.output;
      const candidate: unknown = {
        ...canonicalBase,
        approval: canonicalCall.approval,
        output,
        state: incomingCall.state,
      };
      if (!isChatPart(candidate) || candidate.type !== "tool-call") {
        panic("Validated chat tool call violates the tool-call contract");
      }
      return Result.ok({ type: "transitioned", call: candidate });
    }
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
  metadata.contextNotice === undefined &&
  metadata.docxEditPreferences === undefined &&
  metadata.mentions === undefined &&
  metadata.refContext === undefined &&
  metadata.refEncoding === undefined &&
  metadata.serverProvenance === undefined &&
  metadata.sourceDocuments === undefined &&
  metadata.turnOutcome === undefined &&
  metadata.turnTiming === undefined &&
  metadata.turnModel === undefined &&
  metadata.usage === undefined;

export const validateToolCallParts = ({
  allowPartialInput = false,
  allowDeferredServerInput = false,
  clientAuthoredCallIds,
  message,
  tools,
}: {
  allowPartialInput?: boolean;
  allowDeferredServerInput?: boolean;
  /** See `ValidatedIncomingChatParts`; `undefined` validates every call. */
  clientAuthoredCallIds?: ReadonlySet<string> | undefined;
  message: ChatMessage;
  tools: ChatToolMap;
}): Result<ChatPart[], HandlerError<400>> => {
  const toolCallsById = new Map<string, ValidatedToolCallPart>();
  const serverAuthoredCallIds = new Set<string>();
  const parts: ChatPart[] = [];
  const awaitedCallIds = new Set(
    getAwaitingUserInteractions(message).map(({ toolCallId }) => toolCallId),
  );
  const firstAwaitedIndex = message.parts.findIndex(
    (part) => part.type === "tool-call" && awaitedCallIds.has(part.id),
  );

  for (const [index, part] of message.parts.entries()) {
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
        allowDeferredServerInput:
          allowDeferredServerInput &&
          firstAwaitedIndex !== -1 &&
          index > firstAwaitedIndex,
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
  allowDeferredServerInput,
  part,
  tools,
}: {
  allowPartialInput: boolean;
  allowDeferredServerInput: boolean;
  part: ChatToolCallPart;
  tools: ChatToolMap;
}): Result<ValidatedToolCallPart, HandlerError<400>> => {
  const tool = registeredChatTool(tools, part.name);
  if (TOOL_CALL_OUTPUT_VALIDATION[part.state] === "error") {
    return validateErrorToolCallPart({ part, tool });
  }
  if (tool === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Unknown chat tool: ${part.name}`,
      }),
    );
  }

  // Calls queued behind approval reach SDK input validation only on resume.
  if (
    (allowPartialInput &&
      (part.state === "awaiting-input" || part.state === "input-streaming")) ||
    (allowDeferredServerInput &&
      part.state === "input-complete" &&
      isServerChatToolCall(part) &&
      part.output === undefined)
  ) {
    if (allowDeferredServerInput && part.input !== undefined) {
      const parsed = parseToolArguments(part.arguments);
      if (Result.isError(parsed)) {
        return Result.err(parsed.error);
      }
      const agreement = validateToolInputAgreement({
        parsedArguments: parsed.value,
        part,
        schema: tool.inputSchema,
      });
      if (Result.isError(agreement)) {
        return Result.err(agreement.error);
      }
    }
    return Result.ok({
      type: "schema",
      name: part.name,
      output: { type: "absent" },
      part,
    });
  }

  const validatedInputResult = validateToolCallInput({ part, tool });
  if (Result.isError(validatedInputResult)) {
    return Result.err(validatedInputResult.error);
  }
  const validatedInput = validatedInputResult.value;

  if (part.output === undefined) {
    return Result.ok({
      type: "schema",
      name: part.name,
      output: { type: "absent" },
      part: withValidatedToolPayload({
        part,
        payload: { type: "input-only", input: validatedInput },
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
        input: validatedInput,
        output: outputResult.value,
      },
    }),
  });
};

/** A call's input in the form its tool's schema gives it, or why not
 *  (`validateCanonicalToolInput`). */
const validateToolCallInput = ({
  part,
  tool,
}: {
  part: ChatToolCallPart;
  tool: ChatTool;
}): Result<unknown, HandlerError<400>> => {
  const argumentsResult = parseToolArguments(part.arguments);
  if (Result.isError(argumentsResult)) {
    return Result.err(argumentsResult.error);
  }
  return validateCanonicalToolInput({
    parsedArguments: argumentsResult.value,
    part,
    schema: tool.inputSchema,
  });
};

/**
 * A call the engine answered with an error never ran, and the model was
 * handed that error, so the call is turn data whatever its input: the model
 * may have sent arguments the tool's schema rejects, or named a tool the run
 * does not register, and then gone on to recover. Input the schema accepts is
 * stored canonical, as for any call. Other input is stored exactly as the
 * model sent it, since every later request replays it to the model: `input`
 * holds it only when it is a JSON object whose text is the `arguments`
 * verbatim, and is left out otherwise (a primitive, other spacing, text that
 * is not JSON), so the raw `arguments` are what gets stored. The error output
 * itself must still be well formed.
 */
const validateErrorToolCallPart = ({
  part,
  tool,
}: {
  part: ChatToolCallPart;
  tool: ChatTool | undefined;
}): Result<ValidatedToolCallPart, HandlerError<400>> => {
  const errorOutputResult = validateToolCallErrorOutput(part);
  if (Result.isError(errorOutputResult)) {
    return Result.err(errorOutputResult.error);
  }
  const output = errorOutputResult.value;
  const canonicalInput =
    tool === undefined ? undefined : validateToolCallInput({ part, tool });
  const input =
    canonicalInput !== undefined && Result.isOk(canonicalInput)
      ? { type: "present" as const, value: canonicalInput.value }
      : verbatimToolInput(part.arguments);
  const call: Record<string, unknown> = { ...part };
  const candidate: unknown = {
    ...Object.fromEntries(
      Object.entries(call).filter(
        ([key]) => key !== "input" && key !== "output",
      ),
    ),
    ...(input.type === "present" ? { input: input.value } : {}),
    ...(output.type === "denied" ? { output: output.output } : {}),
    ...(output.type === "error" && output.error !== undefined
      ? { output: { error: output.error } }
      : {}),
  };
  if (!isChatPart(candidate) || candidate.type !== "tool-call") {
    return panic("A failed chat tool call violates the tool-call contract");
  }
  switch (output.type) {
    case "denied":
      return Result.ok({
        type: "denied",
        name: part.name,
        output: output.output,
        part: candidate,
      });
    case "error":
      return Result.ok({
        type: "error",
        name: part.name,
        error: output.error,
        part: candidate,
      });
    default:
      output satisfies never;
      return panic(`Unhandled tool failure output: ${String(output)}`);
  }
};

/** `argumentsText` as an input object, when the object's JSON is exactly
 *  that text, so storing the object loses nothing of what the model sent. */
const verbatimToolInput = (
  argumentsText: string,
): { type: "absent" } | { type: "present"; value: object } => {
  const parsed = Result.try((): unknown => parseJsonUnknown(argumentsText));
  return Result.isOk(parsed) &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    JSON.stringify(parsed.value) === argumentsText
    ? { type: "present", value: parsed.value }
    : { type: "absent" };
};

type ValidatedToolFailureOutput =
  | { type: "error"; error: string | undefined }
  | { type: "denied"; output: DeniedToolOutput };

const validateToolCallErrorOutput = (
  part: ChatToolCallPart,
): Result<ValidatedToolFailureOutput, HandlerError<400>> => {
  const output: unknown = part.output;
  if (output === undefined) {
    return Result.ok({ type: "error", error: undefined });
  }
  // Denial is an approval decision, not a failed server execution. The SDK
  // preserves its decision payload on the call and the paired result.
  if (
    "approval" in part &&
    part.approval.approved === false &&
    isDeniedToolOutput(output)
  ) {
    return Result.ok({ type: "denied", output });
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
  return Result.ok({ type: "error", error: output.error });
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
    if (toolCall.type === "schema") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Chat tool result state does not match call: ${part.toolCallId}`,
        }),
      );
    }
    return validateToolErrorResult(part, toolCall);
  }

  if (toolCall.type !== "schema" || toolCall.output.type === "absent") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Chat tool result has no paired output: ${part.toolCallId}`,
      }),
    );
  }

  const tool = registeredChatTool(tools, toolCall.name);
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
  toolCall: Extract<ValidatedToolCallPart, { type: "error" | "denied" }>,
): Result<void, HandlerError<400>> => {
  const contentResult = parseToolResultContent(part.content);
  if (Result.isError(contentResult)) {
    return Result.err(contentResult.error);
  }

  switch (toolCall.type) {
    case "denied": {
      if (
        part.outcome === "denied" &&
        part.error === undefined &&
        deepEquals(contentResult.value, toolCall.output)
      ) {
        return Result.ok();
      }
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Invalid chat tool denial result: ${part.toolCallId}`,
        }),
      );
    }
    case "error":
      break;
    default:
      toolCall satisfies never;
      return panic(`Unhandled tool failure: ${String(toolCall)}`);
  }

  // A denied result rebuilt from AG-UI history carries the approval decision
  // as content, rather than the server execution error envelope.
  const content = contentResult.value;
  if (
    part.outcome === "denied" &&
    "approval" in toolCall.part &&
    toolCall.part.approval.approved === false &&
    isDeniedToolOutput(content) &&
    part.error === undefined
  ) {
    return Result.ok();
  }

  if (
    !part.error ||
    (toolCall.error !== undefined && toolCall.error !== part.error)
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

/**
 * The one copy of a tool call's input that is validated against the tool
 * schema and persisted.
 *
 * A strict provider schema widens every optional field to nullable, so the raw
 * `arguments` text spells an absent optional as `null`. Chat's provider stream
 * folds that back before it attaches `input` to the call
 * (`withModelPlaceholdersOmitted`), but the text keeps the provider's
 * spelling, and the tool schema's `optional` fields admit absence, not
 * `null`. So `input` is the canonical copy: the text must agree with it once
 * both are folded by that same rule, and only `input` meets the schema. A part
 * with no `input` (rebuilt by a client, or persisted before adapters attached
 * one) has only the text, which is folded the same way and then is the input,
 * so a call has one canonical spelling whichever copy arrived. The rule reads
 * the schema, so a `null` the schema admits (a nullable field) stays.
 */
/**
 * A model's tool input under the placeholder rule chat's provider stream
 * applies (`withDeclaredToolInput`), read off the JSON Schema the provider
 * was handed for the tool.
 */
const withToolInputPlaceholdersOmitted = (
  schema: unknown,
  value: unknown,
): unknown =>
  withModelPlaceholdersOmitted(
    isStandardSchema(schema) ? convertSchemaToJsonSchema(schema) : schema,
    value,
  );

const validateCanonicalToolInput = ({
  parsedArguments,
  part,
  schema,
}: {
  parsedArguments: unknown;
  part: ChatToolCallPart;
  schema: unknown;
}): Result<unknown, HandlerError<400>> => {
  if (part.input === undefined) {
    return validateToolPayload({
      payload: withToolInputPlaceholdersOmitted(schema, parsedArguments),
      payloadName: "arguments",
      schema,
      toolName: part.name,
    });
  }
  const agreement = validateToolInputAgreement({
    parsedArguments,
    part,
    schema,
  });
  if (Result.isError(agreement)) {
    return Result.err(agreement.error);
  }
  return validateToolPayload({
    payload: part.input,
    payloadName: "input",
    schema,
    toolName: part.name,
  });
};

const validateToolInputAgreement = ({
  parsedArguments,
  part,
  schema,
}: {
  parsedArguments: unknown;
  part: ChatToolCallPart;
  schema: unknown;
}): Result<void, HandlerError<400>> => {
  if (
    !deepEquals(
      withToolInputPlaceholdersOmitted(schema, parsedArguments),
      withToolInputPlaceholdersOmitted(schema, part.input),
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Chat tool input does not match arguments for ${part.name}`,
      }),
    );
  }
  return Result.ok();
};

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
    // Pasted text is plain text, rather than editor HTML; preserve it verbatim.
    if (isChatPastedTextPart(part)) {
      normalizedParts.push(part);
      continue;
    }
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
