import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import { chatMessageContentFromMessage } from "@/api/handlers/chat/chat-message-parts";
import {
  appendAnonymizedModeHintToChatSafePrompt,
  buildChatPromptCacheKey,
  buildChatSystemPromptParts,
  extendChatUntrustedPromptSuffix,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
  ChatSafePrompt,
  ChatToolAvailability,
  ChatUntrustedPromptSuffix,
} from "@/api/handlers/chat/chat-prompt";
import type {
  ChatSendRequest,
  IncomingActiveDecision,
  IncomingActiveExternal,
  IncomingActiveFile,
  IncomingActiveSkill,
  IncomingActiveTemplate,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import {
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  parseMessage,
  sendMessageBodySchema,
  validateMessage,
} from "@/api/handlers/chat/chat-schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  compactChatMessagesForModel,
  shouldCompactChatMessages,
} from "@/api/handlers/chat/compaction";
import { resolveChatCompactionBudget } from "@/api/handlers/chat/compaction-budget";
import {
  computeAssistantTurnWorkspaceIds,
  expandThreadDataScope,
  extractIncomingMessageWorkspaceIds,
  extractThreadDataWorkspaceIds,
} from "@/api/handlers/chat/data-scope";
import { ChatError } from "@/api/handlers/chat/errors";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import {
  chatMessageExistsForThread,
  loadFullThreadHistory,
  resolveTruncationTarget,
} from "@/api/handlers/chat/history-window";
import { isExternalMcpToolPart } from "@/api/handlers/chat/mcp-tool-parts";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import {
  planAssistantFinishPersistence,
  planMessagePersistence,
} from "@/api/handlers/chat/persist-message";
import {
  applyChatCompactionCheckpoint,
  markActiveChatCompactionCheckpointStale,
  persistChatCompactionCheckpoint,
  readLatestChatCompaction,
  shouldInvalidateChatCompactionCheckpoint,
} from "@/api/handlers/chat/persistent-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import {
  loadThread,
  readThreadValidationState,
} from "@/api/handlers/chat/send-message-thread";
import type { ChatThreadState } from "@/api/handlers/chat/send-message-thread";
import {
  resolveActiveChatSkillContext,
  type ActiveChatSkillContext,
} from "@/api/handlers/chat/skills";
import { hydrateMessages, streamChat } from "@/api/handlers/chat/stream-chat";
import { createChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { shouldMarkThreadUsedAnonymization } from "@/api/handlers/chat/thread-anonymization";
import {
  intersectAccessibleWorkspaceIds,
  resolveToolWorkspaceIds,
} from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  areSubagentToolsRegistered,
  areTemplateAuthoringToolsRegistered,
  areWebResearchToolsRegistered,
  getChatTools,
  resolveRegisteredDocxEditMode,
} from "@/api/handlers/chat/tools/chat-tools";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import {
  buildExternalMcpSystemHint,
  createLazyExternalMcpToolsLoader,
  loadExternalMcpToolsForUser,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import type {
  LazyExternalMcpToolsLoader,
  LoadedExternalMcpTools,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/spawn-subagents-tool";
import {
  type ChatToolScope,
  restrictChatToolsToScope,
  scopeAllowsTool,
} from "@/api/handlers/chat/tools/tool-scope";
import type {
  ChatMessage,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { createRawChatFilePart } from "@/api/handlers/chat/upload-files";
import { createFileKey } from "@/api/handlers/files/utils";
import { getDisabledNativeToolSlugs } from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveEffectiveChatModelId } from "@/api/lib/chat-model-selection";
import { detached } from "@/api/lib/detached";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { resolveMemorySourceWorkspaceIds } from "@/api/lib/memory/memory-provenance";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";
import {
  requireTanStackAIAvailableForRole,
  validateTanStackDevModelOverride,
} from "@/api/lib/tanstack-ai-models";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const CHAT_COMPACTION_CHECKPOINT_TIMEOUT_MS = 120_000;
const CHAT_METERED_AI_TIMEOUT_MS = 600_000;

/**
 * Dev model overrides (`body.devModelId`) are local-only: reject them outside
 * dev, otherwise validate the override against the org's provider config.
 */
const assertDevModelOverride = (
  devModelId: string | undefined,
  orgAIConfig: OrgAIConfig | null,
): Result<void, HandlerError<400>> => {
  if (!devModelId) {
    return Result.ok(undefined);
  }
  if (!env.isDev) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Dev model overrides are only available locally.",
      }),
    );
  }
  return validateTanStackDevModelOverride(devModelId, orgAIConfig);
};

/**
 * Whether the delegation tool is offered on this turn: only at the top level,
 * and only when the turn's scope (if any) allows `spawn_subagents`. Kept as a
 * top-level helper so the streaming handler stays within its cognitive-
 * complexity budget.
 */
const areSubagentToolsAvailableForTurn = (
  toolScope: ChatToolScope | undefined,
): boolean =>
  areSubagentToolsRegistered({ delegationDepth: 0 }) &&
  (toolScope === undefined ||
    scopeAllowsTool(toolScope, SPAWN_SUBAGENTS_TOOL_NAME));

const normalizeOptionalArray = <T>(value: T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }
  return value;
};

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "realtime_stream" },
  body: sendMessageBodySchema,
  requiresUsage: { actionType: "chat" },
} satisfies HandlerConfig;

/** IDs of workspaces the chat may touch; deleting workspaces are excluded. */
const usableWorkspaceIds = (
  workspaces: readonly AccessibleWorkspace[],
): AccessibleWorkspace["id"][] => {
  const ids: AccessibleWorkspace["id"][] = [];
  for (const workspace of workspaces) {
    if (workspace.status !== "deleting") {
      ids.push(workspace.id);
    }
  }
  return ids;
};

