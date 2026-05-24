import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import type { Static } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";
import type { SkillMetadata } from "@stll/skills";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import {
  buildChatPromptCacheKey,
  buildChatSystemPromptParts,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
  IncomingActiveDecision,
  IncomingActiveExternal,
  IncomingActiveFile,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import {
  parseMessage,
  sendMessageBodySchema,
  validateMessage,
} from "@/api/handlers/chat/chat-schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import {
  expandThreadDataScope,
  extractAssistantWorkspaceIds,
  extractIncomingMessageWorkspaceIds,
} from "@/api/handlers/chat/data-scope";
import { ChatError } from "@/api/handlers/chat/errors";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import { isExternalMcpToolPart } from "@/api/handlers/chat/mcp-tool-parts";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import {
  planAssistantFinishPersistence,
  planMessagePersistence,
} from "@/api/handlers/chat/persist-message";
import { hydrateMessages, streamChat } from "@/api/handlers/chat/stream-chat";
import {
  buildAnonymizedSystemHint,
  createChatThirdPartyBoundary,
} from "@/api/handlers/chat/third-party-boundary";
import {
  intersectAccessibleWorkspaceIds,
  resolveToolWorkspaceIds,
} from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import {
  buildExternalMcpSystemHint,
  loadExternalMcpToolsForUser,
} from "@/api/handlers/chat/tools/external-mcp-tools";
import type {
  ChatMessage,
  ChatMessageContent,
} from "@/api/handlers/chat/types";
import {
  createRawChatFilePart,
  deleteUploadedChatFiles,
  uploadMessageFiles,
} from "@/api/handlers/chat/upload-files";
import type { UploadedChatFile } from "@/api/handlers/chat/upload-files";
import { createFileKey } from "@/api/handlers/files/utils";
import { getDisabledNativeToolSlugs } from "@/api/handlers/mcp-connectors/catalog-metadata";
import {
  requireAIAvailable,
  validateDevModelOverride,
} from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const config = {
  permissions: { chat: ["create"] },
  body: sendMessageBodySchema,
} satisfies HandlerConfig;

const MESSAGE_WINDOW = 20;

