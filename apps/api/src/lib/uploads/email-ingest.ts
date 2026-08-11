/**
 * `email_ingest` purpose: a presigned-upload flow that parses an
 * uploaded email (`.eml` / `.msg`) server-side and fans it out into a
 * `message`-kind entity (storing the email file) plus one child entity
 * per parsed attachment.
 *
 * Mirrors `finalizeEntityCreate` (file-object minting, entity /
 * entityVersion / field inserts, audit log, workspace `lastActivityAt`
 * bump, pending-upload finalize marker, post-promote enqueues) but:
 *
 *   - The message file went through the normal tmp/scan path, so it is
 *     promoted from `tmp/` like any other purpose.
 *   - Each attachment is server-extracted (no tmp object). Every attachment
 *     is security-scanned before any final object is written. A rejected or
 *     unscannable attachment rejects the whole ingest, because the original
 *     MIME message would otherwise retain bytes that were omitted from the
 *     entity tree.
 *
 * On transaction failure every materialized S3 object (the message file
 * plus every accepted attachment) is deleted so no orphaned final
 * objects remain.
 */
import { Result, panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  PendingUploadFinalizedResult,
  PendingUploadPurposeData,
} from "@/api/db/schema";
import {
  entities,
  entityVersions,
  fields,
  pendingUploads,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { scanFile } from "@/api/lib/file-scan/scan";
import {
  parseEmail,
  resolveEmailAttachmentMimeType,
  type EmailAttachment,
} from "@/api/lib/files/email-to-html";
import {
  deriveFileObject,
  fileContentWithMintedObject,
  type MintedFileId,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import { isEncryptedPdf } from "@/api/lib/files/pdf-utils";
import { createFileKey } from "@/api/lib/files/utils";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { mapWithConcurrency } from "@/api/lib/map-with-concurrency";
import { deleteS3ObjectWithSignal, writeS3ObjectWithRetry } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import {
  resolveStoredEmailFileName,
  emailIngestFinalObjectCleanupFailure,
  validateEmailAttachmentCount,
  validateEmailAttachmentMimeType,
  validateEmailIngestContainer,
} from "@/api/lib/uploads/email-ingest-policy";
import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  resolveEntityCreateFileName,
  type EntityCreateWriteFailureStatus,
} from "@/api/lib/uploads/entity-create";
import {
  finalizeErr,
  finalizeOk,
  renewFinalizeClaim,
  UploadFinalizeError,
} from "@/api/lib/uploads/runtime";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/** Default MIME for attachments the parser could not classify. */
const FALLBACK_ATTACHMENT_MIME = "application/octet-stream";

/** Default filename for attachments with no usable name from the parser. */
const FALLBACK_ATTACHMENT_NAME = "attachment";

/** Fallback message-entity name when the email has no subject. */
const NO_SUBJECT_NAME = "(No subject)";

const ATTACHMENT_ENTITY_KIND = "document" as const;
const ATTACHMENT_PREPARATION_CONCURRENCY = 4;
const ATTACHMENT_PUBLICATION_CONCURRENCY = 4;
const FINAL_OBJECT_CLEANUP_CONCURRENCY = 50;
const FINAL_OBJECT_CLEANUP_TIMEOUT_MS = 15_000;

type EmailIngestPurposeData = Extract<
  PendingUploadPurposeData,
  { type: "email_ingest" }
>;

export type FinalizeEmailIngestProps = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  /** The email bytes already downloaded from `tmp/{uploadId}` for scanning. */
  fileBuffer: ArrayBuffer;
  declaredName: string;
  declaredMime: string;
  declaredSize: number;
  declaredSha256Hex: string;
  purposeData: EmailIngestPurposeData;
  scanWarnings: string[] | undefined;
  uploadId: SafeId<"pendingUpload">;
  claimRequestId: string;
  promoteTmpObject: (
    finalKey: string,
  ) => Promise<Result<void, UploadFinalizeError>>;
};

/** One attachment that passed scanning and is ready to be written to S3. */
type AcceptedAttachment = {
  buffer: Uint8Array;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileId: MintedFileId;
  finalKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  encrypted: boolean;
  scanWarnings: string[] | undefined;
};

