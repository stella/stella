import { Result } from "better-result";
import { t } from "elysia";

import { estimateChatContextPromptTokens } from "@/api/handlers/chat/chat-prompt";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import type { ThreadContextUsage } from "@/api/handlers/chat/compaction";
import { resolveChatCompactionBudget } from "@/api/handlers/chat/compaction-budget";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readLatestChatCompaction } from "@/api/handlers/chat/persistent-compaction";
import { isWebSearchAvailable } from "@/api/handlers/chat/tools/chat-tools";
import { getDisabledNativeToolSlugs } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    allowMissingThread: t.Optional(t.Boolean()),
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const getMessages = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    orgAIConfig,
    params: { threadId },
    query: { allowMissingThread, workspaceId },
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
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
            workspaceId: true,
            contextMatterIds: true,
            webSearchEnabled: true,
            usedAnonymization: true,
          },
        }),
      ),
    );
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
    const { webSearchProvider } = await loadWebSearchProvidersForOrg(
      session.activeOrganizationId,
    );
    const webSearchAvailable = isWebSearchAvailable({
      webSearchProviderAvailable: webSearchProvider !== null,
      disabledNativeToolSlugs,
    });

    if (!thread) {
      if (allowMissingThread) {
        return Result.ok({
          messages: [],
          olderCursor: null,
          contextMatterIds: [],
          lastActivityAt: null,
          webSearchAvailable,
          webSearchEnabled: false,
          context: null,
        });
      }

      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    // Reject requests whose scope contradicts the persisted thread.
    // A workspace-scoped thread asked for as global (or vice versa)
    // is a client bug — fail loud instead of silently 404'ing or
    // creating a duplicate.
    const persistedWorkspaceId = thread.workspaceId ?? null;
    const requestedWorkspaceId =
      scope.scope === "workspace" ? scope.workspaceId : null;
    if (persistedWorkspaceId !== requestedWorkspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    // The most-recent page is loaded first; older pages are fetched on
    // demand from the sibling /messages/older endpoint as the user
    // scrolls up. lastActivityAt is the newest message's timestamp,
    // which the client compares against the recap staleness window.
    const page = yield* Result.await(
      loadChatMessagePage({ safeDb, threadId, userId: user.id }),
    );

    // Estimate the model context the next send would carry, mirroring the send
    // path: the active compaction summary plus the same windowed history the
    // model receives. Computed only here (the initial page); the /older
    // pagination endpoint does not carry it.
    // Independent reads, fetched in parallel. `isAnonymized` mirrors the
    // thread's persisted flag: anonymized threads never checkpoint, so the
    // capped branch bounds this read the same way the send path bounds its
    // history window (a long anonymized thread must not scan every row just
    // to render the meter).
    const [checkpointResult, windowedMessagesResult] = await Promise.all([
      readLatestChatCompaction({ safeDb, threadId }),
      loadWindowedThreadMessages({
        safeDb,
        threadId,
        isAnonymized: thread.usedAnonymization,
      }),
    ]);
    const checkpoint = yield* checkpointResult;
    const windowedMessages = yield* windowedMessagesResult;
    // Null for a fresh, empty thread (nothing to meter yet); the frontend
    // renders nothing. Keeping the value nullable also unifies this branch with
    // the missing-thread branch (context: null) into one response type.
    const hasContext = windowedMessages.length > 0 || checkpoint !== null;
    // The meter's cache-stable prefix estimate mirrors the send path's stable
    // prompt: web research steers the core rules through the same two gates the
    // send path applies (provider availability and the thread's opt-in), and
    // (unlike template studio) the standalone read path never carries
    // template-authoring tools. The trigger denominator resolves the same chat
    // model the next send would use.
    const { promptTokens, toolTokens } = estimateChatContextPromptTokens({
      toolAvailability: {
        templateAuthoring: false,
        webResearch: webSearchAvailable && thread.webSearchEnabled,
        folioAgentDocTools: false,
      },
    });
    const { triggerTokens } = resolveChatCompactionBudget({
      orgAIConfig,
      organizationId: session.activeOrganizationId,
    });
    const context: ThreadContextUsage | null = hasContext
      ? computeThreadContextUsage({
          messages: windowedMessages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: message.content.data,
          })),
          promptTokens,
          toolTokens,
          triggerTokens,
          summary: checkpoint
            ? {
                summarizedMessageCount: checkpoint.summarizedMessageCount,
                summaryMarkdown: checkpoint.summaryMarkdown,
              }
            : null,
        })
      : null;

    return Result.ok({
      messages: page.messages,
      olderCursor: page.olderCursor,
      contextMatterIds: thread.contextMatterIds,
      lastActivityAt: page.lastActivityAt,
      webSearchAvailable,
      webSearchEnabled: thread.webSearchEnabled,
      context,
    });
  },
);

export default getMessages;
