import { Result } from "better-result";
import { t } from "elysia";

import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
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
            workspaceId:
              scope.scope === "workspace"
                ? { eq: scope.workspaceId }
                : { isNull: true },
          },
          columns: {},
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
        return Result.ok([]);
      }

      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    return Result.ok(
      thread.messages.map((row) => ({
        id: row.id,
        role: row.role,
        parts: row.content.data,
      })),
    );
  },
);

export default getMessages;
