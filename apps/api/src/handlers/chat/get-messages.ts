import { Result } from "better-result";
import { t } from "elysia";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { normalizeLegacyToolInputs } from "@/api/handlers/chat/legacy-tool-compat";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
    user,
  }) {
    const accessibleWorkspaceIds = activeWorkspaceIds;
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds,
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

    if (!thread) {
      if (allowMissingThread) {
        return Result.ok({
          messages: [],
          contextMatterIds: [],
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

    return Result.ok({
      messages: thread.messages.map((row) => ({
        id: row.id,
        role: row.role,
        parts: normalizeLegacyToolInputs(row.content.data),
      })),
      contextMatterIds: thread.contextMatterIds,
      webSearchEnabled: thread.webSearchEnabled,
    });
  },
);

export default getMessages;
