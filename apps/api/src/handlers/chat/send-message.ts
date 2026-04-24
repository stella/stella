import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import {
  buildChatSystemPrompt,
  extractTitle,
} from "@/api/handlers/chat/chat-prompt";
import type {
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
  collectNewAssistantMessages,
  planMessagePersistence,
} from "@/api/handlers/chat/persist-message";
import { hydrateMessages, streamChat } from "@/api/handlers/chat/stream-chat";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type {
  ChatMessage,
  ChatMessageContent,
} from "@/api/handlers/chat/types";
import { uploadMessageFiles } from "@/api/handlers/chat/upload-files";
import { captureError } from "@/api/lib/analytics";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
    const accessibleWorkspaceIds = activeWorkspaceIds;
    /* eslint-disable no-body-ownership-ids/no-body-ownership-ids -- root handler; resolveChatScope validates against accessibleWorkspaceIds */
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds,
      workspaceId: body.workspaceId,
    });
    /* eslint-enable no-body-ownership-ids/no-body-ownership-ids */

    const workspaceId = scope.scope === "workspace" ? scope.workspaceId : null;

    const chatTools = getChatTools({
      organizationId: session.activeOrganizationId,
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
        tools: chatTools,
        userId: user.id,
      }),
    );

    const thread = yield* Result.await(
      loadThread({
        safeDb,
        threadId: body.threadId,
        title: extractTitle(validatedMessage.message.parts),
        userId: user.id,
        workspaceId,
      }),
    );

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
        activeFile: body.activeFile,
        messageWindow,
        safeDb,
        userContext: body.userContext,
        userId: user.id,
        workspaceId,
      }),
    );

    const response = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await streamChat({
            abortSignal: request.signal,
            messages: chatContext.hydratedMessages,
            onFinish: async (streamedMessages) => {
              const newAssistantMessages = collectNewAssistantMessages({
                existingIds: latestMessagePlan.existingIds,
                messages: streamedMessages,
              });

              if (newAssistantMessages.length === 0) {
                return;
              }

              const insertResult = await insertMessages({
                messages: newAssistantMessages,
                safeDb,
                threadId: body.threadId,
                userId: user.id,
                workspaceId,
              });

              if (Result.isError(insertResult)) {
                captureError(insertResult.error, { threadId: body.threadId });
              }
            },
            orgAIConfig,
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
  id: string;
  messages: {
    id: string;
    role: ChatMessage["role"];
    content: ChatMessageContent;
  }[];
};

type LoadThreadProps = {
  safeDb: SafeDb;
  threadId: string;
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
  safeDb,
  threadId,
  title,
  userId,
  workspaceId,
}: LoadThreadProps): Promise<Result<LoadThreadResult, SafeDbError>> =>
  await Result.gen(async function* () {
    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: userId },
            workspaceId: workspaceId ? { eq: workspaceId } : { isNull: true },
          },
          columns: { id: true },
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
      return Result.ok<LoadThreadResult>({
        type: "existing",
        data: thread,
      });
    }

    yield* Result.await(
      safeDb((tx) =>
        tx.insert(chatThreads).values({
          id: threadId,
          title,
          userId,
          workspaceId,
        }),
      ),
    );

    return Result.ok<LoadThreadResult>({
      type: "created",
      data: {
        id: threadId,
        messages: [],
      },
    });
  });

type UploadMessageFilesWithRollbackProps = {
  message: ChatMessage;
  safeDb: SafeDb;
  threadId: string;
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
  activeFile: IncomingActiveFile | undefined;
  messageWindow: ChatMessage[];
  safeDb: SafeDb;
  userContext: IncomingUserContext | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

type PrepareChatContextResult = Result<
  {
    hydratedMessages: ChatMessage[];
    system: string;
  },
  HandlerError<422 | 500> | SafeDbError
>;

const prepareChatContext = async ({
  activeFile,
  messageWindow,
  safeDb,
  userContext,
  userId,
  workspaceId,
}: PrepareChatContextProps): Promise<PrepareChatContextResult> =>
  await Result.gen(async function* () {
    const [systemResult, hydratedMessagesResult] = await Promise.all([
      buildChatSystemPrompt({
        activeFile,
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
    const system = yield* systemResult;
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
      system,
      hydratedMessages,
    });
  });

type InsertMessagesProps = {
  messages: ChatMessage[];
  safeDb: SafeDb;
  threadId: string;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
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
        id: persistedMessage.id,
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
  threadId: string;
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
        .where(eq(chatMessages.id, persistencePlan.messageId));
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
          .where(and(eq(chatMessages.id, persistencePlan.deleteMessageId))),
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
