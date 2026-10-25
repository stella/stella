import { panic, Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { buildVersionedApiUrl } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { status } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  CONTENT_DELIVERY_AUDIT_ACTION,
  type ContentDisposition,
} from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { isStampableDocx } from "@/api/lib/docx-stamp";
import { markContentDeliveryIntent } from "@/api/lib/files/content-delivery";
import {
  createFileContentGrant,
  type FileContentPurpose,
} from "@/api/lib/files/file-content-grant";
import { isNativelyRenderableMimeType } from "@/api/lib/files/gotenberg";
import { openWithinDeadline } from "@/api/lib/files/storage-open-deadline";
import { createFileKey } from "@/api/lib/files/utils";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import type { SignedDownloadSource } from "@/api/lib/s3-presign";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { issueSessionBoundCredentialTtl } from "@/api/lib/synthetic-principal/credential-policy";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const FILE_READ_URL_EXPIRY_SECONDS = 15 * 60;
const FILE_READ_STORAGE_TIMEOUT_MS = 30_000;
const refuseBackgroundSessionAuthority: SyntheticSessionAuthorityReader =
  async () => await Promise.resolve(null);

type ReadFileHandlerProps = {
  source: SignedDownloadSource;
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  purpose: FileContentPurpose;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
};

type FileFieldIdentity = {
  fieldId: SafeId<"field">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

const readFileField = async ({ fieldId, tx, workspaceId }: FileFieldIdentity) =>
  await tx
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
    .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
    .limit(1);

type FileFieldRow = {
  content: (typeof fields.$inferSelect)["content"];
  entityId: (typeof entities.$inferSelect)["id"];
  entityName: (typeof entities.$inferSelect)["name"];
  entityVersionId: (typeof entityVersions.$inferSelect)["id"];
  propertyId: (typeof fields.$inferSelect)["propertyId"];
  verificationCode: (typeof entityVersions.$inferSelect)["verificationCode"];
  versionStamp: (typeof entityVersions.$inferSelect)["stamp"];
};

const queryFileField = async ({
  fieldId,
  lockVersion,
  tx,
  workspaceId,
}: FileFieldIdentity & { lockVersion: boolean }): Promise<FileFieldRow[]> => {
  const read = async () => await readFileField({ fieldId, tx, workspaceId });

  // A content redemption holds the version live until object storage has
  // accepted its GET. Tombstoning updates this row and therefore waits; a
  // request that starts after the tombstone instead observes no row.
  const rows = await read();
  const row = rows.at(0);
  if (!lockVersion || !row) {
    return rows;
  }
  const lock = await withAggregateLock({
    aggregate: "entityVersion",
    id: {
      id: brandPersistedEntityVersionId(row.entityVersionId),
      workspaceId,
    },
    mode: "share",
    tx,
  });
  if (lock.status === "missing") {
    return [];
  }
  if (lock.status !== "locked") {
    return panic("Blocking entity version lock did not settle");
  }
  // A version's file field is fixed once written; only its tombstone can
  // change, and it waits for this lock, so its liveness is read again here.
  const live = await tx
    .select({ id: entityVersions.id })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.id, row.entityVersionId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .limit(1);
  return live.length === 0 ? [] : rows;
};

export const fileFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb(
    async (tx) =>
      await queryFileField({ fieldId, lockVersion: false, tx, workspaceId }),
  );

type FileDelivery = {
  disposition: ContentDisposition;
  encrypted: boolean;
  entityId: SafeId<"entity">;
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  s3Key: string;
  sizeBytes?: number;
  stampable: boolean;
};

type FileDeliveryResolution =
  { type: "found"; delivery: FileDelivery } | { type: "invalid" | "not-found" };

const resolveFileDelivery = ({
  organizationId,
  purpose,
  row,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  purpose: FileContentPurpose;
  row: FileFieldRow | undefined;
  workspaceId: SafeId<"workspace">;
}): FileDeliveryResolution => {
  if (!row) {
    return { type: "not-found" };
  }
  if (row.content.type !== "file") {
    return { type: "invalid" };
  }

  const content = row.content;
  const originalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  if (purpose === "download") {
    return {
      type: "found",
      delivery: {
        disposition: "attachment",
        encrypted: content.encrypted,
        entityId: row.entityId,
        fileId: content.id,
        fileName: content.fileName,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        s3Key: originalKey,
        sizeBytes: content.sizeBytes,
        stampable:
          !!row.versionStamp &&
          !!row.verificationCode &&
          isStampableDocx(content.mimeType, content.sizeBytes) &&
          !content.encrypted,
      },
    };
  }

  if (
    purpose === "native-display" &&
    !isNativelyRenderableMimeType(content.mimeType)
  ) {
    return { type: "invalid" };
  }
  if (
    purpose === "native-display" ||
    isNativelyRenderableMimeType(content.mimeType)
  ) {
    return {
      type: "found",
      delivery: {
        disposition: "inline",
        encrypted: content.encrypted,
        entityId: row.entityId,
        fileId: content.id,
        fileName: content.fileName,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        s3Key: originalKey,
        sizeBytes: content.sizeBytes,
        stampable: false,
      },
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE) {
    return { type: "invalid" };
  }
  const displayFileId = content.pdfFileId ?? content.id;
  return {
    type: "found",
    delivery: {
      disposition: "inline",
      encrypted: content.encrypted,
      entityId: row.entityId,
      fileId: displayFileId,
      fileName: content.fileName,
      mimeType: PDF_MIME_TYPE,
      originalMimeType: content.mimeType,
      s3Key: createFileKey({
        organizationId,
        workspaceId,
        fileId: displayFileId,
        mimeType: PDF_MIME_TYPE,
      }),
      stampable: false,
    },
  };
};

const fileContentGrantUrl = (grant: string): string =>
  buildVersionedApiUrl(
    env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
    `/file-content/${encodeURIComponent(grant)}`,
  );

export const readFileHandler = async ({
  scopedDb,
  source,
  fieldId,
  organizationId,
  workspaceId,
  userId,
  purpose,
  recordAuditEvent,
  readSessionAuthority,
}: ReadFileHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);
  const resolution = resolveFileDelivery({
    organizationId,
    purpose,
    row,
    workspaceId,
  });
  if (resolution.type !== "found") {
    return resolution.type === "not-found" ? status(404) : status(400);
  }

  const delivery: FileDelivery = resolution.delivery;
  const now = Temporal.Now.instant().epochMilliseconds;
  const expiresIn = await issueSessionBoundCredentialTtl("signedDownload", {
    userId,
    organizationId,
    fileOrganizationId: organizationId,
    requestedTtlSeconds: FILE_READ_URL_EXPIRY_SECONDS,
    now: new Date(now),
    sessionId: source.kind === "request" ? source.sessionId : null,
    readSessionAuthority:
      source.kind === "request"
        ? readSessionAuthority
        : refuseBackgroundSessionAuthority,
  });
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: CONTENT_DELIVERY_AUDIT_ACTION[delivery.disposition],
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: delivery.entityId,
        metadata: {
          disposition: delivery.disposition,
          fieldId,
          mimeType: delivery.mimeType,
          purpose,
          s3Key: delivery.s3Key,
          ...(delivery.disposition === "attachment"
            ? { fileName: delivery.fileName }
            : {}),
          ...(delivery.sizeBytes === undefined
            ? {}
            : { sizeBytes: delivery.sizeBytes }),
        },
      }),
  );
  const grant = createFileContentGrant({
    expiresAt: now + expiresIn * 1000,
    fieldId,
    now,
    organizationId,
    purpose,
    secret: env.BETTER_AUTH_SECRET,
    userId,
    workspaceId,
  });
  markContentDeliveryIntent();
  return {
    fileId: delivery.fileId,
    mimeType: delivery.mimeType,
    originalMimeType: delivery.originalMimeType,
    fileName: delivery.fileName,
    encrypted: delivery.encrypted,
    // Kept for client compatibility; this is now a Stella grant URL whose
    // redemption rechecks version liveness, rather than a direct S3 URL.
    presignedUrl: fileContentGrantUrl(grant),
    stampable: delivery.stampable,
  };
};

