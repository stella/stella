import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { chatThreads, userFiles } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readUserFileContent = createSafeRootHandler(
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
              s3Key: userFiles.s3Key,
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

        if (!file) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.USER_FILE,
          resourceId: fileId,
          s3Key: file.s3Key,
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
          message: "User file not found",
        }),
      );
    }

    return Result.ok(Response.redirect(result, 302));
  },
);

export default readUserFileContent;
