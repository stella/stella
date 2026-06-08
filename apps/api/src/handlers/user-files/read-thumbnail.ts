import { panic, Result } from "better-result";
import { t } from "elysia";

import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import { createUserFileKey } from "@/api/handlers/files/utils";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readUserFileThumbnail = createSafeRootHandler(
  {
    permissions: { chat: ["create"] },
    params: t.Object({ fileId: tSafeId("userFile") }),
  },
  async function* ({ params: { fileId }, safeDb, user, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const file = await tx.query.userFiles.findFirst({
          where: {
            id: { eq: fileId },
            userId: { eq: user.id },
          },
          columns: {
            thumbnailFileId: true,
          },
          with: {
            thread: {
              columns: {
                workspaceId: true,
              },
            },
          },
        });

        if (!file?.thumbnailFileId) {
          return null;
        }
        const thread =
          file.thread ?? panic("User file thread relation missing");

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
          workspaceId: thread.workspaceId,
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
