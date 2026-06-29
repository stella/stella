import { Result } from "better-result";
import { t } from "elysia";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { isWebSearchAvailable } from "@/api/handlers/chat/tools/chat-tools";
import { getDisabledNativeToolSlugs } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { loadWebSearchProvidersForOrg } from "@/api/lib/web-search/load-org-keys";

const config = {
  permissions: { chat: ["create"] },
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

    return Result.ok({
      messages: page.messages,
      olderCursor: page.olderCursor,
      contextMatterIds: thread.contextMatterIds,
      lastActivityAt: page.lastActivityAt,
      webSearchAvailable,
      webSearchEnabled: thread.webSearchEnabled,
    });
  },
);

export default getMessages;
