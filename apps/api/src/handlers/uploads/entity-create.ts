/**
 * `entity_create` purpose: a presigned-upload flow that ends in a
 * new `entities` row + first `entityVersions` + first `fields`
 * record, exactly like the legacy multipart endpoint at
 * `apps/api/src/handlers/entities/upload.ts`.
 *
 * Splits into two callbacks consumed by the generic presign /
 * finalize dispatchers:
 *
 * - `validateEntityCreate`: cheap up-front checks (workspace
 *   entity-count limit, property existence + type) so the API
 *   can refuse to issue a URL the user couldn't redeem anyway.
 *
 * - `finalizeEntityCreate`: the transactional domain step.
 *   Reuses `resolveFileName` (filename de-duplication) and
 *   `allocateEntityStamp` (workspace doc-sequence) from the
 *   existing slice. Mirrors the original handler's audit log,
 *   workspace `lastActivityAt` bump, and post-promote PDF-derivative
 *   + extraction enqueues.
 */
import { Result, panic } from "better-result";
import { and, eq, like } from "drizzle-orm";

import type { SafeDb, Transaction } from "@/api/db";
import { jsonField } from "@/api/db/json-utils";
import type {
  PendingUploadFinalizedResult,
  PendingUploadPurposeData,
} from "@/api/db/schema";
import {
  entities,
  entityVersions,
  fields,
  pendingUploads,
  properties,
  workspaces,
} from "@/api/db/schema";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { isEncryptedPdf } from "@/api/handlers/files/pdf-utils";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import { UploadFinalizeError, finalizeErr, finalizeOk } from "./lib";

const MAX_FILENAME_LENGTH = 255;

type ResolveFileNameProps = {
  tx: Transaction;
  propertyId: SafeId<"property">;
  name: SanitizedFileName;
};

const resolveFileName = async ({
  tx,
  propertyId,
  name,
}: ResolveFileNameProps) => {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot === -1 ? name : name.slice(0, lastDot);
  const ext = lastDot === -1 ? "" : name.slice(lastDot);
  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;

  const fieldsCount = await tx.$count(
    fields,
    and(
      eq(fields.propertyId, propertyId),
      like(jsonField(fields.content, "v1")("fileName"), pattern),
    ),
  );

  if (fieldsCount === 0) {
    return { renamed: false as const, value: name };
  }

  const suffix = `_${fieldsCount}`;
  const maxBase = MAX_FILENAME_LENGTH - suffix.length - ext.length;
  const truncatedBase = maxBase > 0 ? base.slice(0, maxBase) : base;

  // SAFETY: name is already sanitized; the suffix is digits and underscore only
  return {
    renamed: true as const,
    value: sanitizeFilename(`${truncatedBase}${suffix}${ext}`),
  };
};

export type ValidateEntityCreateProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
};

/**
 * Cheap pre-flight: entity-count limit + property exists + property
 * is of `file` type. Mirrors the gating the legacy upload handler
 * runs at the top of its body.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const validateEntityCreate = async function* ({
  safeDb,
  workspaceId,
  propertyId,
}: ValidateEntityCreateProps) {
  const [entityCountResult, propertyResult] = await Promise.all([
    safeDb((tx) => tx.$count(entities, eq(entities.workspaceId, workspaceId))),
    safeDb((tx) =>
      tx.query.properties.findFirst({
        columns: { id: true, content: true },
        where: { id: { eq: propertyId }, workspaceId: { eq: workspaceId } },
      }),
    ),
  ]);

  const entityCount = yield* entityCountResult;
  const property = yield* propertyResult;

  if (entityCount >= LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Entities limit reached" }),
    );
  }
  if (!property) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Property not found in workspace",
      }),
    );
  }
  if (property.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 400, message: "Property isn't of type file" }),
    );
  }

  return Result.ok(undefined);
};

export type FinalizeEntityCreateProps = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  /** The bytes already downloaded from `tmp/{uploadId}` for scanning. */
  fileBuffer: ArrayBuffer;
  declaredName: string;
  declaredMime: string;
  declaredSize: number;
  declaredSha256Hex: string;
  purposeData: Extract<PendingUploadPurposeData, { type: "entity_create" }>;
  scanWarnings: string[] | undefined;
  uploadId: SafeId<"pendingUpload">;
  promoteTmpObject: (
    finalKey: string,
  ) => Promise<Result<void, UploadFinalizeError>>;
};