const sendMessage = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    body,
    orgAIConfig,
    recordAuditEvent,
    request,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    yield* requireAIAvailable(orgAIConfig);

    if (body.devModelId && !env.isDev) {
      return yield* Result.err(
        new HandlerError({
          status: 400,
          message: "Dev model overrides are only available locally.",
        }),
      );
    }
    if (body.devModelId) {
      yield* validateDevModelOverride(body.devModelId, orgAIConfig);
    }

    const accessibleWorkspaceIds = activeWorkspaceIds;
    /* eslint-disable no-body-ownership-ids/no-body-ownership-ids -- root handler; resolveChatScope validates against accessibleWorkspaceIds */
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds,
      workspaceId: body.workspaceId,
    });
    /* eslint-enable no-body-ownership-ids/no-body-ownership-ids */

    const workspaceId = scope.scope === "workspace" ? scope.workspaceId : null;

    // The body's contextMatterIds is the AI's "draw-from" set —
    // distinct from the chat's own scope (workspaceId/global). It
    // may include the chat's matter plus any others the user wants
    // in scope, validated against the user's accessible matters.
    // Empty (or omitted) means "no matters pinned" — the AI is
    // expected to discover relevant matters via the readonly
    // Stella API instead of being preloaded with thousands of IDs.
    const requestedContextMatterIds = body.contextMatterIds ?? [];
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
    const validationExternalMcpTools = messageNeedsExternalMcpValidation(
      body.message,
    )
      ? await loadExternalMcpToolsForUser({
          organizationId: session.activeOrganizationId,
          safeDb,
          userId: user.id,
        })
      : null;

    // Tool input schemas don't depend on `accessibleWorkspaceIds`
    // (scope is checked at execute time, not in the schema), so we
    // can validate the incoming message against the broad set and
    // then rebuild the tools with the narrowed `effective` set
    // before streaming. This lets the picker's scope actually
    // govern tool authorization rather than just being persisted.
    // Validation tools must include every tool that COULD have
    // been called in this thread's history, otherwise valibot
    // rejects past tool messages. Use the broadest set (always
    // include the active-DOCX-edit tool).
    const validationTools = getChatTools({
      organizationId: session.activeOrganizationId,
      refRegistry,
      safeDb,
      scopedDb,
      userId: user.id,
      // Schema validation runs against the user's full accessible
      // set; per-tool scope checks happen at execute time below.
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds,
      }),
      hasActiveFileChat: true,
      // Validation tools must include every tool that could have been
      // called in this thread's history. Web search is per-thread
      // opt-in for live execution, but past tool messages from a
      // previously-toggled-on session must still pass schema validation.
      webSearchEnabled: true,
      externalTools: validationExternalMcpTools?.tools,
    });

    const validatedMessageResult = await validateMessage({
      message: body.message,
      safeDb,
      threadId: body.threadId,
      tools: validationTools,
      userId: user.id,
    });
    await validationExternalMcpTools?.close();
    if (Result.isError(validatedMessageResult)) {
      return Result.err(validatedMessageResult.error);
    }
    const validatedMessage = validatedMessageResult.value;

    const thread = yield* Result.await(
      loadThread({
        initialContextMatterIds: requestedContextMatterIds,
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
        safeDb,
        threadId: body.threadId,
        title: extractTitle(validatedMessage.message.parts),
        userId: user.id,
        workspaceId,
      }),
    );

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
      !contextMatterIdsEqual(
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

    const latestMessagePlan = planMessagePersistence({
      message: parsedMessage.message,
      storedMessages: thread.data.messages,
    });

    const messageWindow = latestMessagePlan.messages.slice(-MESSAGE_WINDOW);
    const chatContextResult = await prepareChatContext({
      activeDecision: body.activeDecision,
      activeExternal: body.activeExternal,
      activeFile: body.activeFile,
      contextMatterIds: effectiveContextMatterIds,
      messageWindow,
      organizationId: session.activeOrganizationId,
      safeDb,
      sendMode: body.sendMode,
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

    // Widen the thread's data scope BEFORE persisting the incoming
    // message so any workspace IDs it embeds are recorded on the
    // thread row. User messages can embed entity/workspace mentions;
    // assistant updates can embed client-executed tool outputs such
    // as create-document results. Without this, a global thread
    // could store workspace-scoped content while its data scope
    // remains stale.
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
    const dataScopeAfterIncomingMessage = yield* Result.await(
      expandThreadDataScope({
        currentDataWorkspaceIds: thread.data.dataWorkspaceIds,
        newWorkspaceIds: incomingMessageWorkspaceIds,
        recordAuditEvent,
        safeDb,
        threadId: body.threadId,
        threadWorkspaceId: workspaceId,
      }),
    );

    yield* Result.await(
      persistMessage({
        recordAuditEvent,
        safeDb,
        threadId: body.threadId,
        userId: user.id,
        workspaceId,
        persistencePlan: latestMessagePlan.persistencePlan,
      }),
    );

    const externalMcpTools = await loadExternalMcpToolsForUser({
      organizationId: session.activeOrganizationId,
      safeDb,
      userId: user.id,
    });
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
      practiceJurisdictions: orgSettingsForChat?.practiceJurisdictions ?? [],
      nativeToolOverrides: orgSettingsForChat?.nativeToolOverrides ?? {},
    });
    // Streaming tools mirror the surface the user is on: only the
    // DOCX file-overlay client knows how to satisfy
    // apply-active-docx-edits (it queues into the review store and
    // sends the output back via addToolOutput). PDF/file overlays
    // still send active-file context, but they must not expose the
    // DOCX edit tool or the model can chase an impossible path.
    const chatTools = getChatTools({
      organizationId: session.activeOrganizationId,
      refRegistry,
      safeDb,
      scopedDb,
      userId: user.id,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: effectiveContextMatterIds,
        accessibleWorkspaceIds,
      }),
      hasActiveFileChat: body.activeFile?.supportsDocxEdits === true,
      webSearchEnabled: thread.data.webSearchEnabled,
      externalTools: externalMcpTools.tools,
      disabledNativeToolSlugs,
      skillMetadata: chatContext.skillMetadata,
    });

    const externalMcpSystemHint = buildExternalMcpSystemHint(
      externalMcpTools.connectors,
    );
    const anonymizedSystemHint =
      body.sendMode === CHAT_SEND_MODE.anonymized
        ? buildAnonymizedSystemHint()
        : null;
    // The "safe" half is whatever the prompt builder declared
    // safe plus our own static anonymized-mode instructions. The
    // external MCP catalog is organization/user-configured text, so
    // it rides with the dynamic suffix and crosses the boundary in
    // anonymized mode.
    const systemSafe = [chatContext.systemSafe, anonymizedSystemHint]
      .filter((part): part is string => part !== null && part.length > 0)
      .join("\n\n");
    const systemUntrusted = [chatContext.systemUntrusted, externalMcpSystemHint]
      .filter((part) => part.length > 0)
      .join("\n\n");
    let externalMcpToolsClosed = false;
    const closeExternalMcpTools = async () => {
      if (externalMcpToolsClosed) {
        return;
      }

      externalMcpToolsClosed = true;
      await externalMcpTools.close();
    };

    const response = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          try {
            const chatResponse = await streamChat({
              abortSignal: request.signal,
              messages: chatContext.hydratedMessages,
              latestMessageId: parsedMessage.message.id,
              onFinish: async ({ isAborted, responseMessage }) => {
                try {
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
                    isAborted,
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
                  // persist, silently breaking the thread.
                  const assistantWorkspaceIds = extractAssistantWorkspaceIds(
                    resolvedResponseMessage.parts,
                  ).filter((id) => accessibleSet.has(id));
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
                  } else if (
                    thread.type === "created" &&
                    body.sendMode !== CHAT_SEND_MODE.anonymized
                  ) {
                    void generateThreadTitle({
                      messages: [
                        parsedMessage.message,
                        resolvedResponseMessage,
                      ],
                      orgAIConfig,
                      recordAuditEvent,
                      safeDb,
                      threadId: body.threadId,
                      threadWorkspaceId: workspaceId,
                    });
                  }
                } finally {
                  await closeExternalMcpTools();
                }
              },
              orgAIConfig,
              devModelId: body.devModelId,
              promptCacheKey: chatContext.promptCacheKey,
              resolveAssistantTextRefs: refRegistry.resolveAssistantTextRefs,
              resolveAssistantValueRefs: refRegistry.resolveAssistantValueRefs,
              thirdPartyBoundary,
              threadId: body.threadId,
              tools: chatTools,
              systemSafe,
              systemUntrusted,
            });

            if (!isChatStreamResponse(chatResponse)) {
              await closeExternalMcpTools();
            }

            return chatResponse;
          } catch (error) {
            await closeExternalMcpTools();
            throw error;
          }
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to start chat response",
            cause,
          }),
      }),
    );

    return Result.ok(response);
  },
);

