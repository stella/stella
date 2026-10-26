import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import { chatThreads, userFiles } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { storedUserFileKey } from "@/api/lib/file-key";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const readUserFileContent = createSafeRootHandler(
  {
    contract: "patch",
    contentDelivery: { type: "audited" },
    permissions: { chat: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "upload_mechanics" },
    params: v.object({ fileId: resourceIdSchema("userFile") }),
  },
  async function* ({
    params: { fileId },
    safeDb,
    session: { activeOrganizationId, id: sourceSessionId },
    user,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const file = (
          await tx
            .select({
              s3Key: userFiles.s3Key,
              userId: userFiles.userId,
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
        const s3Key = storedUserFileKey({
          key: file.s3Key,
          organizationId: activeOrganizationId,
          uploaderUserId: brandPersistedUserId(file.userId),
        });
        if (s3Key === null) {
          return null;
        }

        const presignedUrl = await auditedPresignDownload({
          readSessionAuthority: ownerSyntheticSessionAuthorityReader,
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.USER_FILE,
          resourceId: fileId,
          userId: user.id,
          source: callerDownloadSource({ id: sourceSessionId }),
          s3Key,
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