const sendMessage = createSafeRootHandler(
  config,
  async function* ({
    body,
    getAccessibleWorkspaces,
    getWorkspaceAccess,
    memberRole,
    orgAIConfig,
    promptCachingEnabled,
    pinServerValidatedWorkspaceId,
    recordAuditEvent,
    request,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    const isClientConnectionAborted = () => request.signal.aborted;

    if (isClientConnectionAborted()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Client disconnected before AI work started",
        }),
      );
    }

    yield* requireTanStackAIAvailableForRole({
      orgConfig: orgAIConfig,
      role: "chat",
    });

    yield* assertDevModelOverride(body.devModelId, orgAIConfig);
    const externalMcpNullUnionStrategy = "json-schema";

    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );
    const accessibleWorkspaceIds = usableWorkspaceIds(accessibleWorkspaces);
    // Real per-workspace statuses for the projected write tools' MCP context.
    // The usable ID set includes archived workspaces, so the write handlers'
    // `ensureActiveWorkspace` gate must see the true status (not a default) to
    // keep archived matters read-only.
    const workspaceStatusById = new Map<string, AccessibleWorkspace["status"]>(
      accessibleWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    );
    /* eslint-disable no-body-ownership-ids/no-body-ownership-ids -- root handler; resolveChatScope performs targeted workspace authorization */
    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId: body.workspaceId,
    });
    /* eslint-enable no-body-ownership-ids/no-body-ownership-ids */

    const workspaceId = scope.scope === "workspace" ? scope.workspaceId : null;
    const orgSettingsForChat = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            practiceJurisdictions: true,
            nativeToolOverrides: true,
          },
        }),
      ),
    );
    const disabledNativeToolSlugs = getDisabledNativeToolSlugs({
      practiceJurisdictions: normalizeOptionalArray(
        orgSettingsForChat?.practiceJurisdictions,
      ),
      nativeToolOverrides: orgSettingsForChat?.nativeToolOverrides ?? {},
    });

    // The body's contextMatterIds is the AI's "draw-from" set —
    // distinct from the chat's own scope (workspaceId/global). It
    // may include the chat's matter plus any others the user wants
    // in scope, validated against the user's accessible matters.
    // Empty (or omitted) means "no matters pinned" — the AI is
    // expected to discover relevant matters via the readonly
    // Stella API instead of being preloaded with thousands of IDs.
    const requestedContextMatterIds = normalizeOptionalArray(
      body.contextMatterIds,
    );
    const accessibleSet = new Set<string>(accessibleWorkspaceIds);
    if (!requestedContextMatterIds.every((id) => accessibleSet.has(id))) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "contextMatterIds includes inaccessible matter",
        }),
      );
    }

    const refRegistry = createChatRefRegistry();
    // Narrower than the combined `apply-active-docx-edits` gate below:
    // only the file overlay (`file-chat-overlay.tsx`) mounts the
    // auto-run watcher that resolves the folio-agents `read_document` /
    // `find_text` tools via `addToolResult`. Template Studio has no such
    // watcher, so a tool call there would hang the session until reload.
    // Computed once and reused for tool registration (validation +
    // streaming) and for the matching prompt guidance below.
    const hasActiveDocxFileClient = body.activeFile?.supportsDocxEdits === true;
    // Per-turn DOCX-edit review-mode setting: which of the two mutually
    // exclusive tools (`apply-active-docx-edits` manual /
    // `edit_workspace_document` auto) `getChatTools` registers, and (for
    // auto) which redline representation it applies with. Resolved once
    // and reused for both the validation and streaming tool sets below,
    // matching every other per-turn setting on this path.
    const editApplyMode = body.editApplyMode ?? DEFAULT_CHAT_EDIT_APPLY_MODE;
    const docxEditRepresentation =
      body.docxEditRepresentation ?? DEFAULT_DOCX_EDIT_REPRESENTATION;
    const activeFileEntity =
      body.activeFile?.supportsDocxEdits === true && workspaceId !== null
        ? yield* Result.await(
            safeDb((tx) =>
              tx.query.entities.findFirst({
                where: {
                  id: { eq: body.activeFile?.entityId },
                  workspaceId: { eq: workspaceId },
                },
                columns: { currentVersionId: true },
              }),
            ),
          )
        : undefined;
    // Server-authoritative version binding for approval-gated automatic DOCX
    // edits. The model must echo this id in the tool input; a later approval
    // request rebuilds the schema from the then-current version, so an old
    // pending call fails validation instead of applying to a newer document.
    const activeFileForTools =
      body.activeFile === undefined
        ? undefined
        : {
            ...body.activeFile,
            ...(activeFileEntity?.currentVersionId === null ||
            activeFileEntity?.currentVersionId === undefined
              ? {}
              : { currentVersionId: activeFileEntity.currentVersionId }),
          };
    const validationThreadState = yield* Result.await(
      readThreadValidationState({
        organizationId: session.activeOrganizationId,
        safeDb,
        threadId: body.threadId,
        userId: user.id,
        workspaceId,
      }),
    );
    const validationActiveSkillContext = yield* Result.await(
      resolveActiveChatSkillContext({
        activeSkill: body.activeSkill,
        memberRole,
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
      }),
    );
    // Lazy and memoized: connector discovery only runs once some caller
    // actually needs the tools (validation only needs them when
    // `messageNeedsExternalMcpValidation` is true; the streaming pass
    // always needs them), and at most once per send no matter how many
    // callers ask — `createLazyExternalMcpToolsLoader` caches the first
    // call's promise, so a validation-triggered load is reused by the
    // streaming pass instead of running discovery twice.
    // `externalMcpToolsHandedOffToStreaming` below tracks whether
    // ownership of closing these connectors (if ever loaded) passed to the
    // streaming try/catch, so every other exit path (validation failure,
    // any early return or throw between here and streaming) still closes
    // them exactly once.
    const externalMcpToolsLoader = createLazyExternalMcpToolsLoader(
      async () =>
        await loadExternalMcpToolsForUser({
          nullUnionStrategy: externalMcpNullUnionStrategy,
          organizationId: session.activeOrganizationId,
          safeDb,
          userId: user.id,
        }),
    );
    let externalMcpToolsHandedOffToStreaming = false;

    // The try/finally starts immediately after the loader is constructed
    // (rather than just around the streaming pass) so that a throw from
    // any of the awaited steps below — web-search provider load,
    // tool-set construction, message validation — still closes
    // `externalMcpToolsLoader` (a no-op if nothing was ever loaded)
    // instead of leaking MCP clients. The streaming pass further below
    // takes over ownership once it starts consuming the clients (flips
    // `externalMcpToolsHandedOffToStreaming`); until then this `finally` is
    // the sole owner. `Result.gen`'s `yield*` short-circuit resumes the
    // generator via `.return()`, which unwinds this `finally` like a normal
    // early `return` would.
    try {
      if (isClientConnectionAborted()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      // Resolve the org's web-search providers once (BYOK key first,
      // platform env key as fallback) and reuse for both the validation
      // and streaming tool sets.
      const webSearchProviders = await loadWebSearchProvidersForOrg(
        session.activeOrganizationId,
      );

      if (isClientConnectionAborted()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      // Only load external MCP tools for validation when the incoming
      // message actually carries a part that needs them — an ordinary
      // message never triggers connector discovery here. The streaming
      // pass below always needs the full set and reuses this same load via
      // the memoized loader instead of running discovery again.
      const externalToolsForValidation =
        await resolveExternalToolsForValidation(
          body.message,
          externalMcpToolsLoader,
        );

      if (isClientConnectionAborted()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      // Tool input schemas don't depend on `accessibleWorkspaceIds`
      // (scope is checked at execute time, not in the schema), so we
      // can validate the incoming message against the broad set and
      // then rebuild the tools with the narrowed `effective` set
      // before streaming. This lets the picker's scope actually
      // govern tool authorization rather than just being persisted.
      // Validation tools include the broadest workspace surface, but
      // still honor thread/org gates for tools whose presence is an
      // explicit user or administrator opt-in.
      const validationTools = getChatTools({
        organizationId: session.activeOrganizationId,
        memberRole: memberRole.role,
        orgAIConfig,
        pinServerValidatedWorkspaceId,
        requestWorkspaceId: workspaceId,
        refRegistry,
        safeDb,
        scopedDb,
        threadId: body.threadId,
        workspaceId,
        userId: user.id,
        // Schema validation only; this tool set's `spawn_subagents` never
        // executes, so a raw (non-anonymizing) boundary is correct here —
        // the real per-request boundary is created below and threaded
        // into the streaming tool set instead.
        thirdPartyBoundary: { type: "raw" },
        // Schema validation runs against the user's full accessible
        // set; per-tool scope checks happen at execute time below.
        toolWorkspaceIds: resolveToolWorkspaceIds({
          pinnedIds: [],
          accessibleWorkspaceIds,
        }),
        activeFile: activeFileForTools,
        hasActiveDocxEditClient: true,
        hasActiveDocxFileClient: true,
        editApplyMode,
        docxEditRepresentation,
        includeAllDocxEditToolsForValidation: true,
        webSearchEnabled: validationThreadState.webSearchEnabled,
        webSearchProviders,
        externalTools: externalToolsForValidation,
        disabledNativeToolSlugs,
        activeSkillContext: validationActiveSkillContext,
        recordAuditEvent,
        resolveMemorySourceWorkspaceIds: () =>
          resolveMemorySourceWorkspaceIds({
            accessibleWorkspaceIds: new Set(accessibleWorkspaceIds),
            contextMatterIds: [],
            dataWorkspaceIds: [],
            registeredWorkspaceIds: refRegistry.getRegisteredWorkspaceIds(),
            workspaceId,
          }),
        workspaceStatusById,
      });

      const validatedMessageResult = await validateMessage({
        message: body.message,
        safeDb,
        threadId: body.threadId,
        tools: validationTools,
        userId: user.id,
      });
      if (Result.isError(validatedMessageResult)) {
        // The wrapping try/finally closes `externalMcpToolsLoader` on this
        // exit path too (a no-op if this message never needed the external
        // tools) — no explicit close needed here.
        return Result.err(validatedMessageResult.error);
      }
      const validatedMessage = validatedMessageResult.value;

      // Captured once and threaded through to generateThreadTitle below: the
      // generator's guard compares the thread's live title against this
      // value to detect any rename (even one whose titleSource column went
      // stale) rather than trusting titleSource alone.
      const initialThreadTitle = extractTitle(validatedMessage.message.parts);

      const thread = yield* Result.await(
        loadThread({
          initialContextMatterIds: requestedContextMatterIds,
          isAnonymized: body.sendMode === CHAT_SEND_MODE.anonymized,
          organizationId: session.activeOrganizationId,
          recordAuditEvent,
          safeDb,
          threadId: body.threadId,
          title: initialThreadTitle,
          userId: user.id,
          workspaceId,
        }),
      );

      // Existing-thread pin changes are durable side effects, so stop before
      // applying them when any earlier validation or thread read observed a
      // client disconnect. Created threads still need their rollback token
      // cleaned up on this exit path.
      if (isClientConnectionAborted()) {
        yield* Result.await(
          rollbackUnpersistedChatSideEffects({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadState: thread,
            uploadedFiles: [],
            userId: user.id,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      // The thread's persisted chat-model override wins over the org/instance
      // default, but the dev-only body override still wins over everything
      // (matches `assertDevModelOverride` above). Re-validated here (not just
      // at write time in update-thread-model.ts) so a provider key removal or
      // a catalog bump that drops the model falls back to the org default
      // silently instead of failing the send.
      const chatModelOverride = resolveEffectiveChatModelId({
        devModelId: body.devModelId,
        threadChatModel: thread.data.chatModel,
        orgAIConfig,
      });

      // For an existing thread, accept a non-empty body update as
      // "user changed scope, persist it"; an omitted/empty body keeps
      // the stored value so re-sends from cached transports don't
      // silently widen access. Persisted pins are always intersected
      // with the currently accessible set so a revoked workspace
      // cannot be re-authorized through a stale stored pin.
      const storedPinsThisRequest =
        thread.type === "existing" && body.contextMatterIds !== undefined
          ? requestedContextMatterIds
          : thread.data.contextMatterIds;
      const effectiveContextMatterIds = intersectAccessibleWorkspaceIds({
        pinnedIds: storedPinsThisRequest,
        accessibleWorkspaceIds,
      });
      if (
        thread.type === "existing" &&
        !workspaceIdsEqual(
          thread.data.contextMatterIds,
          effectiveContextMatterIds,
        )
      ) {
        yield* Result.await(
          safeDb(async (tx) => {
            await tx
              .update(chatThreads)
              .set({ contextMatterIds: effectiveContextMatterIds })
              .where(eq(chatThreads.id, body.threadId));

            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
              resourceId: body.threadId,
              workspaceId,
              changes: {
                contextMatterIds: {
                  old: [...thread.data.contextMatterIds],
                  new: [...effectiveContextMatterIds],
                },
              },
            });
          }),
        );
      }

      const thirdPartyBoundary = createChatThirdPartyBoundary({
        anonymizationScopeId: workspaceId ?? body.threadId,
        organizationId: session.activeOrganizationId,
        scopedDb,
        sendMode: body.sendMode,
        workspaceId: workspaceId ?? undefined,
      });

      if (isClientConnectionAborted()) {
        yield* Result.await(
          rollbackUnpersistedChatSideEffects({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadState: thread,
            uploadedFiles: [],
            userId: user.id,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      const uploadResult = yield* Result.await(
        uploadMessageFilesWithRollback({
          message: validatedMessage.message,
          recordAuditEvent,
          safeDb,
          threadId: thread.data.id,
          threadState: thread,
          userId: user.id,
        }),
      );

      const parsedMessage = parseMessage({
        accessibleWorkspaceIds,
        message: uploadResult.message,
      });

      let messagesForPersistence: ChatThreadState["data"]["messages"] =
        thread.data.messages;
      let deleteMessageIdsBeforeLatest: SafeId<"chatMessage">[] = [];
      // The incoming message normally is new. Outside the truncation path the
      // stored list is a bounded window that may exclude an old re-sent/edited
      // id, so a targeted existence check guards against a duplicate insert.
      let incomingMessageExists = false;
      if (body.truncateAfterMessageId !== undefined) {
        if (parsedMessage.message.id !== body.truncateAfterMessageId) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Truncation target must match the incoming message",
            }),
          );
        }

        // Resolve the target against the full thread history, not the windowed
        // in-memory list: a replay target can be older than the window. The
        // retained prefix is needed to recompute the thread data scope.
        const truncationTarget = yield* Result.await(
          resolveTruncationTarget({
            safeDb,
            threadId: body.threadId,
            targetMessageId: body.truncateAfterMessageId,
          }),
        );
        if (truncationTarget === null) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Truncation target was not found in the chat thread",
            }),
          );
        }

        messagesForPersistence = truncationTarget.messagesForPersistence;
        deleteMessageIdsBeforeLatest =
          truncationTarget.deleteMessageIdsBeforeLatest;
      } else {
        incomingMessageExists = yield* Result.await(
          chatMessageExistsForThread({
            messageId: brandPersistedChatMessageId(parsedMessage.message.id),
            safeDb,
            threadId: body.threadId,
          }),
        );
      }

      const latestMessagePlan = planMessagePersistence({
        message: parsedMessage.message,
        storedMessages: messagesForPersistence,
        incomingMessageExists,
      });
      if (
        body.truncateAfterMessageId !== undefined &&
        latestMessagePlan.persistencePlan.type !== "update"
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Truncation requires updating an existing message",
          }),
        );
      }

      const recomputedDataWorkspaceIds =
        body.truncateAfterMessageId !== undefined
          ? recomputeThreadDataScope({
              accessibleSet,
              baseWorkspaceId: workspaceId,
              messages: latestMessagePlan.messages,
            })
          : null;

      const messagesForContextInput = await selectMessagesForContextInput({
        messages: latestMessagePlan.messages,
        safeDb,
        skipCheckpoint: body.truncateAfterMessageId !== undefined,
        threadId: body.threadId,
      });

      // Metered provider calls must not be directly cancelled by the client
      // connection. A disconnect can arrive after preflight succeeds but before
      // the AI SDK emits token usage; allowing that abort to reach the provider
      // would skip the usage ledger callback while still spending provider work.
      const createMeteredAIAbortSignal = () =>
        AbortSignal.timeout(CHAT_METERED_AI_TIMEOUT_MS);

      if (isClientConnectionAborted()) {
        yield* Result.await(
          rollbackUnpersistedChatSideEffects({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadState: thread,
            uploadedFiles: uploadResult.uploadedFiles,
            userId: user.id,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      const messagesForContextResult = await compactMessagesForContext({
        abortSignal: createMeteredAIAbortSignal(),
        boundary: thirdPartyBoundary,
        chatModelOverride,
        messages: messagesForContextInput,
        organizationId: session.activeOrganizationId,
        orgAIConfig,
        safeDb,
        threadId: body.threadId,
        userId: user.id,
        workspaceId,
      });
      if (Result.isError(messagesForContextResult)) {
        const rollbackResult = await rollbackUnpersistedChatSideEffects({
          recordAuditEvent,
          safeDb,
          threadId: body.threadId,
          threadState: thread,
          uploadedFiles: uploadResult.uploadedFiles,
          userId: user.id,
        });
        if (Result.isError(rollbackResult)) {
          captureError(messagesForContextResult.error, {
            threadId: body.threadId,
          });
          return yield* Result.err(rollbackResult.error);
        }

        return yield* Result.err(messagesForContextResult.error);
      }

      if (isClientConnectionAborted()) {
        yield* Result.await(
          rollbackUnpersistedChatSideEffects({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadState: thread,
            uploadedFiles: uploadResult.uploadedFiles,
            userId: user.id,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      const toolWorkspaceIds = resolveToolWorkspaceIds({
        pinnedIds: effectiveContextMatterIds,
        accessibleWorkspaceIds,
      });
      const registeredDocxEditMode = resolveRegisteredDocxEditMode({
        activeFile: activeFileForTools,
        editApplyMode,
        hasActiveDocxEditClient:
          hasActiveDocxFileClient || body.activeTemplate !== undefined,
        memberRole: memberRole.role,
        recordAuditEventAvailable: true,
        requestWorkspaceId: workspaceId,
        toolWorkspaceIds,
        workspaceStatusById,
      });
      const chatContextResult = await prepareChatContext({
        activeDecision: body.activeDecision,
        activeExternal: body.activeExternal,
        activeFile: body.activeFile,
        activeSkill: body.activeSkill,
        activeTemplate: body.activeTemplate,
        contextMatterIds: effectiveContextMatterIds,
        memberRole,
        messageWindow: messagesForContextResult.value,
        organizationId: session.activeOrganizationId,
        safeDb,
        sendMode: body.sendMode,
        // Derived from the same predicates/inputs `getChatTools` uses to
        // register `web_search`/`fetch_url` and `suggest_template_fields`
        // below, so the prompt only steers the model to tools that are
        // actually handed to it.
        toolAvailability: {
          docxEditMode: registeredDocxEditMode,
          templateAuthoring: areTemplateAuthoringToolsRegistered(
            memberRole.role,
          ),
          webResearch: areWebResearchToolsRegistered({
            webSearchEnabled: thread.data.webSearchEnabled,
            webSearchProviders,
            disabledNativeToolSlugs,
          }),
          folioAgentDocTools: hasActiveDocxFileClient,
          // Only at the top level of a turn, and only when the turn's scope (if
          // any) allows spawn_subagents — a restricted scope (e.g.
          // suggest-template-fields) drops the tool from the streaming set, so
          // the prompt must not steer the model toward a tool it was never handed.
          subagents: areSubagentToolsAvailableForTurn(body.toolScope),
        },
        userContext: body.userContext,
        userId: user.id,
        workspaceId,
        refRegistry,
      });
      if (Result.isError(chatContextResult)) {
        const rollbackResult = await rollbackUnpersistedChatSideEffects({
          recordAuditEvent,
          safeDb,
          threadId: body.threadId,
          threadState: thread,
          uploadedFiles: uploadResult.uploadedFiles,
          userId: user.id,
        });
        if (Result.isError(rollbackResult)) {
          captureError(chatContextResult.error, { threadId: body.threadId });
          return yield* Result.err(rollbackResult.error);
        }

        return yield* Result.err(chatContextResult.error);
      }
      const chatContext = chatContextResult.value;

      if (isClientConnectionAborted()) {
        yield* Result.await(
          rollbackUnpersistedChatSideEffects({
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadState: thread,
            uploadedFiles: uploadResult.uploadedFiles,
            userId: user.id,
          }),
        );
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before AI work started",
          }),
        );
      }

      // Keep the thread's data scope aligned with the messages being
      // stored. Normal sends append newly observed workspace IDs
      // before persisting. Replay truncation recomputes the exact
      // retained scope and writes it in the same transaction as the
      // replay update below.
      //
      // Intersect with `accessibleWorkspaceIds` first: an unknown ID
      // (model hallucination, copy-pasted UUID from elsewhere) added
      // to `data_workspace_ids` would fail the RLS subset check on
      // every subsequent message persist, silently breaking the
      // thread.
      const incomingMessageWorkspaceIds = extractIncomingMessageWorkspaceIds({
        mentions: parsedMessage.mentions,
        message: parsedMessage.message,
      }).filter((id) => accessibleSet.has(id));
      let dataScopeAfterIncomingMessage: SafeId<"workspace">[];
      if (recomputedDataWorkspaceIds !== null) {
        dataScopeAfterIncomingMessage = recomputedDataWorkspaceIds;
      } else {
        dataScopeAfterIncomingMessage = yield* Result.await(
          expandThreadDataScope({
            currentDataWorkspaceIds: thread.data.dataWorkspaceIds,
            newWorkspaceIds: incomingMessageWorkspaceIds,
            recordAuditEvent,
            safeDb,
            threadId: body.threadId,
            threadWorkspaceId: workspaceId,
          }),
        );
      }

      yield* Result.await(
        persistMessage({
          acceptedSendMode: body.sendMode,
          recordAuditEvent,
          safeDb,
          threadId: body.threadId,
          userId: user.id,
          workspaceId,
          persistencePlan: latestMessagePlan.persistencePlan,
          deleteMessageIds: deleteMessageIdsBeforeLatest,
          dataWorkspaceIdsChange:
            recomputedDataWorkspaceIds === null
              ? undefined
              : {
                  oldDataWorkspaceIds: thread.data.dataWorkspaceIds,
                  newDataWorkspaceIds: recomputedDataWorkspaceIds,
                },
        }),
      );

      // The incoming message is durable now, so a disconnect must not run the
      // pre-persistence rollback (which would delete files referenced by that
      // message). It should still stop before connector discovery and any
      // metered provider work.
      if (isClientConnectionAborted()) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Client disconnected before stream started",
          }),
        );
      }

      // The streaming pass always needs the external MCP tool set (for the
      // tool map, the connector system hint, and the `externalMcpToolSource`
      // handed to `streamChat` below). This is the point where discovery
      // actually runs for a message that didn't already trigger it during
      // validation — deferred this far so a request that fails or aborts
      // earlier (malformed parts, thread scope mismatch, upload/compaction
      // failure, client disconnect) never contacts a single connector.
      // `getExternalMcpTools` reuses the validation-triggered load instead
      // of loading again when one already happened.
      const externalMcpTools =
        await externalMcpToolsLoader.getExternalMcpTools();

      // Streaming tools mirror the surface the user is on: only the
      // DOCX file-overlay client knows how to satisfy
      // apply-active-docx-edits (it queues into the review store and
      // sends the output back via TanStack ChatClient.addToolResult).
      // PDF/file overlays
      // still send active-file context, but they must not expose the
      // DOCX edit tool or the model can chase an impossible path. The
      // folio-agents `read_document`/`find_text` tools are narrower
      // still — `hasActiveDocxFileClient` only, since Template Studio
      // mounts no watcher to resolve them.
      const chatTools = getChatTools({
        organizationId: session.activeOrganizationId,
        memberRole: memberRole.role,
        orgAIConfig,
        pinServerValidatedWorkspaceId,
        requestWorkspaceId: workspaceId,
        refRegistry,
        safeDb,
        scopedDb,
        threadId: body.threadId,
        workspaceId,
        thirdPartyBoundary,
        excludedChatHistoryMessageIds: deleteMessageIdsBeforeLatest,
        userId: user.id,
        toolWorkspaceIds,
        activeFile: activeFileForTools,
        hasActiveDocxEditClient:
          hasActiveDocxFileClient || body.activeTemplate !== undefined,
        hasActiveDocxFileClient,
        editApplyMode,
        docxEditRepresentation,
        webSearchEnabled: thread.data.webSearchEnabled,
        webSearchProviders,
        externalTools: externalMcpTools.tools,
        disabledNativeToolSlugs,
        skillMetadata: chatContext.skillMetadata,
        activeSkillContext: chatContext.activeSkillContext,
        recordAuditEvent,
        resolveMemorySourceWorkspaceIds: () =>
          resolveMemorySourceWorkspaceIds({
            accessibleWorkspaceIds: accessibleSet,
            contextMatterIds: effectiveContextMatterIds,
            dataWorkspaceIds: dataScopeAfterIncomingMessage,
            registeredWorkspaceIds: refRegistry.getRegisteredWorkspaceIds(),
            workspaceId,
          }),
        workspaceStatusById,
      });
      // A named scope narrows the streaming turn to its server-defined
      // allowlist (validation above stays broad so persisted tool parts
      // keep validating). The scope name is schema-validated; unknown
      // names never reach this point.
      const streamingTools =
        body.toolScope === undefined
          ? chatTools
          : restrictChatToolsToScope(chatTools, body.toolScope);

      const externalMcpSystemHint = buildExternalMcpSystemHint(
        externalMcpTools.connectors,
      );
      // The "safe" half is whatever the prompt builder declared
      // safe. The anonymized-mode hint is a fixed assembler-owned
      // addition, so callers cannot brand arbitrary strings as safe.
      // The external MCP catalog is organization/user-configured text,
      // so it rides with the dynamic suffix and crosses the boundary in
      // anonymized mode.
      const systemSafe =
        body.sendMode === CHAT_SEND_MODE.anonymized
          ? appendAnonymizedModeHintToChatSafePrompt(chatContext.systemSafe)
          : chatContext.systemSafe;
      const systemUntrusted = extendChatUntrustedPromptSuffix(
        chatContext.systemUntrusted,
        [externalMcpSystemHint],
      );

      // From here, the try/catch below owns closing `externalMcpTools` (on a
      // non-streaming response or a thrown error) or hands it to `streamChat`
      // to close once the actual token stream finishes; the outer `finally`
      // must not close it again. `externalMcpTools` is guaranteed loaded at
      // this point (the `await` above), so `externalMcpToolsLoader.closeIfLoaded`
      // in the outer `finally` would otherwise close the same clients again.
      externalMcpToolsHandedOffToStreaming = true;
      const response = yield* Result.await(
        Result.tryPromise({
          try: async () => {
            try {
              if (isClientConnectionAborted()) {
                throw new HandlerError({
                  status: 400,
                  message: "Client disconnected before stream started",
                });
              }

              // Snapshot the refs the registry already holds before streaming.
              // Prompt-time pins (`contextMatterIds` → `toMatterRef`) are
              // resolved during prompt construction; folding the WHOLE registry
              // into thread scope at onFinish would over-broaden it to pinned-
              // but-never-read matters, which could make the thread unreadable
              // after that matter's access is revoked even though its content was
              // never persisted. Only the delta minted DURING the stream (a
              // matter/entity a tool or subagent actually read) should widen
              // `data_workspace_ids`.
              const workspaceIdsBeforeStream = new Set(
                refRegistry.getRegisteredWorkspaceIds(),
              );

              const chatResponse = await streamChat({
                abortSignal: createMeteredAIAbortSignal(),
                messages: chatContext.hydratedMessages,
                latestMessageId: parsedMessage.message.id,
                onFinish: async ({ isAborted, responseMessage }) => {
                  const resolvedMessages = resolveAssistantMessageRefs({
                    messages: [responseMessage],
                    refRegistry,
                  });
                  const resolvedResponseMessage = resolvedMessages.at(0);
                  if (!resolvedResponseMessage) {
                    panic("Missing chat response message");
                  }

                  const persistencePlan = planAssistantFinishPersistence({
                    existingIds: latestMessagePlan.existingIds,
                    isAborted: isAborted || isClientConnectionAborted(),
                    message: resolvedResponseMessage,
                  });

                  // Skip scope expansion when the assistant message
                  // will not be persisted (aborted stream, planner
                  // returned `none`). Widening `data_workspace_ids`
                  // for transient parts that never land in
                  // `chat_messages` could make the thread unreadable
                  // after future access changes even though no
                  // corresponding content was saved.
                  if (persistencePlan.type === "none") {
                    return;
                  }

                  // Widen the thread's data scope to cover any
                  // workspace-scoped content the assistant just
                  // emitted (source-document parts from search and
                  // workspace tools). Run before persistMessage so
                  // the recorded scope already includes the
                  // workspaces when the message lands in
                  // `chat_messages`.
                  //
                  // If expansion fails (transient DB error, etc.),
                  // SKIP the message persist. Storing workspace-
                  // scoped content in `chat_messages` while the
                  // owning thread's `data_workspace_ids` stays stale
                  // would leave the new content readable after the
                  // user loses access to those workspaces — the same
                  // class of leak this whole change exists to close.
                  //
                  // Intersect with `accessibleWorkspaceIds` so a
                  // hallucinated or stale UUID from the model never
                  // lands in `data_workspace_ids`. An out-of-set ID
                  // would fail the RLS subset check on every later
                  // persist, silently breaking the thread. Also union in the
                  // workspaces the ref registry resolved DURING this stream —
                  // see `computeAssistantTurnWorkspaceIds`'s docstring for why
                  // that delta matters for subagent reads.
                  const assistantWorkspaceIds =
                    computeAssistantTurnWorkspaceIds({
                      responseParts: resolvedResponseMessage.parts,
                      workspaceIdsBeforeStream,
                      registeredWorkspaceIdsAfterStream:
                        refRegistry.getRegisteredWorkspaceIds(),
                      accessibleWorkspaceIds: accessibleSet,
                    });
                  const expandResult = await expandThreadDataScope({
                    currentDataWorkspaceIds: dataScopeAfterIncomingMessage,
                    newWorkspaceIds: assistantWorkspaceIds,
                    recordAuditEvent,
                    safeDb,
                    threadId: body.threadId,
                    threadWorkspaceId: workspaceId,
                  });
                  if (Result.isError(expandResult)) {
                    captureError(expandResult.error, {
                      threadId: body.threadId,
                    });
                    return;
                  }
                  const persistResult = await persistMessage({
                    persistencePlan,
                    recordAuditEvent,
                    safeDb,
                    threadId: body.threadId,
                    userId: user.id,
                    workspaceId,
                  });

                  if (Result.isError(persistResult)) {
                    captureError(persistResult.error, {
                      threadId: body.threadId,
                    });
                  } else {
                    const messagesAfterAssistantPersist =
                      applyAssistantPersistencePlan({
                        messages: latestMessagePlan.messages,
                        persistencePlan,
                      });
                    if (
                      messagesAfterAssistantPersist !== null &&
                      body.sendMode !== CHAT_SEND_MODE.anonymized
                    ) {
                      scheduleChatCompactionCheckpoint({
                        abortSignal: AbortSignal.timeout(
                          CHAT_COMPACTION_CHECKPOINT_TIMEOUT_MS,
                        ),
                        boundary: thirdPartyBoundary,
                        chatModelOverride,
                        messages: messagesAfterAssistantPersist,
                        organizationId: session.activeOrganizationId,
                        orgAIConfig,
                        safeDb,
                        threadId: body.threadId,
                      });
                    }

                    if (
                      thread.type === "created" &&
                      body.sendMode !== CHAT_SEND_MODE.anonymized
                    ) {
                      detached(
                        generateThreadTitle({
                          initialTitle: initialThreadTitle,
                          messages: [
                            parsedMessage.message,
                            resolvedResponseMessage,
                          ],
                          organizationId: session.activeOrganizationId,
                          orgAIConfig,
                          promptCachingEnabled,
                          recordAuditEvent,
                          safeDb,
                          threadId: body.threadId,
                          threadWorkspaceId: workspaceId,
                          userId: user.id,
                        }),
                        "onFinish",
                      );
                    }
                  }
                },
                orgAIConfig,
                organizationId: session.activeOrganizationId,
                devModelId: chatModelOverride,
                promptCacheKey: chatContext.promptCacheKey,
                promptCachingEnabled,
                resolveAssistantTextRefs: refRegistry.resolveAssistantTextRefs,
                resolveAssistantValueRefs:
                  refRegistry.resolveAssistantValueRefs,
                safeDb,
                thirdPartyBoundary,
                threadId: body.threadId,
                tools: streamingTools,
                externalMcpToolSource: externalMcpTools.source,
                systemSafe,
                systemUntrusted,
                userId: user.id,
                workspaceId,
              });

              if (!isChatStreamResponse(chatResponse)) {
                await externalMcpTools.close();
              }

              return chatResponse;
            } catch (error) {
              await externalMcpTools.close();
              throw error;
            }
          },
          catch: (cause) =>
            cause instanceof HandlerError
              ? cause
              : new HandlerError({
                  status: 500,
                  message: "Failed to start chat response",
                  cause,
                }),
        }),
      );

      return Result.ok(response);
    } finally {
      // No-op if `getExternalMcpTools` was never called on this exit path
      // (the message needed neither validation nor streaming to load
      // external tools before failing/returning early).
      if (!externalMcpToolsHandedOffToStreaming) {
        await externalMcpToolsLoader.closeIfLoaded();
      }
    }
  },
);