type ReadFileContentHandlerProps = {
  abortSignal: AbortSignal;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  purpose: FileContentPurpose;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readFileContentHandler = async ({
  abortSignal,
  fieldId,
  organizationId,
  purpose,
  scopedDb,
  workspaceId,
}: ReadFileContentHandlerProps) => {
  const result = await scopedDb(async (tx) => {
    const rows = await queryFileField({
      fieldId,
      lockVersion: true,
      tx,
      workspaceId,
    });
    const resolution = resolveFileDelivery({
      organizationId,
      purpose,
      row: rows.at(0),
      workspaceId,
    });
    if (resolution.type !== "found") {
      return resolution;
    }
    const { delivery } = resolution;
    // The deadline bounds the open; the body then streams for as long as
    // the client keeps reading, and stops when it disconnects.
    const opened = await Result.tryPromise(
      async () =>
        await openWithinDeadline({
          open: async (signal) =>
            await openS3ObjectStreamWithSignal(delivery.s3Key, signal),
          signal: abortSignal,
          timeoutMs: FILE_READ_STORAGE_TIMEOUT_MS,
        }),
    );
    if (Result.isError(opened)) {
      abortSignal.throwIfAborted();
      return { type: "storage-failure" as const };
    }
    return { type: "response" as const, delivery, source: opened.value };
  });

  switch (result.type) {
    case "invalid":
      return status(400);
    case "not-found":
      return status(404);
    case "storage-failure":
      return status(502);
    case "response": {
      return secureDocumentResponse({
        body: result.source.body,
        ...(result.source.contentLength === undefined
          ? {}
          : { contentLength: result.source.contentLength }),
        contentType: result.delivery.mimeType,
        disposition: result.delivery.disposition,
        fileName: sanitizeFilename(result.delivery.fileName),
      });
    }
    default:
      result satisfies never;
      return panic("Unhandled file content delivery result");
  }
};
