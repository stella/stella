import { Result } from "better-result";
import * as v from "valibot";

import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { loadRecapMessageWindow } from "@/api/handlers/chat/thread-recap-window";
import {
  buildThreadTitlePrompt,
  cleanGeneratedTitle,
  TITLE_FINISH_POLICY,
  TITLE_MAX_OUTPUT_TOKENS,
} from "@/api/handlers/chat/thread-title-prompt";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  admitFiniteAction,
  authorizeHandlerUsage,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { THREAD_STORED_CONTENT_SEND_MODE } from "@/api/lib/chat/thread-stored-content-send-mode";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cloneOperationInput } from "@/api/lib/proofs/checked-transaction";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

const config = {
  contract: "patch",
  // The other AI reads (recap, suggested prompts, improve-prompt) require
  // chat "create" because they assist with conversing. This one requires
  // "update" — the permission of the rename PATCH it feeds — so a user who
  // cannot rename cannot spend metered model calls proposing a title they
  // have no way to apply.
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  query: v.object({ workspaceId: v.optional(resourceIdSchema("workspace")) }),
} satisfies HandlerConfig;

const SUGGEST_TITLE_TIMEOUT_MS = 15_000;

// Proposes a title for an existing conversation from the same message window
// the recap uses. Read-only by contract: the only title writer stays
// `PATCH /threads/:threadId/title`, which owns titleSource stamping, the
// audit event, and search re-indexing.
export const createSuggestThreadTitle = ({
  generateTextForTask = generateTanStackTextForTask,
  admit,
}: {
  admit?: typeof withActionAdmission;
  /** External model-dispatch boundary; supplied by focused integration tests. */
  generateTextForTask?: typeof generateTanStackTextForTask | undefined;
} = {}) =>
  createSafeRootHandler(config, async function* (ctx) {
    const {
      getWorkspaceAccess,
      orgAIConfig,
      managedAIResidency,
      orgAIConfigStatus,
      params: { threadId },
      promptCachingEnabled,
      query: { workspaceId },
      safeDb,
      session,
      user,
    } = ctx;
    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId,
    });

    const thread = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: user.id },
          },
          columns: {
            dataWorkspaceIds: true,
            workspaceId: true,
            usedAnonymization: true,
          },
        }),
      ),
    );

    if (!thread) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    const persistedWorkspaceId = thread.workspaceId ?? null;
    yield* assertChatThreadScopeMatches({ persistedWorkspaceId, scope });

    if (thread.usedAnonymization) {
      return Result.err(
        new HandlerError({
          status: 403,
          message:
            "Title suggestion is unavailable for anonymized conversations",
        }),
      );
    }

    const messageWindow = yield* Result.await(
      loadRecapMessageWindow({ safeDb, threadId, userId: user.id }),
    );
    // Re-read with the messages: the thread may have switched since the
    // check above.
    if (messageWindow.sendMode === THREAD_STORED_CONTENT_SEND_MODE.anonymized) {
      return Result.err(
        new HandlerError({
          status: 403,
          message:
            "Title suggestion is unavailable for anonymized conversations",
        }),
      );
    }

    if (messageWindow.messages.length === 0) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Chat thread has no messages to summarize",
        }),
      );
    }

    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    yield* requireTanStackAIAvailableForTask({
      dataClass: "customer",
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      task: "short-text",
    });

    const authorization = yield* Result.await(
      authorizeHandlerUsage({
        metering: { actionType: "chat", modelTask: "short-text" },
        organizationId: session.activeOrganizationId,
        orgAIConfig,
        workspaceId: persistedWorkspaceId,
        userId: user.id,
        safeDb,
        ctx,
        managedAIResidency,
        promptCachingEnabled,
        threadId,
        thread,
        messageWindow,
        admit,
        generateTextForTask,
      }),
    );
    return await authorization.execute(async ({ proof }) => {
      const checked = proof.input.value;
      const admittedContext = cloneOperationInput(checked.ctx);
      return await Result.gen(async function* () {
        const tenantWorkspaceIds = checked.workspaceId
          ? Array.from(
              new Set([
                checked.workspaceId,
                ...checked.thread.dataWorkspaceIds,
              ]),
            )
          : checked.thread.dataWorkspaceIds;

        const titleMessages = checked.messageWindow.messages.map((row) => ({
          role: row.role,
          parts: normalizePersistedChatMessageContent(row.content).parts,
        }));

        const text = yield* Result.await(
          Result.gen(() =>
            admitFiniteAction({
              actionKind: "chat.suggest-thread-title",
              ctx: admittedContext,
              ...(checked.admit === undefined ? {} : { admit: checked.admit }),
              async *handler({ actionSignal, modelAdmission }) {
                const aiAnalytics = createTanStackAIAnalyticsCallbacks({
                  dataClass: "customer",
                  usageMetering: {
                    actionType: "chat",
                    organizationId: checked.organizationId,
                    safeDb: checked.safeDb,
                    serviceTier: "standard",
                    userId: checked.userId,
                    workspaceId: checked.workspaceId,
                  },
                  feature: "chat.suggest_title",
                  modelTask: "short-text",
                  orgAIConfig: checked.orgAIConfig,
                  modelTier: modelAdmission.modelTier,
                  properties: checked.workspaceId
                    ? { workspace_id: checked.workspaceId }
                    : {},
                  traceId: Bun.randomUUIDv7(),
                });

                const generated = yield* Result.await(
                  Result.tryPromise({
                    try: async () =>
                      await checked.generateTextForTask({
                        userId: modelAdmission.userId,
                        dataClass: "customer",
                        abortSignal: actionSignal,
                        deadlineMs: SUGGEST_TITLE_TIMEOUT_MS,
                        analytics: aiAnalytics,
                        caching: resolveCaching({
                          promptCachingEnabled: checked.promptCachingEnabled,
                          task: "short-text",
                          scopeKey: checked.threadId,
                        }),
                        finishPolicy: TITLE_FINISH_POLICY,
                        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
                        organizationId: checked.organizationId,
                        admission: modelAdmission,
                        orgAIConfig: checked.orgAIConfig,
                        managedAIResidency: checked.managedAIResidency,
                        prompt: buildThreadTitlePrompt(titleMessages),
                        task: "short-text",
                        serviceTier: "standard",
                        tenantWorkspaceIds,
                      }),
                    catch: (error) => {
                      aiAnalytics.captureError(error);
                      return aiHandlerError(error, {
                        status: 502,
                        message: "Title suggestion failed",
                      });
                    },
                  }),
                );

                return Result.ok(generated);
              },
            }),
          ),
        );

        const title = cleanGeneratedTitle(text);
        if (title.length === 0) {
          return Result.err(
            new HandlerError({
              status: 502,
              code: "internal_error",
              message: "Empty suggested title",
            }),
          );
        }

        return Result.ok({ title });
      });
    });
  });

export default createSuggestThreadTitle();