export default sendMessage;

type ChatCompactionModelProps = {
  /** Effective chat model override for this turn; see `resolveEffectiveChatModelId`. */
  chatModelOverride: string | undefined;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
};

type CompactMessagesForContextProps = ChatCompactionModelProps & {
  abortSignal: AbortSignal;
  boundary: ReturnType<typeof createChatThirdPartyBoundary>;
  messages: ChatMessage[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type SelectMessagesForContextInputProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  skipCheckpoint: boolean;
  threadId: SafeId<"chatThread">;
};

const selectMessagesForContextInput = async ({
  messages,
  safeDb,
  skipCheckpoint,
  threadId,
}: SelectMessagesForContextInputProps): Promise<ChatMessage[]> => {
  if (skipCheckpoint) {
    return messages;
  }

  const checkpointResult = await readLatestChatCompaction({
    safeDb,
    threadId,
  });
  if (Result.isError(checkpointResult)) {
    captureError(checkpointResult.error, {
      threadId,
      feature: "chat.compaction_checkpoint_read",
    });
    return messages;
  }

  if (checkpointResult.value === null) {
    return messages;
  }

  return (
    applyChatCompactionCheckpoint({
      checkpoint: checkpointResult.value,
      messages,
    }) ?? messages
  );
};

const compactMessagesForContext = async ({
  abortSignal,
  boundary,
  chatModelOverride,
  messages,
  organizationId,
  orgAIConfig,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: CompactMessagesForContextProps): Promise<
  Result<ChatMessage[], HandlerError>
> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId,
    },
    feature: "chat.context_compaction",
    modelRole: "chat",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    },
    sessionId: threadId,
    traceId: Bun.randomUUIDv7(),
  });

  const { triggerTokens, preserveTokens } = resolveChatCompactionBudget({
    chatModelOverride,
    orgAIConfig,
    organizationId,
  });

  return await compactChatMessagesForModel({
    abortSignal,
    aiAnalytics,
    boundary,
    messages,
    modelId: chatModelOverride,
    onSummaryError: (error) => {
      captureError(error, {
        threadId,
        feature: "chat.compaction",
      });
    },
    organizationId,
    orgAIConfig,
    preserveTokens,
    triggerTokens,
  });
};

