import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import {
  buildChatPromptCacheKey,
  buildChatSystemPromptParts,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
  IncomingActiveDecision,
  IncomingActiveFile,
  IncomingUserContext,
} from "@/api/handlers/chat/chat-schema";
import {
  parseMessage,
  sendMessageBodySchema,
  validateMessage,
} from "@/api/handlers/chat/chat-schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { ChatError } from "@/api/handlers/chat/errors";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import {
  planAssistantFinishPersistence,
  planMessagePersistence,
} from "@/api/handlers/chat/persist-message";
import { hydrateMessages, streamChat } from "@/api/handlers/chat/stream-chat";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type {
  ChatMessage,
  ChatMessageContent,
} from "@/api/handlers/chat/types";
import { uploadMessageFiles } from "@/api/handlers/chat/upload-files";
import { requireAIAvailable } from "@/api/lib/ai-models";
import { captureError } from "@/api/lib/analytics";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

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
    request,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    yield* requireAIAvailable(orgAIConfig);

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
    // expected to discover relevant matters via the readonly stella
    // API instead of being preloaded with thousands of IDs.
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

    // Tool input schemas don't depend on `accessibleWorkspaceIds`
    // (scope is checked at execute time, not in the schema), so we
    // can validate the incoming message against the broad set and
    // then rebuild the tools with the narrowed `effective` set
    // before streaming. This lets the picker's scope actually
    // govern tool authorization rather than just being persisted.
    const validationTools = getChatTools({
      organizationId: session.activeOrganizationId,
      refRegistry,
      safeDb,
      scopedDb,
      userId: user.id,
      accessibleWorkspaceIds,
      workspaceId,
    });

    const validatedMessage = yield* Result.await(
      validateMessage({
        message: body.message,
        safeDb,
        threadId: body.threadId,
        tools: validationTools,
        userId: user.id,
      }),
    );

    const thread = yield* Result.await(
      loadThread({
        initialContextMatterIds: requestedContextMatterIds,
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
    // silently widen access. The effective set used for the rest
    // of the request is whatever ends up persisted.
    let effectiveContextMatterIds = thread.data.contextMatterIds;
    if (
      thread.type === "existing" &&
      body.contextMatterIds !== undefined &&
      !contextMatterIdsEqual(
        thread.data.contextMatterIds,
        requestedContextMatterIds,
      )
    ) {
      yield* Result.await(
        safeDb((tx) =>
          tx
            .update(chatThreads)
            .set({ contextMatterIds: requestedContextMatterIds })
            .where(eq(chatThreads.id, body.threadId)),
        ),
      );
      effectiveContextMatterIds = requestedContextMatterIds;
    }

    // Narrow tool authorization to the pinned matters when the
    // user has set a non-empty scope; otherwise tools see every
    // accessible matter so the AI can discover relevant ones via
    // the readonly stella API. The narrowed list is always a
    // subset of `accessibleWorkspaceIds` (validated above), so
    // this never widens authorization.
    const toolWorkspaceIds =
      effectiveContextMatterIds.length > 0
        ? effectiveContextMatterIds
        : accessibleWorkspaceIds;

    const chatTools = getChatTools({
      organizationId: session.activeOrganizationId,
      refRegistry,
      safeDb,
      scopedDb,
      userId: user.id,
      accessibleWorkspaceIds: toolWorkspaceIds,
      workspaceId,
    });

    const uploadedMessage = yield* Result.await(
      uploadMessageFilesWithRollback({
        message: validatedMessage.message,
        safeDb,
        threadId: thread.data.id,
        threadState: thread,
        userId: user.id,
      }),
    );

    const parsedMessage = parseMessage({
      accessibleWorkspaceIds,
      message: uploadedMessage,
    });

    const latestMessagePlan = planMessagePersistence({
      message: parsedMessage.message,
      storedMessages: thread.data.messages,
    });

    yield* Result.await(
      persistMessage({
        safeDb,
        threadId: body.threadId,
        userId: user.id,
        workspaceId,
        persistencePlan: latestMessagePlan.persistencePlan,
      }),
    );

    const messageWindow = latestMessagePlan.messages.slice(-MESSAGE_WINDOW);
    const chatContext = yield* Result.await(
      prepareChatContext({
        activeDecision: body.activeDecision,
        activeFile: body.activeFile,
        contextMatterIds: effectiveContextMatterIds,
        messageWindow,
        safeDb,
        userContext: body.userContext,
        userId: user.id,
        workspaceId,
        refRegistry,
      }),
    );

    const response = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await streamChat({
            abortSignal: request.signal,
            messages: chatContext.hydratedMessages,
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
                isAborted,
                message: resolvedResponseMessage,
              });

              const persistResult = await persistMessage({
                persistencePlan,
                safeDb,
                threadId: body.threadId,
                userId: user.id,
                workspaceId,
              });

              if (Result.isError(persistResult)) {
                captureError(persistResult.error, { threadId: body.threadId });
              }
            },
            orgAIConfig,
            promptCacheKey: chatContext.promptCacheKey,
            resolveAssistantTextRefs: refRegistry.resolveAssistantTextRefs,
            resolveAssistantValueRefs: refRegistry.resolveAssistantValueRefs,
            threadId: body.threadId,
            tools: chatTools,
            system: chatContext.system,
          }),
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

type ThreadRecord = {
  id: SafeId<"chatThread">;
  contextMatterIds: SafeId<"workspace">[];
  messages: {
    id: SafeId<"chatMessage">;
    role: ChatMessage["role"];
    content: ChatMessageContent;
  }[];
};

