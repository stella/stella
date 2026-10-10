import { Result } from "better-result";
import { status } from "elysia";
import type { ElysiaCustomStatusResponse } from "elysia/error";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type {
  SafeHandlerGenerator,
  WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { fileFieldQuery } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

/**
 * Each thumbnail redirect is authorized and audited against the current
 * session. Signed URLs stay short-lived, and redirects are never cached.
 */
const FILE_THUMBNAIL_URL_EXPIRY_SECONDS = 15 * 60;

const config = {
  contentDelivery: { type: "audited" },
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "upload_mechanics" },
  access: "read",
  params: workspaceParams({ fieldId: tSafeId("field") }),
} satisfies WorkspaceHandlerConfig;

/**
 * Redirect to the WebP thumbnail of a matter image file.
 *
 * The field is resolved through the same workspace-bound, tombstone-excluding
 * lookup as the file itself, so a field from another matter answers 404. A
 * file without a generated thumbnail, or an encrypted one, answers 404 too.
 *
 * @yields Structured errors from thumbnail lookup or URL signing.
 */
export default createSafeHandler(
  config,
  async function* ({
    params: { fieldId },
    session: { activeOrganizationId: organizationId },
    recordAuditEvent,
    scopedDb,
    workspaceId,
  }): SafeHandlerGenerator<Response | ElysiaCustomStatusResponse<404>> {
    const rows = yield* Result.await(
      Result.tryPromise(
        async () => await fileFieldQuery(scopedDb, fieldId, workspaceId),
      ),
    );
    const row = rows.at(0);
    if (row?.content.type !== "file") {
      return Result.ok(status(404));
    }
    const content = row.content;
    const thumbnailFileId = content.thumbnailFileId;
    if (!thumbnailFileId || content.encrypted) {
      return Result.ok(status(404));
    }

    const presignedUrl = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb(
            async (tx) =>
              await auditedPresignDownload({
                tx,
                recordAuditEvent,
                resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                resourceId: row.entityId,
                s3Key: createFileKey({
                  organizationId,
                  workspaceId,
                  fileId: thumbnailFileId,
                  mimeType: THUMBNAIL_MIME_TYPE,
                }),
                expiresInSeconds: FILE_THUMBNAIL_URL_EXPIRY_SECONDS,
                organizationId,
                workspaceId,
                metadata: { fieldId, variant: "thumbnail" },
              }),
          ),
      ),
    );

    return Result.ok(
      new Response(null, {
        status: 302,
        headers: {
          Location: presignedUrl,
          [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL,
        },
      }),
    );
  },
);