type ApplyAssistantPersistencePlanProps = {
  messages: PersistableChatMessage[];
  persistencePlan: MessagePersistencePlan;
};

const applyAssistantPersistencePlan = ({
  messages,
  persistencePlan,
}: ApplyAssistantPersistencePlanProps): PersistableChatMessage[] | null => {
  switch (persistencePlan.type) {
    case "none":
      return null;
    case "insert":
      return [...messages, persistencePlan.message];
    case "update":
      return messages.map((message) =>
        message.id === persistencePlan.messageId
          ? persistencePlan.message
          : message,
      );
    case "replace-last-assistant":
      return [
        ...messages.filter(
          (message) => message.id !== persistencePlan.deleteMessageId,
        ),
        persistencePlan.insertMessage,
      ];
    default: {
      const exhaustive: never = persistencePlan;
      return exhaustive;
    }
  }
};

type ScheduleChatCompactionCheckpointProps = ChatCompactionModelProps & {
  abortSignal: AbortSignal;
  boundary: ReturnType<typeof createChatThirdPartyBoundary>;
  messages: ChatMessage[];
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

const scheduleChatCompactionCheckpoint = ({
  abortSignal,
  boundary,
  chatModelOverride,
  messages,
  organizationId,
  orgAIConfig,
  safeDb,
  threadId,
}: ScheduleChatCompactionCheckpointProps): void => {
  const { triggerTokens, preserveTokens } = resolveChatCompactionBudget({
    chatModelOverride,
    orgAIConfig,
    organizationId,
  });

  // Cheap token-estimate gate over the per-send window. For non-anonymized
  // threads (the only ones that schedule a checkpoint) the window now holds the
  // full pre-checkpoint history, so it accurately signals whether compaction is
  // due; the common case is under the trigger and issues no full-history read.
  if (!shouldCompactChatMessages(messages, triggerTokens)) {
    return;
  }

  detached(
    runChatCompactionCheckpoint({
      abortSignal,
      boundary,
      chatModelOverride,
      organizationId,
      orgAIConfig,
      preserveTokens,
      safeDb,
      threadId,
      triggerTokens,
    }).catch((error: unknown) => {
      captureError(error, {
        threadId,
        feature: "chat.compaction_checkpoint_persist",
      });
    }),
    "scheduleChatCompactionCheckpoint",
  );
};

type RunChatCompactionCheckpointProps = ChatCompactionModelProps & {
  abortSignal: AbortSignal;
  boundary: ReturnType<typeof createChatThirdPartyBoundary>;
  preserveTokens: number;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  triggerTokens: number;
};

const runChatCompactionCheckpoint = async ({
  abortSignal,
  boundary,
  chatModelOverride,
  organizationId,
  orgAIConfig,
  preserveTokens,
  safeDb,
  threadId,
  triggerTokens,
}: RunChatCompactionCheckpointProps): Promise<void> => {
  // Summarize from the true start of the conversation. The window passed to
  // the gate above is enough to know a checkpoint is due, but the durable
  // summary must cover the full unsummarized prefix [0..newFirstKept] with
  // real boundary message ids, or context summarized into an earlier
  // checkpoint would be silently dropped. Never feed a synthetic compaction
  // summary message here: its id is not a real chat_messages row and would
  // violate the firstKept/firstSummarized FKs.
  const dataScopeResult = await safeDb((tx) =>
    tx.query.chatThreads.findFirst({
      where: { id: { eq: threadId } },
      columns: { dataWorkspaceIds: true },
    }),
  );
  if (Result.isError(dataScopeResult)) {
    captureError(dataScopeResult.error, {
      threadId,
      feature: "chat.compaction_checkpoint_data_scope",
    });
    return;
  }
  if (!dataScopeResult.value) {
    return;
  }

  const historyResult = await loadFullThreadHistory({ safeDb, threadId });
  if (Result.isError(historyResult)) {
    captureError(historyResult.error, {
      threadId,
      feature: "chat.compaction_checkpoint_history",
    });
    return;
  }

  const persistResult = await persistChatCompactionCheckpoint({
    abortSignal,
    boundary,
    dataWorkspaceIds: dataScopeResult.value.dataWorkspaceIds,
    messages: historyResult.value,
    modelId: chatModelOverride,
    onSummaryError: (error) => {
      captureError(error, {
        threadId,
        feature: "chat.compaction_checkpoint_summary",
      });
    },
    organizationId,
    orgAIConfig,
    preserveTokens,
    safeDb,
    threadId,
    triggerTokens,
  });
  if (Result.isError(persistResult)) {
    captureError(persistResult.error, {
      threadId,
      feature: "chat.compaction_checkpoint_persist",
    });
  }
};

const isChatStreamResponse = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  return contentType !== null && contentType.includes("text/event-stream");
};

