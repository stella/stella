import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { isStampableDocx } from "@/api/lib/docx-stamp";
import { isNativelyRenderableMimeType } from "@/api/lib/files/gotenberg";
import { createFileKey } from "@/api/lib/files/utils";
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

  if (!row) {
    return status(404);
  }
  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;
  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  // Every purpose grants the stored bytes through the audited helper; `purpose`
  // and the delivered object identify what the caller received.
  const grantUrl = async ({
    s3Key,
    fileName,
    mimeType,
    sizeBytes,
  }: {
    s3Key: string;
    fileName?: string;
    mimeType: string;
    // Known for the stored original only, not for a derived rendition.
    sizeBytes?: number;
  }) =>
    await scopedDb(
      async (tx) =>
        await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          s3Key,
          expiresInSeconds: FILE_READ_URL_EXPIRY_SECONDS,
          ...(fileName === undefined ? {} : { fileName }),
          organizationId,
          workspaceId,
          metadata: {
            fieldId,
            purpose,
            mimeType,
            ...(sizeBytes === undefined ? {} : { sizeBytes }),
          },
        }),
    );

  if (purpose === "download") {
    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: await grantUrl({
        s3Key: fileKey,
        fileName: content.fileName,
        mimeType: content.mimeType,
        sizeBytes: content.sizeBytes,
      }),
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
      presignedUrl: await grantUrl({
        s3Key: fileKey,
        mimeType: content.mimeType,
        sizeBytes: content.sizeBytes,
      }),
      stampable: false,
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE) {
    return status(400);
  }
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
    presignedUrl: await grantUrl({
      s3Key: displayFileKey,
      mimeType: PDF_MIME_TYPE,
    }),
    stampable: false,
  };
};