export default sendMessage;

const isChatStreamResponse = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  return contentType !== null && contentType.includes("text/event-stream");
};

const messageNeedsExternalMcpValidation = (
  message: Static<typeof sendMessageBodySchema>["message"],
): boolean => {
  if (message.role !== "assistant") {
    return false;
  }

  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(isExternalMcpToolPart);
};

type ThreadRecord = {
  id: SafeId<"chatThread">;
  workspaceId: SafeId<"workspace"> | null;
  contextMatterIds: SafeId<"workspace">[];
  dataWorkspaceIds: SafeId<"workspace">[];
  webSearchEnabled: boolean;
  messages: {
    id: SafeId<"chatMessage">;
    role: ChatMessage["role"];
    content: ChatMessageContent;
  }[];
};

type LoadThreadProps = {
  initialContextMatterIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  title: string;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type LoadThreadResult =
  | {
      type: "existing";
      data: ThreadRecord;
    }
  | {
      type: "created";
      data: ThreadRecord;
    };

const loadThread = async ({
  initialContextMatterIds,
  organizationId,
  recordAuditEvent,
  safeDb,
  threadId,
  title,
  userId,
  workspaceId,
}: LoadThreadProps): Promise<
  Result<LoadThreadResult, HandlerError<400 | 404> | SafeDbError>
> =>
  await Result.gen(async function* () {
    // Look the thread up by id+user only. Filtering by workspaceId
    // here would mask a scope mismatch — a thread persisted with
    // workspaceId=X but requested as global would look "missing"
    // and the insert below would then collide on the PK. We want a
    // clear 400 instead of a constraint violation 500.
    type ExistingThreadRow = {
      id: SafeId<"chatThread">;
      workspaceId: SafeId<"workspace"> | null;
      contextMatterIds: SafeId<"workspace">[];
      dataWorkspaceIds: SafeId<"workspace">[];
      webSearchEnabled: boolean;
      messages: ThreadRecord["messages"];
    };

    const lookup = async () =>
      await safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: userId },
          },
          columns: {
            id: true,
            workspaceId: true,
            contextMatterIds: true,
            dataWorkspaceIds: true,
            webSearchEnabled: true,
          },
          with: {
            messages: {
              columns: {
                id: true,
                role: true,
                content: true,
              },
              orderBy: { createdAt: "asc" },
            },
          },
        }),
      );

    const buildExisting = (
      existing: ExistingThreadRow,
    ): Result<LoadThreadResult, HandlerError<400>> => {
      const persistedWorkspaceId = existing.workspaceId ?? null;
      if (persistedWorkspaceId !== workspaceId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Chat thread scope does not match request",
          }),
        );
      }
      return Result.ok<LoadThreadResult>({
        type: "existing",
        data: {
          id: existing.id,
          workspaceId: existing.workspaceId,
          contextMatterIds: existing.contextMatterIds,
          dataWorkspaceIds: existing.dataWorkspaceIds,
          webSearchEnabled: existing.webSearchEnabled,
          messages: existing.messages,
        },
      });
    };

    const thread = yield* Result.await(lookup());
    if (thread) {
      return buildExisting(thread);
    }

    const initialDataWorkspaceIds: SafeId<"workspace">[] = workspaceId
      ? [workspaceId]
      : [];

    const insertResult = await safeDb(async (tx) => {
      await tx.insert(chatThreads).values({
        id: threadId,
        organizationId,
        title,
        userId,
        workspaceId,
        contextMatterIds: initialContextMatterIds,
        // Workspace-scoped chats embed at minimum their own
        // workspace's content. Global chats start with no
        // embedded workspace data; subsequent messages widen
        // this set via expandThreadDataScope when they reference
        // workspace assets (mentions, source-document parts).
        dataWorkspaceIds: initialDataWorkspaceIds,
      });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
        resourceId: threadId,
        workspaceId,
        metadata: { title },
      });
    });
    if (Result.isError(insertResult)) {
      if (
        !DatabaseError.is(insertResult.error) ||
        insertResult.error.code !== PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(insertResult.error);
      }
      // Two interleaved cases collide on the primary key here:
      //
      //   (a) Race: two concurrent send-message calls with the
      //       same new threadId — one insert wins, the other
      //       sees the winner's row and should treat it as
      //       existing.
      //   (b) Hidden thread: the row exists but is invisible
      //       under the new RLS predicate (data_workspace_ids ⊄
      //       session), so the initial findFirst returned null.
      //       Returning 404 matches what get-messages already
      //       returns for the same shape and avoids leaking
      //       thread existence to a revoked user.
      //
      // Re-run the lookup under current RLS to disambiguate.
      const recovered = yield* Result.await(lookup());
      if (recovered) {
        return buildExisting(recovered);
      }
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    return Result.ok<LoadThreadResult>({
      type: "created",
      data: {
        id: threadId,
        workspaceId,
        contextMatterIds: initialContextMatterIds,
        dataWorkspaceIds: initialDataWorkspaceIds,
        webSearchEnabled: false,
        messages: [],
      },
    });
  });