const messageNeedsExternalMcpValidation = (
  message: ChatSendRequest["message"],
): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(isExternalMcpToolPart);
};

/**
 * Loads external MCP tools (via the memoized `loader`) only when the
 * incoming message needs them for validation; returns `undefined` without
 * ever calling the loader otherwise. Kept as a standalone helper so its
 * branch doesn't add to the handler generator's own cognitive complexity.
 */
const resolveExternalToolsForValidation = async (
  message: ChatSendRequest["message"],
  loader: LazyExternalMcpToolsLoader,
): Promise<LoadedExternalMcpTools["tools"] | undefined> => {
  if (!messageNeedsExternalMcpValidation(message)) {
    return undefined;
  }
  const loaded = await loader.getExternalMcpTools();
  return loaded.tools;
};

type PrepareChatContextProps = {
  activeDecision: IncomingActiveDecision | undefined;
  activeExternal: IncomingActiveExternal | undefined;
  activeFile: IncomingActiveFile | undefined;
  activeSkill: IncomingActiveSkill | undefined;
  activeTemplate: IncomingActiveTemplate | undefined;
  contextMatterIds: SafeId<"workspace">[];
  memberRole: { role: string };
  messageWindow: ChatMessage[];
  organizationId: SafeId<"organization">;
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  safeDb: SafeDb;
  sendMode: ChatSendMode;
  toolAvailability: ChatToolAvailability;
  userContext: IncomingUserContext | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type PrepareChatContextResult = Result<
  {
    hydratedMessages: ChatMessage[];
    promptCacheKey: string;
    /**
     * Server-built scaffold. Safe to send to the LLM verbatim.
     */
    systemSafe: ChatSafePrompt;
    /**
     * Dynamic user-supplied context (active file body, decision
     * text, external source, matter labels). Pass through the
     * boundary in anonymized mode before concatenating with
     * `systemSafe`.
     */
    systemUntrusted: ChatUntrustedPromptSuffix;
    skillMetadata: readonly SkillMetadata[];
    activeSkillContext: ActiveChatSkillContext | null;
  },
  HandlerError<403 | 404 | 422 | 500> | SafeDbError
>;

const prepareChatContext = async ({
  activeDecision,
  activeExternal,
  activeFile,
  activeSkill,
  activeTemplate,
  contextMatterIds,
  memberRole,
  messageWindow,
  organizationId,
  refRegistry,
  safeDb,
  sendMode,
  toolAvailability,
  userContext,
  userId,
  workspaceId,
}: PrepareChatContextProps): Promise<PrepareChatContextResult> =>
  await Result.gen(async function* () {
    const orgSettingsRow = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { practiceJurisdictions: true },
        }),
      ),
    );
    const practiceJurisdictions = normalizeOptionalArray(
      orgSettingsRow?.practiceJurisdictions,
    );

    const [systemResult, hydratedMessagesResult] = await Promise.all([
      buildChatSystemPromptParts({
        activeDecision,
        activeExternal,
        activeFile,
        activeSkill,
        activeTemplate,
        contextMatterIds,
        memberRole,
        organizationId,
        practiceJurisdictions,
        refRegistry,
        safeDb,
        toolAvailability,
        userContext,
        userId,
        workspaceId,
      }),
      hydrateMessages({
        messages: messageWindow,
        safeDb,
        sendMode,
        userId,
      }),
    ]);
    const systemPrompt = yield* systemResult;
    const hydratedMessages = yield* hydratedMessagesResult.mapError((error) =>
      ChatError.is(error)
        ? new HandlerError({
            status: 500,
            message: error.message,
            cause: error,
          })
        : error,
    );

    const messagesWithActiveFileFallback = yield* Result.await(
      attachActivePdfWhenExtractionIsEmpty({
        activeFile,
        hydratedMessages,
        organizationId,
        safeDb,
        sendMode,
        workspaceId,
      }),
    );

    return Result.ok({
      promptCacheKey: buildChatPromptCacheKey(systemPrompt.cacheStablePrefix),
      systemSafe: systemPrompt.safePrompt,
      systemUntrusted: systemPrompt.untrustedSuffix,
      skillMetadata: systemPrompt.skillMetadata,
      activeSkillContext: systemPrompt.activeSkillContext,
      hydratedMessages: hydrateAssistantMessageRefs({
        messages: messagesWithActiveFileFallback,
        refRegistry,
      }),
    });
  });

