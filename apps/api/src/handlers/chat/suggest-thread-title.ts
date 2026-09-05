import { Result } from "better-result";
import { t } from "elysia";

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
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  assertUsageAvailableForHandler,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const config = {
  // The other AI reads (recap, suggested prompts, improve-prompt) require
  // chat "create" because they assist with conversing. This one requires
  // "update" — the permission of the rename PATCH it feeds — so a user who
  // cannot rename cannot spend metered model calls proposing a title they
  // have no way to apply.
  permissions: { chat: ["update"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ workspaceId: t.Optional(tSafeId("workspace")) }),
} satisfies HandlerConfig;

const SUGGEST_TITLE_TIMEOUT_MS = 15_000;

// Proposes a title for an existing conversation from the same message window
// the recap uses. Read-only by contract: the only title writer stays
// `PATCH /threads/:threadId/title`, which owns titleSource stamping, the
// audit event, and search re-indexing.
export const createSuggestThreadTitle = ({
  generateTextForRole = generateTanStackTextForRole,
}: {
  /** External model-dispatch boundary; supplied by focused integration tests. */
  generateTextForRole?: typeof generateTanStackTextForRole | undefined;
} = {}) =>
  createSafeRootHandler(
    config,
    async function* ({
      getWorkspaceAccess,
      orgAIConfig,
      orgAIConfigStatus,
      params: { threadId },
      promptCachingEnabled,
      query: { workspaceId },
      request,
      safeDb,
      session,
      user,
    }) {
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

      if (messageWindow.messages.length === 0) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Chat thread has no messages to summarize",
          }),
        );
      }

      yield* requireTanStackAIAvailableForRole({
        configStatus: orgAIConfigStatus,
        orgConfig: orgAIConfig,
        role: "fast",
      });

      const preflightError = await assertUsageAvailableForHandler({
        metering: { actionType: "chat", modelRole: "fast" },
        organizationId: session.activeOrganizationId,
        orgAIConfig,
        workspaceId: persistedWorkspaceId,
        userId: user.id,
        safeDb,
      });
      if (preflightError) {
        return Result.err(preflightError);
      }

      const tenantWorkspaceIds = persistedWorkspaceId
        ? Array.from(
            new Set([persistedWorkspaceId, ...thread.dataWorkspaceIds]),
          )
        : thread.dataWorkspaceIds;

      const titleMessages = messageWindow.messages.map((row) => ({
        role: row.role,
        parts: normalizePersistedChatMessageContent(row.content).parts,
      }));

      const aiAnalytics = createTanStackAIAnalyticsCallbacks({
        usageMetering: {
          actionType: "chat",
          organizationId: session.activeOrganizationId,
          safeDb,
          serviceTier: "standard",
          userId: user.id,
          workspaceId: persistedWorkspaceId,
        },
        feature: "chat.suggest_title",
        modelRole: "fast",
        orgAIConfig,
        properties: persistedWorkspaceId
          ? { workspace_id: persistedWorkspaceId }
          : {},
        traceId: Bun.randomUUIDv7(),
      });

      const text = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await generateTextForRole({
              abortSignal: AbortSignal.any([
                request.signal,
                AbortSignal.timeout(SUGGEST_TITLE_TIMEOUT_MS),
              ]),
              analytics: aiAnalytics,
              caching: resolveCaching({
                promptCachingEnabled,
                role: "fast",
                scopeKey: threadId,
              }),
              finishPolicy: TITLE_FINISH_POLICY,
              maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
              organizationId: session.activeOrganizationId,
              orgAIConfig,
              prompt: buildThreadTitlePrompt(titleMessages),
              role: "fast",
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

      const title = cleanGeneratedTitle(text);
      if (title.length === 0) {
        return Result.err(
          new HandlerError({ status: 502, message: "Empty suggested title" }),
        );
      }

      return Result.ok({ title });
    },
  );

export default createSuggestThreadTitle();
