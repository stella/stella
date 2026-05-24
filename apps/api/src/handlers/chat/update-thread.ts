import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db";
import { chatThreads } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["update"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
  body: t.Object({
    webSearchEnabled: t.Boolean(),
  }),
} satisfies HandlerConfig;

const updateThread = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    body,
    query: { workspaceId },
    params,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
      workspaceId,
    });

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const updated = await tx
          .update(chatThreads)
          .set({ webSearchEnabled: body.webSearchEnabled })
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.organizationId, session.activeOrganizationId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .returning({ id: chatThreads.id });

        if (updated.length > 0) {
          return updated;
        }

        const resolvedWorkspaceId =
          scope.scope === "workspace" ? scope.workspaceId : null;
        const dataWorkspaceIds =
          scope.scope === "workspace" ? [scope.workspaceId] : [];

        const inserted = await tx
          .insert(chatThreads)
          .values({
            id: params.threadId,
            organizationId: session.activeOrganizationId,
            title: "New chat",
            userId: user.id,
            workspaceId: resolvedWorkspaceId,
            contextMatterIds: [],
            dataWorkspaceIds,
            webSearchEnabled: body.webSearchEnabled,
          })
          .onConflictDoNothing()
          .returning({ id: chatThreads.id });

        if (inserted.length > 0) {
          return inserted;
        }

        return await tx
          .update(chatThreads)
          .set({ webSearchEnabled: body.webSearchEnabled })
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.organizationId, session.activeOrganizationId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .returning({ id: chatThreads.id });
      }, defaultDatabaseRetry),
    );

    if (result.length === 0) {
      yield* Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    return Result.ok({ webSearchEnabled: body.webSearchEnabled });
  },
);

export default updateThread;
