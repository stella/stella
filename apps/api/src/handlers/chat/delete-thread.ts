import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db";
import { chatThreads, userFiles } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { deleteS3Keys } from "@/api/handlers/files/utils";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["delete"] },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const deleteThread = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    query: { workspaceId },
    params,
    recordAuditEvent,
    safeDb,
    user,
  }) {
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds: activeWorkspaceIds,
      workspaceId,
    });

    const files = yield* Result.await(
      safeDb((tx) =>
        tx.query.userFiles.findMany({
          where: {
            threadId: { eq: params.threadId },
            userId: { eq: user.id },
          },
          columns: {
            id: true,
            s3Key: true,
          },
        }),
      ),
    );

    if (files.length > 0) {
      const deleteResult = await deleteS3Keys(files.map((file) => file.s3Key));
      if (Result.isError(deleteResult)) {
        yield* Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to delete thread user files from storage",
            cause: deleteResult.error,
          }),
        );
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
        if (files.length > 0) {
          await tx.delete(userFiles).where(
            and(
              eq(userFiles.userId, user.id),
              inArray(
                userFiles.id,
                files.map((file) => file.id),
              ),
            ),
          );
        }

        const result = await tx
          .delete(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .returning({ id: chatThreads.id });

        if (result.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
            resourceId: params.threadId,
            workspaceId: scope.scope === "workspace" ? scope.workspaceId : null,
          });
        }

        return result;
      }, defaultDatabaseRetry),
    );

    return Result.ok();
  },
);

export default deleteThread;