type AttachActivePdfWhenExtractionIsEmptyProps = {
  activeFile: IncomingActiveFile | undefined;
  hydratedMessages: ChatMessage[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  sendMode: ChatSendMode;
  workspaceId: SafeId<"workspace"> | null;
};

const attachActivePdfWhenExtractionIsEmpty = async ({
  activeFile,
  hydratedMessages,
  organizationId,
  safeDb,
  sendMode,
  workspaceId,
}: AttachActivePdfWhenExtractionIsEmptyProps): Promise<
  Result<ChatMessage[], HandlerError<422 | 500> | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (
      sendMode !== CHAT_SEND_MODE.rawOverride ||
      workspaceId === null ||
      activeFile?.fileFieldId === undefined ||
      activeFile.supportsDocxEdits === true
    ) {
      return Result.ok(hydratedMessages);
    }

    const latestUserIndex = hydratedMessages.findLastIndex(
      (message) => message.role === "user",
    );
    if (latestUserIndex === -1) {
      return Result.ok(hydratedMessages);
    }

    const extracted = yield* Result.await(
      safeDb((tx) =>
        tx.query.extractedContent.findFirst({
          where: {
            entityId: { eq: activeFile.entityId },
            organizationId: { eq: organizationId },
            workspaceId: { eq: workspaceId },
          },
          columns: { charCount: true },
        }),
      ),
    );
    if (extracted && extracted.charCount > 0) {
      return Result.ok(hydratedMessages);
    }

    const activePdf = yield* Result.await(
      readActivePdfForModel({
        activeFile,
        fileFieldId: activeFile.fileFieldId,
        organizationId,
        safeDb,
        workspaceId,
      }),
    );
    if (activePdf === null) {
      return Result.ok(hydratedMessages);
    }

    const nextMessages = [...hydratedMessages];
    const latestUserMessage = hydratedMessages.at(latestUserIndex);
    if (!latestUserMessage) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to find user message for context attachment",
        }),
      );
    }
    nextMessages[latestUserIndex] = {
      ...latestUserMessage,
      parts: [
        ...latestUserMessage.parts,
        {
          type: "text",
          content: `The active file "${activePdf.fileName}" is attached directly as a PDF because stella has no extracted text for it. Use the attached PDF itself for this question.`,
        },
        createRawChatFilePart({
          bytes: activePdf.bytes,
          fileName: activePdf.fileName,
          mimeType: PDF_MIME_TYPE,
        }),
      ],
    };

    return Result.ok(nextMessages);
  });

