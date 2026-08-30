import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { chatThreads, userFiles } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createUserFileKey } from "@/api/lib/files/utils";

const readUserFileThumbnail = createSafeRootHandler(
  {
    permissions: { chat: ["create"] },
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: t.Object({ fileId: tSafeId("userFile") }),
  },
  async function* ({
    params: { fileId },
    safeDb,
    session: { activeOrganizationId },
    user,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const file = (
          await tx
            .select({
              thumbnailFileId: userFiles.thumbnailFileId,
              workspaceId: chatThreads.workspaceId,
            })
            .from(userFiles)
            .innerJoin(
              chatThreads,
              and(
                eq(chatThreads.id, userFiles.threadId),
                eq(chatThreads.userId, userFiles.userId),
              ),
            )
            .where(
              and(
                eq(userFiles.id, fileId),
                eq(userFiles.userId, user.id),
                eq(chatThreads.userId, user.id),
                eq(chatThreads.organizationId, activeOrganizationId),
              ),
            )
            .limit(1)
        ).at(0);

        if (!file?.thumbnailFileId) {
          return null;
        }

        const thumbnailKey = createUserFileKey({
          fileId: file.thumbnailFileId,
          mimeType: THUMBNAIL_MIME_TYPE,
          userId: user.id,
        });

        const presignedUrl = await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.USER_FILE,
          resourceId: fileId,
          s3Key: thumbnailKey,
          expiresInSeconds: 900,
          workspaceId: file.workspaceId,
        });

        return presignedUrl;
      }),
    );

    if (!result) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "User file thumbnail not found",
        }),
      );
    }

    return Result.ok(Response.redirect(result, 302));
  },
);

export default readUserFileThumbnail;