type UploadMessageFilesWithRollbackProps = {
  message: ChatMessage;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadState: LoadThreadResult;
  userId: SafeId<"user">;
};

type UploadMessageFilesWithRollbackResult = Result<
  {
    message: ChatMessage;
    uploadedFiles: UploadedChatFile[];
  },
  HandlerError<400 | 422 | 500> | SafeDbError
>;

const uploadMessageFilesWithRollback = async ({
  message,
  recordAuditEvent,
  safeDb,
  threadId,
  threadState,
  userId,
}: UploadMessageFilesWithRollbackProps): Promise<UploadMessageFilesWithRollbackResult> => {
  const uploadResult = await uploadMessageFiles({
    message,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId: threadState.data.workspaceId,
  });

  if (Result.isOk(uploadResult)) {
    return uploadResult;
  }

  if (threadState.type !== "created") {
    return uploadResult;
  }

  const rollbackResult = await rollbackUnpersistedChatSideEffects({
    recordAuditEvent,
    safeDb,
    threadId,
    threadState,
    uploadedFiles: [],
    userId,
  });

  if (Result.isOk(rollbackResult)) {
    return Result.err(uploadResult.error);
  }

  captureError(uploadResult.error, { threadId });
  return Result.err(rollbackResult.error);
};

const rollbackUnpersistedChatSideEffects = async ({
  recordAuditEvent,
  safeDb,
  threadId,
  threadState,
  uploadedFiles,
  userId,
}: {
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadState: LoadThreadResult;
  uploadedFiles: UploadedChatFile[];
  userId: SafeId<"user">;
}): Promise<Result<void, HandlerError<500> | SafeDbError>> => {
  const fileRollbackResult = await deleteUploadedChatFiles({
    files: uploadedFiles,
    recordAuditEvent,
    safeDb,
    threadId,
    userId,
    workspaceId: threadState.data.workspaceId,
  });
  if (Result.isError(fileRollbackResult)) {
    return fileRollbackResult;
  }

  if (threadState.type !== "created") {
    return Result.ok();
  }

  const threadRollbackResult = await safeDb(async (tx) => {
    await tx.delete(chatThreads).where(eq(chatThreads.id, threadId));

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
      resourceId: threadId,
      workspaceId: threadState.data.workspaceId,
      metadata: { reason: "rollback_unpersisted_chat_side_effects" },
    });
  });

  return threadRollbackResult.andThen(() => Result.ok());
};