type ReadActivePdfForModelProps = {
  activeFile: IncomingActiveFile;
  fileFieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

type ActivePdfForModel = {
  bytes: Uint8Array;
  fileName: string;
};

const readActivePdfForModel = async ({
  activeFile,
  fileFieldId,
  organizationId,
  safeDb,
  workspaceId,
}: ReadActivePdfForModelProps): Promise<
  Result<ActivePdfForModel | null, HandlerError<422 | 500> | SafeDbError>
> =>
  await Result.gen(async function* () {
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: activeFile.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
          with: {
            currentVersion: {
              columns: {},
              with: {
                fields: {
                  columns: {
                    content: true,
                    id: true,
                  },
                },
              },
            },
          },
        }),
      ),
    );
    const field = entity?.currentVersion?.fields.find(
      (candidate) => candidate.id === fileFieldId,
    );
    const content = field?.content;
    if (content?.type !== "file") {
      return Result.ok(null);
    }

    const pdfRef = getPdfFileRefForModel(content);
    if (pdfRef === null || content.encrypted) {
      return Result.ok(null);
    }

    const s3Key = createFileKey({
      organizationId,
      workspaceId,
      fileId: pdfRef.fileId,
      mimeType: PDF_MIME_TYPE,
    });
    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => await getS3().file(s3Key).arrayBuffer(),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to read active PDF for AI context",
            cause,
          }),
      }),
    );
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > FILE_SIZE_LIMIT_BYTES.chatContextFile) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `Active PDF exceeds the ${FILE_SIZE_LIMITS.chatContextFile} chat context limit`,
        }),
      );
    }

    return Result.ok({
      bytes,
      fileName: pdfRef.fileName,
    });
  });

const getPdfFileRefForModel = (
  content: Extract<FieldContent, { type: "file" }>,
): { fileId: string; fileName: string } | null => {
  if (content.mimeType === PDF_MIME_TYPE) {
    return {
      fileId: content.id,
      fileName: content.fileName,
    };
  }

  if (content.pdfFileId === null) {
    return null;
  }

  return {
    fileId: content.pdfFileId,
    fileName: content.fileName,
  };
};

