import { Result } from "better-result";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import { defaultDatabaseRetry } from "@/api/db";
import { chatThreads, userFiles } from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import { createUserFileKey, deleteS3Keys } from "@/api/handlers/files/utils";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const THREAD_FILE_CLEANUP_BATCH_SIZE = 200;

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

    const thread = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.userId, user.id),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .limit(1);

        return rows.at(0);
      }),
    );

    if (!thread) {
      return Result.ok({});
    }

    // The userFiles.threadId FK is onDelete: 'restrict', so every file row must
    // be removed before the thread delete. Keyset-batch the cleanup (S3 objects
    // then DB rows, page by page) so a thread with many uploads never loads its
    // whole file set into memory; each round is bounded by the batch size and
    // the loop still deletes every file before falling through to the thread delete.
    let lastFileId: SafeId<"userFile"> | null = null;
    while (true) {
      const conditions: SQL[] = [
        eq(userFiles.threadId, params.threadId),
        eq(userFiles.userId, user.id),
      ];
      if (lastFileId !== null) {
        conditions.push(gt(userFiles.id, lastFileId));
      }
      const files = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              id: userFiles.id,
              s3Key: userFiles.s3Key,
              thumbnailFileId: userFiles.thumbnailFileId,
              userId: userFiles.userId,
            })
            .from(userFiles)
            .where(and(...conditions))
            .orderBy(asc(userFiles.id))
            .limit(THREAD_FILE_CLEANUP_BATCH_SIZE),
        ),
      );

      const hasMore = files.length === THREAD_FILE_CLEANUP_BATCH_SIZE;
      if (files.length === 0) {
        break;
      }

      const s3Keys = files.flatMap((file) =>
        file.thumbnailFileId
          ? [
              file.s3Key,
              createUserFileKey({
                fileId: file.thumbnailFileId,
                mimeType: THUMBNAIL_MIME_TYPE,
                userId: brandPersistedUserId(file.userId),
              }),
            ]
          : [file.s3Key],
      );
      // eslint-disable-next-line no-await-in-loop -- sequential keyset pagination; each page depends on the prior cursor
      const deleteResult = await deleteS3Keys(s3Keys);
      if (Result.isError(deleteResult)) {
        yield* Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to delete thread user files from storage",
            cause: deleteResult.error,
          }),
        );
      }

      yield* Result.await(
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        safeDb((tx) => {
          // audit: skip — file-row cleanup is part of the thread delete, which emits the CHAT_THREAD audit row below
          return tx.delete(userFiles).where(
            and(
              eq(userFiles.userId, user.id),
              inArray(
                userFiles.id,
                files.map((file) => file.id),
              ),
            ),
          );
        }),
      );

      if (!hasMore) {
        break;
      }
      lastFileId = files.at(-1)?.id ?? null;
    }

    yield* Result.await(
      safeDb(async (tx) => {
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

    return Result.ok({});
  },
);

export default deleteThread;
