import { Result } from "better-result";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import * as v from "valibot";

import { defaultDatabaseRetry } from "@/api/db/safe-db";
import {
  chatThreads,
  entityDeletionCleanupRequests,
  userFiles,
} from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { lockThreadStoredContentTransitionOnTx } from "@/api/lib/chat/thread-stored-content-egress";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createUserFileThumbnailKey } from "@/api/lib/file-key";
import { requireNoHold } from "@/api/lib/legal-holds/holds";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const THREAD_FILE_CLEANUP_BATCH_SIZE = 200;

const config = {
  contract: "patch",
  description:
    "Permanently delete one of your own chat threads with its messages and the " +
    "files uploaded to it; the stored file objects are deleted, not just " +
    "dereferenced. Succeeds silently when the thread does not exist or belongs " +
    "to someone else.",
  permissions: { chat: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "assistant_chat",
    consumesServices: false,
  },
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  query: v.object({ workspaceId: v.optional(resourceIdSchema("workspace")) }),
} satisfies HandlerConfig;

const deleteThread = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    query: { workspaceId },
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId,
    });

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            id: chatThreads.id,
            organizationId: chatThreads.organizationId,
          })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.userId, user.id),
              eq(chatThreads.organizationId, session.activeOrganizationId),
              scope.scope === "workspace"
                ? eq(chatThreads.workspaceId, scope.workspaceId)
                : isNull(chatThreads.workspaceId),
            ),
          )
          .limit(1);
        const thread = rows.at(0);
        const requestIds: SafeId<"entityDeletionCleanupRequest">[] = [];
        if (!thread) {
          return Result.ok({ requestIds });
        }
        const hold = await requireNoHold({
          tx,
          organizationId: thread.organizationId,
          target: { type: "thread", threadId: params.threadId },
        });
        if (hold.isErr()) {
          return Result.err(
            new HandlerError({ status: 409, message: hold.error.message }),
          );
        }
        await lockThreadStoredContentTransitionOnTx(tx, params.threadId);

        // The hold fence, row erasure and durable storage instructions commit
        // together. Workers only receive keys whose references were withdrawn.
        const removeFilePage = async (
          cursor: SafeId<"userFile"> | null,
        ): Promise<void> => {
          const files = await tx
            .select({
              id: userFiles.id,
              s3Key: userFiles.s3Key,
              thumbnailFileId: userFiles.thumbnailFileId,
              userId: userFiles.userId,
            })
            .from(userFiles)
            .where(
              and(
                eq(userFiles.threadId, params.threadId),
                eq(userFiles.userId, user.id),
                cursor === null ? undefined : gt(userFiles.id, cursor),
              ),
            )
            .orderBy(asc(userFiles.id))
            .limit(THREAD_FILE_CLEANUP_BATCH_SIZE);
          if (files.length === 0) {
            return;
          }
          const s3Keys = files
            .flatMap((file) =>
              file.thumbnailFileId
                ? [
                    file.s3Key,
                    createUserFileThumbnailKey({
                      sourceKey: file.s3Key,
                      thumbnailFileId: file.thumbnailFileId,
                      organizationId: thread.organizationId,
                      uploaderUserId: brandPersistedUserId(file.userId),
                    }),
                  ]
                : [file.s3Key],
            )
            .filter((key) => key !== null);
          const requestId = createSafeId<"entityDeletionCleanupRequest">();
          // audit: skip; outbox bookkeeping owned by the thread deletion below.
          await tx.insert(entityDeletionCleanupRequests).values({
            id: requestId,
            organizationId: thread.organizationId,
            workspaceId: scope.scope === "workspace" ? scope.workspaceId : null,
            s3Keys,
          });
          requestIds.push(requestId);
          // audit: skip; the owning thread deletion records these attachments.
          await tx.delete(userFiles).where(
            inArray(
              userFiles.id,
              files.map(({ id }) => id),
            ),
          );
          const last = files.at(-1);
          if (files.length === THREAD_FILE_CLEANUP_BATCH_SIZE && last) {
            await removeFilePage(last.id);
          }
        };
        await removeFilePage(null);
        const result = await tx
          .delete(chatThreads)
          .where(
            and(
              eq(chatThreads.id, params.threadId),
              eq(chatThreads.userId, user.id),
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
        return Result.ok({ requestIds });
      }, defaultDatabaseRetry),
    );
    const { requestIds } = yield* outcome;
    await handoffCommittedEntityDeletionCleanupBatch({
      captureDeliveryError: captureError,
      enqueueCleanup: enqueueEntityDeletionCleanup,
      requestIds,
    });

    return Result.ok({});
  },
);

export default deleteThread;