/**
 * Domain transaction for `entity_create`. Called by the generic
 * finalize runtime after scan-pass. It promotes the staged object
 * before committing DB rows that point at the final key. Returns the
 * same response shape as the legacy multipart handler so the web UI
 * doesn't need a discriminated response type.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const finalizeEntityCreate = async function* ({
  safeDb,
  recordAuditEvent,
  organizationId,
  workspaceId,
  userId,
  fileBuffer,
  declaredName,
  declaredMime,
  declaredSize,
  declaredSha256Hex,
  purposeData,
  scanWarnings,
  uploadId,
  promoteTmpObject,
}: FinalizeEntityCreateProps) {
  const sanitizedName = sanitizeFilename(declaredName);

  // PDF encryption check matches the legacy handler — we still
  // need to know whether to enqueue a PDF derivative or mark it
  // failed up front. The byte buffer is in memory anyway because
  // the finalize runtime had to download it for scanning.
  let encrypted = false;
  if (declaredMime === PDF_MIME_TYPE) {
    const encryptedResult = await isEncryptedPdf(fileBuffer);
    if (Result.isError(encryptedResult)) {
      captureError(encryptedResult.error, {
        mimeType: PDF_MIME_TYPE,
        sizeBytes: String(declaredSize),
      });
      return finalizeErr({
        status: 422,
        message: "Failed to open PDF: file appears corrupted",
        rejectReason: "pdf-open-failed",
      });
    }
    encrypted = encryptedResult.value;
  }

  const fileId = Bun.randomUUIDv7();
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const finalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: declaredMime,
  });

  const promoteResult = await promoteTmpObject(finalKey);
  if (Result.isError(promoteResult)) {
    return promoteResult;
  }

  type WriteResult =
    | {
        status: "ok";
        finalized: Extract<
          PendingUploadFinalizedResult,
          { type: "entity_create" }
        >;
      }
    | { status: "property-not-found" | "property-type-mismatch" };

  const cleanupFinalObject = async (stage: string) => {
    await getS3()
      .delete(finalKey)
      .catch((deleteError: unknown) =>
        captureError(deleteError, {
          entityId,
          fieldId,
          stage,
        }),
      );
  };

  const writeResultResult = await safeDb(async (tx): Promise<WriteResult> => {
    const propertyRows = await tx
      .select({ id: properties.id, content: properties.content })
      .from(properties)
      .where(
        and(
          eq(properties.id, purposeData.propertyId),
          eq(properties.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    const property = propertyRows.at(0);

    if (!property) {
      return { status: "property-not-found" };
    }
    if (property.content.type !== "file") {
      return { status: "property-type-mismatch" };
    }

    const renamed = await resolveFileName({
      tx,
      propertyId: property.id,
      name: sanitizedName,
    });
    const entityStamp = await allocateEntityStamp(tx, workspaceId);

    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      name: renamed.value,
      createdBy: userId,
      docSequence: entityStamp.docSequence,
    });
    await tx.insert(entityVersions).values({
      id: entityVersionId,
      workspaceId,
      entityId,
      versionNumber: 1,
      stamp: entityStamp.stamp,
      verificationCode: entityStamp.verificationCode,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    await tx.insert(fields).values({
      id: fieldId,
      workspaceId,
      propertyId: property.id,
      entityVersionId,
      content: {
        type: "file",
        version: 1,
        id: fileId,
        fileName: renamed.value,
        mimeType: declaredMime,
        sizeBytes: declaredSize,
        encrypted,
        sha256Hex: declaredSha256Hex,
        pdfFileId: null,
        pdfDerivative: pdfDerivativeStateForFile({
          encrypted,
          mimeType: declaredMime,
        }),
        ...(scanWarnings !== undefined && { scanWarnings }),
      },
    });
    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entityId,
      changes: {
        created: {
          old: null,
          new: {
            kind: "document",
            fileName: renamed.value,
            mimeType: declaredMime,
            sizeBytes: declaredSize,
            propertyId: property.id,
          },
        },
      },
    });

    const finalized: Extract<
      PendingUploadFinalizedResult,
      { type: "entity_create" }
    > = {
      type: "entity_create",
      entityId,
      fileId,
      fileName: renamed.value,
      renamed: renamed.renamed,
    };

    // audit: skip — final FSM transition on pending_uploads;
    // the entity-level audit row landed above in this same transaction.
    const finalizedRows = await tx
      .update(pendingUploads)
      .set({
        status: "finalized",
        finalizedResult: finalized,
        finalizedAt: new Date(),
      })
      .where(
        and(
          eq(pendingUploads.id, uploadId),
          eq(pendingUploads.workspaceId, workspaceId),
        ),
      )
      .returning({ id: pendingUploads.id });
    if (!finalizedRows.at(0)) {
      panic("Pending upload finalize marker update returned no rows");
    }

    return { status: "ok", finalized };
  });
  if (Result.isError(writeResultResult)) {
    await cleanupFinalObject("final-cleanup-after-db-error");
  }
  const writeResult = yield* writeResultResult;
  if (writeResult.status !== "ok") {
    await cleanupFinalObject("final-cleanup-after-business-error");
    return finalizeErr({
      status: 400,
      message:
        writeResult.status === "property-not-found"
          ? "Property not found in workspace"
          : "Property isn't of type file",
      rejectReason: writeResult.status,
    });
  }
  const { finalized } = writeResult;

  const afterPromote = () => {
    // Async kickoffs mirror the legacy handler. They run only after
    // both promotion and the DB transaction have succeeded, so
    // consumers never read a final key before it exists.
    processExtraction(entityId).catch((error: unknown) => {
      captureError(error, { entityId, mimeType: declaredMime });
    });
    enqueuePdfDerivativeOrMarkFailed({
      encrypted,
      entityId,
      fieldId,
      mimeType: declaredMime,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, { entityId, fieldId, mimeType: declaredMime });
    });
  };

  return finalizeOk({ finalizedResult: finalized, finalKey, afterPromote });
};

/** Local re-export so the generic dispatcher can narrow on it. */
export { UploadFinalizeError };