type PrepareChatContextProps = {
  activeDecision: IncomingActiveDecision | undefined;
  activeExternal: IncomingActiveExternal | undefined;
  activeFile: IncomingActiveFile | undefined;
  contextMatterIds: SafeId<"workspace">[];
  messageWindow: ChatMessage[];
  organizationId: SafeId<"organization">;
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  safeDb: SafeDb;
  sendMode: ChatSendMode;
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
    systemSafe: string;
    /**
     * Dynamic user-supplied context (active file body, decision
     * text, external source, matter labels). Pass through the
     * boundary in anonymized mode before concatenating with
     * `systemSafe`.
     */
    systemUntrusted: string;
    skillMetadata: readonly SkillMetadata[];
  },
  HandlerError<422 | 500> | SafeDbError
>;

const prepareChatContext = async ({
  activeDecision,
  activeExternal,
  activeFile,
  contextMatterIds,
  messageWindow,
  organizationId,
  refRegistry,
  safeDb,
  sendMode,
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
    const practiceJurisdictions = orgSettingsRow?.practiceJurisdictions ?? [];

    const [systemResult, hydratedMessagesResult] = await Promise.all([
      buildChatSystemPromptParts({
        activeDecision,
        activeExternal,
        activeFile,
        contextMatterIds,
        organizationId,
        practiceJurisdictions,
        refRegistry,
        safeDb,
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
          text: `The active file "${activePdf.fileName}" is attached directly as a PDF because Stella has no extracted text for it. Use the attached PDF itself for this question.`,
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
  messages: ChatMessage[];
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type ResolveAssistantMessageRefsProps = {
  messages: ChatMessage[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
};

const resolveAssistantMessageRefs = ({
  messages,
  refRegistry,
}: ResolveAssistantMessageRefsProps): ChatMessage[] => {
  const resolvePart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] => {
    const resolved = refRegistry.resolveAssistantValueRefs(part);

    // SAFETY: resolveAssistantValueRefs preserves the message part shape and
    // only replaces string values containing session-scoped refs.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return resolved as ChatMessage["parts"][number];
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

const hydrateAssistantMessageRefs = ({
  messages,
  refRegistry,
}: ResolveAssistantMessageRefsProps): ChatMessage[] => {
  const hydratePart = (
    part: ChatMessage["parts"][number],
  ): ChatMessage["parts"][number] => {
    const hydrated = refRegistry.hydrateAssistantValueRefs(part);

    // SAFETY: hydrateAssistantValueRefs preserves the message part shape and
    // only replaces stable persisted IDs in ref-shaped fields with
    // request-local short refs for model context.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return hydrated as ChatMessage["parts"][number];
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

const insertMessages = async ({
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
        id: brandPersistedChatMessageId(persistedMessage.id),
        threadId,
        workspaceId,
        userId,
        role: persistedMessage.role,
        content: {
          version: 1 as const,
          data: persistedMessage.parts,
        },
      })),
    );
    await tx
      .update(chatThreads)
      .set({ updatedAt: new Date() })
      .where(eq(chatThreads.id, threadId));

    await recordAuditEvent(
      tx,
      messages.map((persistedMessage) => ({
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: brandPersistedChatMessageId(persistedMessage.id),
        workspaceId,
        metadata: { threadId, role: persistedMessage.role },
      })),
    );
  });

  return insertResult.andThen(() => Result.ok());
};

type PersistMessageProps = {
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  persistencePlan: MessagePersistencePlan;
};

const persistMessage = async ({
  recordAuditEvent,
  safeDb,
  threadId,
  userId,
  workspaceId,
  persistencePlan,
}: PersistMessageProps) => {
  if (persistencePlan.type === "insert") {
    return await insertMessages({
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
      const updatedMessageId = brandPersistedChatMessageId(
        persistencePlan.messageId,
      );
      await tx
        .update(chatMessages)
        .set({
          role: persistencePlan.message.role,
          content: {
            version: 1 as const,
            data: persistencePlan.message.parts,
          },
        })
        .where(eq(chatMessages.id, updatedMessageId));
      await tx
        .update(chatThreads)
        .set({ updatedAt: new Date() })
        .where(eq(chatThreads.id, threadId));

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
    const deletedMessageId = brandPersistedChatMessageId(
      persistencePlan.deleteMessageId,
    );
    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(chatMessages)
          .where(and(eq(chatMessages.id, deletedMessageId)));

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

const contextMatterIdsEqual = (
  a: SafeId<"workspace">[],
  b: SafeId<"workspace">[],
): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set<string>(a);
  return b.every((id) => set.has(id));
};