type LoadThreadProps = {
  initialContextMatterIds: SafeId<"workspace">[];
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
  safeDb,
  threadId,
  title,
  userId,
  workspaceId,
}: LoadThreadProps): Promise<
  Result<LoadThreadResult, HandlerError<400> | SafeDbError>
> =>
  await Result.gen(async function* () {
    // Look the thread up by id+user only. Filtering by workspaceId
    // here would mask a scope mismatch — a thread persisted with
    // workspaceId=X but requested as global would look "missing"
    // and the insert below would then collide on the PK. We want a
    // clear 400 instead of a constraint violation 500.
    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: userId },
          },
          columns: {
            id: true,
            workspaceId: true,
            contextMatterIds: true,
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
      ),
    );

    if (thread) {
      const persistedWorkspaceId = thread.workspaceId ?? null;
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
          id: thread.id,
          contextMatterIds: thread.contextMatterIds,
          messages: thread.messages,
        },
      });
    }

    yield* Result.await(
      safeDb((tx) =>
        tx.insert(chatThreads).values({
          id: threadId,
          title,
          userId,
          workspaceId,
          contextMatterIds: initialContextMatterIds,
        }),
      ),
    );

    return Result.ok<LoadThreadResult>({
      type: "created",
      data: {
        id: threadId,
        contextMatterIds: initialContextMatterIds,
        messages: [],
      },
    });
  });

type UploadMessageFilesWithRollbackProps = {
  message: ChatMessage;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  threadState: LoadThreadResult;
  userId: SafeId<"user">;
};

type UploadMessageFilesWithRollbackResult = Result<
  ChatMessage,
  HandlerError<400 | 422 | 500> | SafeDbError
>;

const uploadMessageFilesWithRollback = async ({
  message,
  safeDb,
  threadId,
  threadState,
  userId,
}: UploadMessageFilesWithRollbackProps): Promise<UploadMessageFilesWithRollbackResult> => {
  const uploadResult = await uploadMessageFiles({
    message,
    safeDb,
    threadId,
    userId,
  });

  if (threadState.type !== "created" || Result.isOk(uploadResult)) {
    return uploadResult;
  }

  const rollbackResult = await safeDb((tx) =>
    tx.delete(chatThreads).where(eq(chatThreads.id, threadId)),
  );

  if (Result.isOk(rollbackResult)) {
    return Result.err(uploadResult.error);
  }

  captureError(uploadResult.error, { threadId });
  return Result.err(rollbackResult.error);
};

type PrepareChatContextProps = {
  activeDecision: IncomingActiveDecision | undefined;
  activeFile: IncomingActiveFile | undefined;
  contextMatterIds: SafeId<"workspace">[];
  messageWindow: ChatMessage[];
  refRegistry: ReturnType<typeof createChatRefRegistry>;
  safeDb: SafeDb;
  userContext: IncomingUserContext | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type PrepareChatContextResult = Result<
  {
    hydratedMessages: ChatMessage[];
    promptCacheKey: string;
    system: string;
  },
  HandlerError<422 | 500> | SafeDbError
>;

const prepareChatContext = async ({
  activeDecision,
  activeFile,
  contextMatterIds,
  messageWindow,
  refRegistry,
  safeDb,
  userContext,
  userId,
  workspaceId,
}: PrepareChatContextProps): Promise<PrepareChatContextResult> =>
  await Result.gen(async function* () {
    const [systemResult, hydratedMessagesResult] = await Promise.all([
      buildChatSystemPromptParts({
        activeDecision,
        activeFile,
        contextMatterIds,
        refRegistry,
        safeDb,
        userContext,
        workspaceId,
      }),
      hydrateMessages({
        messages: messageWindow,
        safeDb,
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

    return Result.ok({
      promptCacheKey: buildChatPromptCacheKey(systemPrompt.cacheStablePrefix),
      system: systemPrompt.fullPrompt,
      hydratedMessages: hydrateAssistantMessageRefs({
        messages: hydratedMessages,
        refRegistry,
      }),
    });
  });

type InsertMessagesProps = {
  messages: ChatMessage[];
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
  });

  return insertResult.andThen(() => Result.ok());
};

type PersistMessageProps = {
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  persistencePlan: MessagePersistencePlan;
};

const persistMessage = async ({
  safeDb,
  threadId,
  userId,
  workspaceId,
  persistencePlan,
}: PersistMessageProps) => {
  if (persistencePlan.type === "insert") {
    return await insertMessages({
      messages: [persistencePlan.message],
      safeDb,
      threadId,
      userId,
      workspaceId,
    });
  }

  if (persistencePlan.type === "update") {
    const updateResult = await safeDb(async (tx) => {
      await tx
        .update(chatMessages)
        .set({
          role: persistencePlan.message.role,
          content: {
            version: 1 as const,
            data: persistencePlan.message.parts,
          },
        })
        .where(
          eq(
            chatMessages.id,
            brandPersistedChatMessageId(persistencePlan.messageId),
          ),
        );
      await tx
        .update(chatThreads)
        .set({ updatedAt: new Date() })
        .where(eq(chatThreads.id, threadId));
    });

    return updateResult.andThen(() => Result.ok());
  }

  if (persistencePlan.type === "none") {
    return Result.ok();
  }

  return await Result.gen(async function* () {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(chatMessages)
          .where(
            and(
              eq(
                chatMessages.id,
                brandPersistedChatMessageId(persistencePlan.deleteMessageId),
              ),
            ),
          ),
      ),
    );

    yield* Result.await(
      insertMessages({
        messages: [persistencePlan.insertMessage],
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
