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
 *   - Each attachment is server-extracted (no tmp object). Every
 *     attachment is individually security-scanned exactly like a direct
 *     upload; a rejected or unscannable attachment is skipped (recorded
 *     with a reason) and never aborts the whole ingest. Accepted
 *     attachment bytes are written straight to their final S3 key.
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
import {
  parseEmail,
  type EmailAttachment,
} from "@/api/handlers/files/email-to-html";
import {
  allocateFileObject,
  fileContentWithMintedObject,
  type MintedFileId,
} from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { isEncryptedPdf } from "@/api/handlers/files/pdf-utils";
import { createFileKey } from "@/api/handlers/files/utils";
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
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  resolveEntityCreateFileName,
  type EntityCreateWriteFailureStatus,
} from "./entity-create";
import { finalizeErr, finalizeOk, UploadFinalizeError } from "./lib";

/** Upper bound on attachments materialized per email; protects against
 * pathological messages and bounds the work done in the finalize tx. */
const MAX_EMAIL_ATTACHMENTS = 50;

/** Default MIME for attachments the parser could not classify. */
const FALLBACK_ATTACHMENT_MIME = "application/octet-stream";

/** Default filename for attachments with no usable name from the parser. */
const FALLBACK_ATTACHMENT_NAME = "attachment";

/** Fallback message-entity name when the email has no subject. */
const NO_SUBJECT_NAME = "(No subject)";

const ATTACHMENT_ENTITY_KIND = "document" as const;

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

/** One attachment that passed scanning and has had its bytes written to S3. */
type AcceptedAttachment = {
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

type SkippedAttachment = { name: string; reason: string };

type MaterializedAttachment =
  | { attachment: AcceptedAttachment; type: "accepted" }
  | { skipped: SkippedAttachment; type: "skipped" }
  | {
      error: unknown;
      finalKey: string;
      mimeType: string;
      type: "write-failed";
    };

/** One derivative/extraction kickoff issued after the ingest commits. */
type DerivativeKickoff = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  encrypted: boolean;
};

const attachmentMimeType = (attachment: EmailAttachment): string =>
  attachment.mimeType ?? FALLBACK_ATTACHMENT_MIME;

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

type MaterializeAttachmentOptions = {
  attachment: EmailAttachment;
  messageEntityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

const materializeAttachment = async ({
  attachment,
  messageEntityId,
  organizationId,
  workspaceId,
}: MaterializeAttachmentOptions): Promise<MaterializedAttachment> => {
  const fileName = attachmentFileName(attachment);
  const mimeType = attachmentMimeType(attachment);
  const buffer = attachment.bytes;

  const scanResult = await scanFile({
    buffer,
    declaredMimeType: mimeType,
    fileName,
  });
  if (Result.isError(scanResult)) {
    captureError(scanResult.error, { messageEntityId, mimeType });
    return {
      skipped: { name: fileName, reason: "scan-error" },
      type: "skipped",
    };
  }
  if (scanResult.value.verdict === "reject") {
    const reason = scanResult.value.findings
      .filter((finding) => finding.severity === "reject")
      .map((finding) => finding.message)
      .join("; ");
    return {
      skipped: { name: fileName, reason: reason || "scan-rejected" },
      type: "skipped",
    };
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
      return {
        skipped: { name: fileName, reason: "pdf-open-failed" },
        type: "skipped",
      };
    }
    encrypted = encryptedResult.value;
  }

  const fileId = allocateFileObject();
  const finalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });
  const sha256Hex = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
  const writeResult = await Result.tryPromise(
    async () => await getS3().write(finalKey, buffer),
  );
  if (Result.isError(writeResult)) {
    return {
      error: writeResult.error,
      finalKey,
      mimeType,
      type: "write-failed",
    };
  }

  return {
    attachment: {
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
    },
    type: "accepted",
  };
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

  const messageFileId = allocateFileObject();
  const messageEntityId = createSafeId<"entity">();
  const messageEntityVersionId = createSafeId<"entityVersion">();
  const messageFieldId = createSafeId<"field">();
  const messageFinalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: messageFileId,
    mimeType: declaredMime,
  });

  // Track every final object we materialize so a tx failure can clean
  // them all up (message file + each accepted attachment).
  const writtenKeys: string[] = [messageFinalKey];

  const cleanupFinalObjects = async (stage: string) => {
    await Promise.all(
      writtenKeys.map(
        async (key) =>
          await getS3()
            .delete(key)
            .catch((deleteError: unknown) =>
              captureError(deleteError, { key, stage, messageEntityId }),
            ),
      ),
    );
  };

  const promoteResult = await promoteTmpObject(messageFinalKey);
  if (Result.isError(promoteResult)) {
    return promoteResult;
  }

  // Materialize attachments BEFORE the DB tx: each is scanned exactly
  // like a direct upload; rejected / unscannable ones are skipped (with
  // a reason) and never abort the ingest. Accepted bytes are written to
  // their final key here because server-extracted attachments have no
  // tmp object to promote.
  const materialized = await Promise.all(
    parsed.attachments.slice(0, MAX_EMAIL_ATTACHMENTS).map(
      async (attachment) =>
        await materializeAttachment({
          attachment,
          messageEntityId,
          organizationId,
          workspaceId,
        }),
    ),
  );
  const accepted = materialized
    .filter((result) => result.type === "accepted")
    .map(({ attachment }) => attachment);
  const skipped = materialized
    .filter((result) => result.type === "skipped")
    .map(({ skipped: skippedAttachment }) => skippedAttachment);
  const writeFailures = materialized.filter(
    (result) => result.type === "write-failed",
  );
  writtenKeys.push(
    ...accepted.map((attachment) => attachment.finalKey),
    ...writeFailures.map((failure) => failure.finalKey),
  );

  if (writeFailures.length > 0) {
    for (const failure of writeFailures) {
      captureError(failure.error, {
        messageEntityId,
        mimeType: failure.mimeType,
      });
    }
    await cleanupFinalObjects("attachment-write-failed");
    return finalizeErr({
      status: 500,
      message: "Failed to store an email attachment",
      rejectReason: "attachment-write-failed",
    });
  }

  if (skipped.length > 0) {
    captureError(
      new UploadFinalizeError({
        status: 422,
        message: "Some email attachments were skipped during ingest",
        rejectReason: "attachments-skipped",
      }),
      {
        messageEntityId,
        skipped: skipped.map((entry) => entry.reason).join("; "),
      },
    );
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
        fileName: renamed.value,
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
              fileName: renamed.value,
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
        ...attachmentRows.map(
          ({ attachment }): AuditEvent => ({
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
          }),
        ),
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
      fileId: messageFileId,
      fileName: renamed.value,
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
    await cleanupFinalObjects("final-cleanup-after-db-error");
  }
  const writeResult = yield* writeResultResult;
  if (writeResult.status !== "ok") {
    await cleanupFinalObjects("final-cleanup-after-business-error");
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
        encrypted: messageEncrypted,
      },
    ];
    for (const attachment of accepted) {
      kickoffs.push({
        entityId: attachment.entityId,
        mimeType: attachment.mimeType,
        fieldId: attachment.fieldId,
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
