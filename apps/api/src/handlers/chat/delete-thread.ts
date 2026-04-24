import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db";
import { chatThreads, userFiles } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { deleteS3Keys } from "@/api/handlers/files/utils";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["delete"] },
  params: t.Object({ threadId: t.String({ format: "uuid" }) }),
  query: t.Object({
    workspaceId: t.Optional(tUuid),
  }),
} satisfies HandlerConfig;

const deleteThread = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    params,
    query: { workspaceId },
    safeDb,
    user,
  }) {
    const accessibleWorkspaceIds = activeWorkspaceIds;
    const scope = yield* resolveChatScope({
      accessibleWorkspaceIds,
      workspaceId,
    });

    const files = yield* Result.await(
      safeDb((tx) =>
        tx.query.userFiles.findMany({
          where: {
            threadId: { eq: params.threadId },
            userId: { eq: user.id },
            workspaceId:
              scope.scope === "workspace"
                ? { eq: scope.workspaceId }
                : { isNull: true },
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

        return await tx
          .delete(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          );
      }, defaultDatabaseRetry),
    );

    return Result.ok();
  },
);

export default deleteThread;
