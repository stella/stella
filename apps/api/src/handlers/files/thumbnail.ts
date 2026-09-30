import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { fileFieldQuery } from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";

/**
 * Thumbnails are requested by `<img>` tags on every render of a list, so the
 * signed URL stays short-lived and the browser may reuse the redirect for a
 * fraction of that lifetime instead of re-signing (and re-auditing) each time.
 */
export const FILE_THUMBNAIL_URL_EXPIRY_SECONDS = 15 * 60;
const FILE_THUMBNAIL_REDIRECT_CACHE_CONTROL = "private, max-age=300";

type ReadFileThumbnailOptions = {
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

/**
 * Redirect to the WebP thumbnail of a matter image file.
 *
 * The field is resolved through the same workspace-bound, tombstone-excluding
 * lookup as the file itself, so a field from another matter answers 404. A
 * file without a generated thumbnail, or an encrypted one, answers 404 too.
 */
export const readFileThumbnail = async ({
  fieldId,
  organizationId,
  recordAuditEvent,
  scopedDb,
  workspaceId,
}: ReadFileThumbnailOptions) => {
  const row = (await fileFieldQuery(scopedDb, fieldId, workspaceId)).at(0);
  if (row?.content.type !== "file") {
    return status(404);
  }
  const content = row.content;
  const thumbnailFileId = content.thumbnailFileId;
  if (!thumbnailFileId || content.encrypted) {
    return status(404);
  }

  const presignedUrl = await scopedDb(
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
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: presignedUrl,
      "Cache-Control": FILE_THUMBNAIL_REDIRECT_CACHE_CONTROL,
    },
  });
};
