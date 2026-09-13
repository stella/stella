import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { isStampableDocx } from "@/api/lib/docx-stamp";
import { isNativelyRenderableMimeType } from "@/api/lib/files/gotenberg";
import { createFileKey } from "@/api/lib/files/utils";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const FILE_READ_URL_EXPIRY_SECONDS = 15 * 60;

type FilePurpose = "download" | "display" | "native-display";

type ReadFileHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
  recordAuditEvent: AuditRecorder;
};

export const fileFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        entityName: entities.name,
        entityVersionId: entityVersions.id,
        propertyId: fields.propertyId,
        versionStamp: entityVersions.stamp,
        verificationCode: entityVersions.verificationCode,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      // Exclude tombstoned versions: a withdrawn version's bytes are retained
      // under legal hold but must be unreachable, even to a client that
      // captured the fieldId before the version was tombstoned.
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

export const readFileHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  purpose,
  recordAuditEvent,
}: ReadFileHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) return status(404);
  if (row.content.type !== "file") return status(400);

  const content = row.content;
  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  if (purpose === "download") {
    const presignedUrl = await scopedDb(
      async (tx) =>
        await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          s3Key: fileKey,
          expiresInSeconds: FILE_READ_URL_EXPIRY_SECONDS,
          fileName: content.fileName,
          organizationId,
          workspaceId,
          metadata: {
            fieldId,
            mimeType: content.mimeType,
            sizeBytes: content.sizeBytes,
          },
        }),
    );
    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl,
      stampable:
        !!row.versionStamp &&
        !!row.verificationCode &&
        isStampableDocx(content.mimeType, content.sizeBytes) &&
        !content.encrypted,
    };
  }

  if (
    purpose === "native-display" &&
    !isNativelyRenderableMimeType(content.mimeType)
  ) {
    return status(400);
  }

  if (
    purpose === "native-display" ||
    isNativelyRenderableMimeType(content.mimeType)
  ) {
    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: await presignDownloadUrl(fileKey, {
        expiresIn: FILE_READ_URL_EXPIRY_SECONDS,
        scope: { organizationId, workspaceId },
      }),
      stampable: false,
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE)
    return status(400);
  const displayFileId = content.pdfFileId ?? content.id;
  const displayFileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: displayFileId,
    mimeType: PDF_MIME_TYPE,
  });
  return {
    fileId: displayFileId,
    mimeType: PDF_MIME_TYPE,
    originalMimeType: content.mimeType,
    fileName: content.fileName,
    encrypted: content.encrypted,
    presignedUrl: await presignDownloadUrl(displayFileKey, {
      expiresIn: FILE_READ_URL_EXPIRY_SECONDS,
      scope: { organizationId, workspaceId },
    }),
    stampable: false,
  };
};