/** One derivative/extraction kickoff issued after the ingest commits. */
type DerivativeKickoff = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  fileName: string;
  mimeType: string;
  encrypted: boolean;
};

const attachmentMimeType = (attachment: EmailAttachment): string =>
  resolveEmailAttachmentMimeType({
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
  }) ?? FALLBACK_ATTACHMENT_MIME;

const attachmentFileName = (attachment: EmailAttachment): string =>
  sanitizeFilename(attachment.fileName ?? FALLBACK_ATTACHMENT_NAME);

const resolveMessageName = (
  subject: string | undefined,
  declaredName: string,
): string => {
  if (subject && subject.length > 0) {
    return subject;
  }
  if (declaredName.trim().length > 0) {
    return declaredName;
  }
  return NO_SUBJECT_NAME;
};

/**
 * Copy a (possibly subarray) view into a tight, standalone ArrayBuffer.
 * A parser may hand back a Uint8Array backed by a larger buffer or a
 * SharedArrayBuffer; downstream helpers expect a plain, exactly-sized
 * ArrayBuffer.
 */
const toArrayBuffer = (view: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
};

type PrepareAttachmentOptions = {
  attachment: EmailAttachment;
  attachmentIndex: number;
  messageEntityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

const prepareAttachment = async ({
  attachment,
  attachmentIndex,
  messageEntityId,
  organizationId,
  uploadId,
  workspaceId,
}: PrepareAttachmentOptions): Promise<
  Result<AcceptedAttachment, UploadFinalizeError>
> => {
  const fileName = attachmentFileName(attachment);
  const mimeType = attachmentMimeType(attachment);
  const buffer = attachment.bytes;

  const attachmentTypeResult = validateEmailAttachmentMimeType(
    buffer,
    mimeType,
  );
  if (Result.isError(attachmentTypeResult)) {
    return attachmentTypeResult;
  }

  const scanResult = await scanFile({
    buffer,
    declaredMimeType: mimeType,
    fileName,
  });
  if (Result.isError(scanResult)) {
    captureError(scanResult.error, { messageEntityId, mimeType });
    return finalizeErr({
      status: 500,
      message: `Security scan failed for attachment: ${fileName}`,
      rejectReason: "attachment-scan-error",
    });
  }
  if (scanResult.value.verdict === "reject") {
    const reason = scanResult.value.findings
      .filter((finding) => finding.severity === "reject")
      .map((finding) => finding.message)
      .join("; ");
    return finalizeErr({
      status: 422,
      message: `Attachment rejected: ${fileName}`,
      rejectReason: reason || "attachment-scan-rejected",
    });
  }
  const scanWarnings =
    scanResult.value.verdict === "warn"
      ? scanResult.value.findings
          .filter((finding) => finding.severity === "warn")
          .map((finding) => finding.message)
      : undefined;

  let encrypted = false;
  if (mimeType === PDF_MIME_TYPE) {
    const encryptedResult = await isEncryptedPdf(toArrayBuffer(buffer));
    if (Result.isError(encryptedResult)) {
      captureError(encryptedResult.error, { messageEntityId, mimeType });
      return finalizeErr({
        status: 422,
        message: `Could not open PDF attachment: ${fileName}`,
        rejectReason: "attachment-pdf-open-failed",
      });
    }
    encrypted = encryptedResult.value;
  }

  const fileId = deriveFileObject({
    namespace: uploadId,
    slot: `attachment:${attachmentIndex}`,
  });
  const finalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });
  const sha256Hex = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
  return Result.ok({
    buffer,
    entityId: createSafeId<"entity">(),
    entityVersionId: createSafeId<"entityVersion">(),
    fieldId: createSafeId<"field">(),
    fileId,
    finalKey,
    fileName,
    mimeType,
    sizeBytes: buffer.byteLength,
    sha256Hex,
    encrypted,
    scanWarnings,
  });
};

/**
 * Domain transaction for `email_ingest`. Called by the generic
 * finalize runtime after the email file passed scanning. Promotes the
 * email object, parses it, materializes each accepted attachment, then
 * commits the message entity plus its attachment children in one tx.
 *
 * @yields safeDb errors out to the parent safe-handler.
 */