type InsertMessagesProps = {
  acceptedSendMode: ChatSendMode | null;
  messages: PersistableChatMessage[];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type ResolveAssistantMessageRefsProps = {
  messages: PersistableChatMessage[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
};

const resolveAssistantMessageRefs = ({
  messages,
  refRegistry,
}: ResolveAssistantMessageRefsProps): PersistableChatMessage[] => {
  const resolvePart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] => {
    const resolved = refRegistry.resolveAssistantValueRefs(part);
    if (!isChatMessagePart(resolved)) {
      panic("Resolving assistant refs changed the message part shape");
    }
    return resolved;
  };

  return messages.map((message) =>
    message.role === "assistant"
      ? {
          ...message,
          parts: message.parts.map(resolvePart),
        }
      : message,
  );
};

type HydrateAssistantMessageRefsProps = {
  messages: ChatMessage[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
};

const hydrateAssistantMessageRefs = ({
  messages,
  refRegistry,
}: HydrateAssistantMessageRefsProps): ChatMessage[] => {
  const hydratePart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] => {
    const hydrated = refRegistry.hydrateAssistantValueRefs(part);
    if (!isChatMessagePart(hydrated)) {
      panic("Hydrating assistant refs changed the message part shape");
    }
    return hydrated;
  };

  return messages.map((message) =>
    message.role === "assistant"
      ? {
          ...message,
          parts: message.parts.map(hydratePart),
        }
      : message,
  );
};

const isChatMessagePart = (
  value: unknown,
): value is ChatMessage["parts"][number] =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const insertMessages = async ({
  acceptedSendMode,
  messages,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
}: InsertMessagesProps): Promise<Result<void, SafeDbError>> => {
  if (messages.length === 0) {
    return Result.ok();
  }

  const insertResult = await safeDb(async (tx) => {
    await tx.insert(chatMessages).values(
      messages.map((persistedMessage) => ({
        id: persistedMessage.id,
        threadId,
        workspaceId,
        userId,
        role: persistedMessage.role,
        content: chatMessageContentFromMessage(persistedMessage),
      })),
    );
    await tx
      .update(chatThreads)
      .set({
        updatedAt: new Date(),
        ...(shouldMarkThreadUsedAnonymization({
          messages,
          sendMode: acceptedSendMode,
        })
          ? { usedAnonymization: true }
          : {}),
      })
      .where(eq(chatThreads.id, threadId));

    await recordAuditEvent(
      tx,
      messages.map((persistedMessage) => ({
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: persistedMessage.id,
        workspaceId,
        metadata: { threadId, role: persistedMessage.role },
      })),
    );
  });

  return insertResult.andThen(() => Result.ok());
};

type PersistMessageProps = {
  acceptedSendMode?: ChatSendMode | null;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  persistencePlan: MessagePersistencePlan;
  deleteMessageIds?: SafeId<"chatMessage">[];
  dataWorkspaceIdsChange?:
    | {
        oldDataWorkspaceIds: readonly SafeId<"workspace">[];
        newDataWorkspaceIds: SafeId<"workspace">[];
      }
    | undefined;
};

const persistMessage = async (props: PersistMessageProps) => {
  const result = await runPersistMessage(props);
  // Refresh the thread's global-search document whenever its messages
  // actually changed. Fire-and-forget: indexing must never block or
  // fail a chat turn.
  if (Result.isOk(result) && props.persistencePlan.type !== "none") {
    upsertChatThreadSearchDocument(props.threadId).catch(captureError);
  }
  return result;
};

const runPersistMessage = async ({
  acceptedSendMode = null,
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
  persistencePlan,
  deleteMessageIds = [],
  dataWorkspaceIdsChange,
}: PersistMessageProps) => {
  if (persistencePlan.type === "insert") {
    return await insertMessages({
      acceptedSendMode,
      messages: [persistencePlan.message],
      recordAuditEvent,
      safeDb,
      threadId,
      userId,
      workspaceId,
    });
  }

  if (persistencePlan.type === "update") {
    const updateResult = await safeDb(async (tx) => {
      if (deleteMessageIds.length > 0) {
        await tx
          .delete(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, threadId),
              inArray(chatMessages.id, deleteMessageIds),
            ),
          );

        for (const deletedMessageId of deleteMessageIds) {
          // oxlint-disable-next-line no-await-in-loop -- sequential audit writes on the same transaction connection (one in-flight query per tx)
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: deletedMessageId,
            workspaceId,
            metadata: { threadId, reason: "truncate_for_replay" },
          });
        }
      }

      if (
        shouldInvalidateChatCompactionCheckpoint({
          deletedMessageCount: deleteMessageIds.length,
          persistencePlan,
        })
      ) {
        await markActiveChatCompactionCheckpointStale({ threadId, tx });
      }

      const updatedMessageId = persistencePlan.messageId;
      await tx
        .update(chatMessages)
        .set({
          role: persistencePlan.message.role,
          content: chatMessageContentFromMessage(persistencePlan.message),
        })
        .where(eq(chatMessages.id, updatedMessageId));
      await tx
        .update(chatThreads)
        .set({
          updatedAt: new Date(),
          ...(dataWorkspaceIdsChange === undefined
            ? {}
            : { dataWorkspaceIds: dataWorkspaceIdsChange.newDataWorkspaceIds }),
          ...(shouldMarkThreadUsedAnonymization({
            messages: [persistencePlan.message],
            sendMode: acceptedSendMode,
          })
            ? { usedAnonymization: true }
            : {}),
        })
        .where(eq(chatThreads.id, threadId));

      if (
        dataWorkspaceIdsChange !== undefined &&
        !workspaceIdsEqual(
          dataWorkspaceIdsChange.oldDataWorkspaceIds,
          dataWorkspaceIdsChange.newDataWorkspaceIds,
        )
      ) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: threadId,
          workspaceId,
          changes: {
            dataWorkspaceIds: {
              old: [...dataWorkspaceIdsChange.oldDataWorkspaceIds],
              new: [...dataWorkspaceIdsChange.newDataWorkspaceIds],
            },
          },
        });
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: updatedMessageId,
        workspaceId,
        metadata: { threadId, role: persistencePlan.message.role },
      });
    });

    return updateResult.andThen(() => Result.ok());
  }

  if (persistencePlan.type === "none") {
    return Result.ok();
  }

  return await Result.gen(async function* () {
    const deletedMessageId = persistencePlan.deleteMessageId;
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(chatMessages)
          .where(and(eq(chatMessages.id, deletedMessageId)));

        if (
          shouldInvalidateChatCompactionCheckpoint({
            deletedMessageCount: 1,
            persistencePlan,
          })
        ) {
          await markActiveChatCompactionCheckpointStale({ threadId, tx });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: deletedMessageId,
          workspaceId,
          metadata: { threadId, reason: "delete_and_reinsert" },
        });
      }),
    );

    yield* Result.await(
      insertMessages({
        acceptedSendMode,
        messages: [persistencePlan.insertMessage],
        recordAuditEvent,
        safeDb,
        threadId,
        userId,
        workspaceId,
      }),
    );

    return Result.ok();
  });
};

type RecomputeThreadDataScopeProps = {
  accessibleSet: ReadonlySet<string>;
  baseWorkspaceId: SafeId<"workspace"> | null;
  messages: readonly ChatMessage[];
};

const recomputeThreadDataScope = ({
  accessibleSet,
  baseWorkspaceId,
  messages,
}: RecomputeThreadDataScopeProps): SafeId<"workspace">[] => {
  const ids = new Set<SafeId<"workspace">>();
  if (baseWorkspaceId !== null && accessibleSet.has(baseWorkspaceId)) {
    ids.add(baseWorkspaceId);
  }
  for (const id of extractThreadDataWorkspaceIds(messages)) {
    if (accessibleSet.has(id)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

const workspaceIdsEqual = (
  a: readonly SafeId<"workspace">[],
  b: readonly SafeId<"workspace">[],
): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set<string>(a);
  return b.every((id) => set.has(id));
};