export const finalizeEmailIngest = async function* ({
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
  claimRequestId,
  promoteTmpObject,
}: FinalizeEmailIngestProps) {
  const containerResult = validateEmailIngestContainer(
    new Uint8Array(fileBuffer),
    declaredMime,
  );
  if (Result.isError(containerResult)) {
    return containerResult;
  }
  const parsedResult = await Result.tryPromise(
    async () => await parseEmail(fileBuffer, declaredMime),
  );
  if (Result.isError(parsedResult)) {
    captureError(parsedResult.error, { uploadId, mimeType: declaredMime });
    return finalizeErr({
      status: 422,
      message: "Could not parse the email file",
      rejectReason: "email-parse-failed",
    });
  }
  const parsed = parsedResult.value;

  const attachmentCountResult = validateEmailAttachmentCount(
    parsed.attachments.length,
  );
  if (Result.isError(attachmentCountResult)) {
    return attachmentCountResult;
  }

  const messageName = sanitizeFilename(
    resolveMessageName(parsed.subject?.trim(), declaredName),
  );

  // The email file went through the normal tmp/scan path, so it is
  // promoted from `tmp/` just like any other file-backed purpose.
  let messageEncrypted = false;
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
    messageEncrypted = encryptedResult.value;
  }

  const messageFileId = deriveFileObject({
    namespace: uploadId,
    slot: "message",
  });
  const messageEntityId = createSafeId<"entity">();
  const messageEntityVersionId = createSafeId<"entityVersion">();
  const messageFieldId = createSafeId<"field">();
  const messageFinalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: messageFileId,
    mimeType: declaredMime,
  });

  // Scan and inspect every attachment before storing the original MIME file.
  // Whole-ingest rejection prevents rejected bytes from remaining recoverable
  // through the stored message object.
  const preparedResults = await mapWithConcurrency({
    items: parsed.attachments,
    limit: ATTACHMENT_PREPARATION_CONCURRENCY,
    operation: async (attachment, attachmentIndex) =>
      await prepareAttachment({
        attachment,
        attachmentIndex,
        messageEntityId,
        organizationId,
        uploadId,
        workspaceId,
      }),
  });
  const preparationFailure = preparedResults.find(Result.isError);
  if (preparationFailure) {
    return preparationFailure;
  }
  const accepted = preparedResults.map((result) => {
    if (Result.isError(result)) {
      panic("Email attachment preparation was not exhaustive");
    }
    return result.value;
  });

  // Track every retry-stable final key so a tx or write failure can clean it.
  // The keys derive from uploadId + slot, allowing a retry or repair pass to
  // locate an object even if this process dies immediately after its write.
  const writtenKeys = [
    messageFinalKey,
    ...accepted.map((attachment) => attachment.finalKey),
  ];

  const recoveryRows = yield* Result.await(
    safeDb(
      async (tx) =>
        // audit: skip — durable storage-recovery metadata for this claim.
        await tx
          .update(pendingUploads)
          .set({
            purposeData: { ...purposeData, recoveryObjectKeys: writtenKeys },
          })
          .where(
            and(
              eq(pendingUploads.id, uploadId),
              eq(pendingUploads.userId, userId),
              eq(pendingUploads.workspaceId, workspaceId),
              eq(pendingUploads.status, "scanning"),
              eq(pendingUploads.claimedByRequestId, claimRequestId),
            ),
          )
          .returning({ id: pendingUploads.id }),
    ),
  );
  if (!recoveryRows.at(0)) {
    return finalizeErr({
      status: 409,
      message: "Email ingest claim was lost before storage publication",
      rejectReason: "email-ingest-claim-lost",
    });
  }

  const cleanupFinalObjects = async (
    stage: string,
  ): Promise<Result<void, UploadFinalizeError>> => {
    const renewal = await renewFinalizeClaim({
      claimRequestId,
      safeDb,
      uploadId,
      userId,
      workspaceId,
    });
    if (Result.isError(renewal) || !renewal.value) {
      captureError(
        Result.isError(renewal)
          ? renewal.error
          : new UploadFinalizeError({
              message: "Email ingest claim was lost before object cleanup",
              status: 409,
            }),
        { stage, messageEntityId, uploadId },
      );
      return Result.err(
        new UploadFinalizeError({
          status: 500,
          message: "Could not establish ownership for email ingest cleanup",
          rejectReason: "final-object-cleanup-failed",
        }),
      );
    }

    const cleanupResults = await mapWithConcurrency({
      items: writtenKeys,
      limit: FINAL_OBJECT_CLEANUP_CONCURRENCY,
      operation: async (key) =>
        await Result.tryPromise({
          try: async () =>
            await withTimeout(
              async (signal) => await deleteS3ObjectWithSignal(key, signal),
              {
                label: "email-ingest-final-object-cleanup",
                timeoutMs: FINAL_OBJECT_CLEANUP_TIMEOUT_MS,
              },
            ),
          catch: (cause) => cause,
        }),
    });
    const failedCleanup = cleanupResults.find(Result.isError);
    if (failedCleanup) {
      captureError(failedCleanup.error, {
        stage,
        messageEntityId,
        uploadId,
      });
      return Result.err(emailIngestFinalObjectCleanupFailure());
    }
    return Result.ok(undefined);
  };

  const promoteResult = await promoteTmpObject(messageFinalKey);
  if (Result.isError(promoteResult)) {
    return promoteResult;
  }

  // Server-extracted attachments have no tmp object to promote. Bounded
  // retry uses the deterministic final keys above, so repeated writes are
  // idempotent after a timeout or finalize retry.
  const writeResults = await mapWithConcurrency({
    items: accepted,
    limit: ATTACHMENT_PUBLICATION_CONCURRENCY,
    operation: async (attachment) =>
      await Result.tryPromise(async () => {
        await writeS3ObjectWithRetry({
          contentType: attachment.mimeType,
          data: attachment.buffer,
          key: attachment.finalKey,
        });
      }),
  });
  const writeFailures = writeResults.filter(Result.isError);
  if (writeFailures.length > 0) {
    for (const failure of writeFailures) {
      captureError(failure.error, {
        messageEntityId,
        stage: "attachment-write",
      });
    }
    const cleanupResult = await cleanupFinalObjects("attachment-write-failed");
    if (Result.isError(cleanupResult)) {
      return cleanupResult;
    }
    return finalizeErr({
      status: 500,
      message: "Failed to store an email attachment",
      rejectReason: "attachment-write-failed",
    });
  }

  const parentId = purposeData.parentId ?? null;

  type WriteResult =
    | {
        status: "ok";
        finalized: Extract<
          PendingUploadFinalizedResult,
          { type: "email_ingest" }
        >;
      }
    | { status: EntityCreateWriteFailureStatus };

  const writeResultResult = await safeDb(async (tx): Promise<WriteResult> => {
    const capacityResult = await checkEntityCreateCapacityForInsert({
      tx,
      workspaceId,
      entityCount: 1 + accepted.length,
      excludeUploadId: uploadId,
    });
    if (Result.isError(capacityResult)) {
      return { status: capacityResult.error };
    }

    // Validates the file property + folder parent for the MESSAGE.
    const targetResult = await checkEntityCreateTargetForInsert({
      tx,
      workspaceId,
      propertyId: purposeData.propertyId,
      parentId,
    });
    if (Result.isError(targetResult)) {
      return { status: targetResult.error };
    }
    const propertyId = targetResult.value.propertyId;

    const renamed = await resolveEntityCreateFileName({
      tx,
      workspaceId,
      propertyId,
      parentId,
      name: messageName,
    });
    const storedMessageFileName = resolveStoredEmailFileName(
      renamed.value,
      declaredMime,
    );
    const stamps = await allocateEntityStamps(
      tx,
      workspaceId,
      accepted.length + 1,
    );
    const messageStamp = stamps.at(0);
    if (!messageStamp) {
      panic("Email ingest stamp allocation returned no message stamp");
    }
    const attachmentRows = accepted.map((attachment, index) => {
      const stamp = stamps.at(index + 1);
      if (!stamp) {
        panic("Email ingest stamp allocation returned too few stamps");
      }
      return { attachment, stamp };
    });

    await tx.insert(entities).values({
      id: messageEntityId,
      workspaceId,
      kind: "message",
      parentId,
      name: renamed.value,
      createdBy: userId,
      docSequence: messageStamp.docSequence,
    });
    await tx.insert(entityVersions).values({
      id: messageEntityVersionId,
      workspaceId,
      entityId: messageEntityId,
      versionNumber: 1,
      stamp: messageStamp.stamp,
      verificationCode: messageStamp.verificationCode,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: messageEntityVersionId })
      .where(eq(entities.id, messageEntityId));
    await tx.insert(fields).values({
      id: messageFieldId,
      workspaceId,
      propertyId,
      entityVersionId: messageEntityVersionId,
      content: fileContentWithMintedObject({
        type: "file",
        version: 1,
        id: messageFileId,
        fileName: storedMessageFileName,
        mimeType: declaredMime,
        sizeBytes: declaredSize,
        encrypted: messageEncrypted,
        sha256Hex: declaredSha256Hex,
        pdfFileId: null,
        pdfDerivative: pdfDerivativeStateForFile({
          encrypted: messageEncrypted,
          mimeType: declaredMime,
        }),
        thumbnailFileId: null,
        thumbnailDerivative: thumbnailDerivativeStateForFile({
          encrypted: messageEncrypted,
          mimeType: declaredMime,
        }),
        ...(scanWarnings !== undefined && { scanWarnings }),
      }),
    });

    const auditEvents: AuditEvent[] = [
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: messageEntityId,
        changes: {
          created: {
            old: null,
            new: {
              kind: "message",
              fileName: storedMessageFileName,
              mimeType: declaredMime,
              sizeBytes: declaredSize,
              propertyId,
              parentId,
            },
          },
        },
      },
    ];

    // Attachment children hang off the message entity we just created.
    // The message is a valid container, so children skip the
    // folder-only parent check.
    if (attachmentRows.length > 0) {
      await tx.insert(entities).values(
        attachmentRows.map(({ attachment, stamp }) => ({
          id: attachment.entityId,
          workspaceId,
          kind: ATTACHMENT_ENTITY_KIND,
          parentId: messageEntityId,
          name: attachment.fileName,
          createdBy: userId,
          docSequence: stamp.docSequence,
        })),
      );
      await tx.insert(entityVersions).values(
        attachmentRows.map(({ attachment, stamp }) => ({
          id: attachment.entityVersionId,
          workspaceId,
          entityId: attachment.entityId,
          versionNumber: 1,
          stamp: stamp.stamp,
          verificationCode: stamp.verificationCode,
        })),
      );
      const currentVersionCases = attachmentRows.map(
        ({ attachment }) =>
          sql`when ${attachment.entityId} then ${attachment.entityVersionId}`,
      );
      await tx
        .update(entities)
        .set({
          currentVersionId: sql`case ${entities.id} ${sql.join(currentVersionCases, sql` `)} else ${entities.currentVersionId} end`,
        })
        .where(
          inArray(
            entities.id,
            attachmentRows.map(({ attachment }) => attachment.entityId),
          ),
        );
      await tx.insert(fields).values(
        attachmentRows.map(({ attachment }) => ({
          id: attachment.fieldId,
          workspaceId,
          propertyId,
          entityVersionId: attachment.entityVersionId,
          content: fileContentWithMintedObject({
            type: "file",
            version: 1,
            id: attachment.fileId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            encrypted: attachment.encrypted,
            sha256Hex: attachment.sha256Hex,
            pdfFileId: null,
            pdfDerivative: pdfDerivativeStateForFile({
              encrypted: attachment.encrypted,
              mimeType: attachment.mimeType,
            }),
            thumbnailFileId: null,
            thumbnailDerivative: thumbnailDerivativeStateForFile({
              encrypted: attachment.encrypted,
              mimeType: attachment.mimeType,
            }),
            ...(attachment.scanWarnings !== undefined && {
              scanWarnings: attachment.scanWarnings,
            }),
          }),
        })),
      );

      auditEvents.push(
        ...attachmentRows.map(({ attachment }): AuditEvent => ({
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: attachment.entityId,
          changes: {
            created: {
              old: null,
              new: {
                kind: "document",
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                propertyId,
                parentId: messageEntityId,
              },
            },
          },
        })),
      );
    }
    await recordAuditEvent(tx, auditEvents);

    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    const finalized: Extract<
      PendingUploadFinalizedResult,
      { type: "email_ingest" }
    > = {
      type: "email_ingest",
      entityId: messageEntityId,
      fieldId: messageFieldId,
      fileId: messageFileId,
      fileName: storedMessageFileName,
      renamed: renamed.renamed,
      attachmentEntityIds: accepted.map((attachment) => attachment.entityId),
    };

    // audit: skip — final FSM transition on pending_uploads; the
    // entity-level audit rows landed above in this same transaction.
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
          eq(pendingUploads.userId, userId),
          eq(pendingUploads.workspaceId, workspaceId),
          eq(pendingUploads.status, "scanning"),
          eq(pendingUploads.claimedByRequestId, claimRequestId),
        ),
      )
      .returning({ id: pendingUploads.id });
    if (!finalizedRows.at(0)) {
      panic("Pending upload finalize marker update returned no rows");
    }

    return { status: "ok", finalized };
  });
  if (Result.isError(writeResultResult)) {
    const cleanupResult = await cleanupFinalObjects(
      "final-cleanup-after-db-error",
    );
    if (Result.isError(cleanupResult)) {
      return cleanupResult;
    }
  }
  const writeResult = yield* writeResultResult;
  if (writeResult.status !== "ok") {
    const cleanupResult = await cleanupFinalObjects(
      "final-cleanup-after-business-error",
    );
    if (Result.isError(cleanupResult)) {
      return cleanupResult;
    }
    return finalizeErr({
      status: 400,
      message: entityCreateWriteErrorMessage(writeResult.status),
      rejectReason: writeResult.status,
    });
  }
  const { finalized } = writeResult;

  const afterPromote = () => {
    const kickoffs: DerivativeKickoff[] = [
      {
        entityId: messageEntityId,
        mimeType: declaredMime,
        fieldId: messageFieldId,
        fileName: finalized.fileName,
        encrypted: messageEncrypted,
      },
    ];
    for (const attachment of accepted) {
      kickoffs.push({
        entityId: attachment.entityId,
        mimeType: attachment.mimeType,
        fieldId: attachment.fieldId,
        fileName: attachment.fileName,
        encrypted: attachment.encrypted,
      });
    }

    for (const kickoff of kickoffs) {
      processExtraction(kickoff.entityId).catch((error: unknown) => {
        captureError(error, {
          entityId: kickoff.entityId,
          mimeType: kickoff.mimeType,
        });
      });
      maybeStartUploadTriggeredFlows({
        entityId: kickoff.entityId,
        workspaceId,
        organizationId,
        fileName: kickoff.fileName,
      }).catch((error: unknown) => {
        captureError(error, {
          entityId: kickoff.entityId,
          workspaceId,
        });
      });
      enqueuePdfDerivativeOrMarkFailed({
        encrypted: kickoff.encrypted,
        entityId: kickoff.entityId,
        fieldId: kickoff.fieldId,
        mimeType: kickoff.mimeType,
        organizationId,
        userId,
        workspaceId,
      }).catch((error: unknown) => {
        captureError(error, {
          entityId: kickoff.entityId,
          fieldId: kickoff.fieldId,
          mimeType: kickoff.mimeType,
        });
      });
      enqueueImageThumbnailOrMarkFailed({
        encrypted: kickoff.encrypted,
        entityId: kickoff.entityId,
        fieldId: kickoff.fieldId,
        mimeType: kickoff.mimeType,
        organizationId,
        userId,
        workspaceId,
      }).catch((error: unknown) => {
        captureError(error, {
          entityId: kickoff.entityId,
          fieldId: kickoff.fieldId,
          mimeType: kickoff.mimeType,
        });
      });
    }
  };

  return finalizeOk({
    finalizedResult: finalized,
    finalKey: messageFinalKey,
    afterPromote,
  });
};

/** Local re-export so the generic dispatcher can narrow on it. */
export { UploadFinalizeError };
