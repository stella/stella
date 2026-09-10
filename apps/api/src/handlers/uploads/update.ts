/**
 * Finalize a presigned upload. Runs the claim FSM, verifies what
 * the client uploaded against what they declared, scans the bytes,
 * dispatches into the per-purpose domain finalizer, then records the
 * finalized result. File-backed finalizers promote `tmp/` to the final
 * key before committing DB rows that point at it.
 *
 * Concurrency-safe via an atomic `UPDATE … WHERE status IN (…)`
 * claim. A second caller for the same `uploadId` either:
 *   - replays the cached `finalizedResult` (status = 'finalized')
 *   - sees the cached reject reason  (status = 'rejected')
 *   - gets a 409 if a previous attempt is still inside its
 *     `FINALIZE_CLAIM_TIMEOUT_MS` window
 *
 * Crash recovery is implicit: a process that dies mid-scan leaves
 * the row in `scanning`; the next finalize call after the timeout
 * can re-claim it because both `claimed_at` and the row's status
 * are atomically compared in the WHERE.
 */
import { Result, panic } from "better-result";
import type { Err } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";
import type { ApiFileSecurityRejectionDetails } from "@stll/api-contract";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { pendingUploads } from "@/api/db/schema";
import type { PendingUploadFinalizedResult } from "@/api/db/schema";
import { finalizeAgentSkill } from "@/api/handlers/uploads/agent-skill";
import { finalizeEntityVersion } from "@/api/handlers/uploads/entity-version";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { fileSecurityRejection } from "@/api/lib/file-scan/rejection";
import { scanFile } from "@/api/lib/file-scan/scan";
import { storedDocumentBytes } from "@/api/lib/files/stored-document-bytes";
import { getS3, readS3ArrayBuffer, writeS3ObjectWithRetry } from "@/api/lib/s3";
import type { HeadObjectResult, S3PresignError } from "@/api/lib/s3-presign";
import { copyObject, headObject } from "@/api/lib/s3-presign";
import { finalizeEntityCreate } from "@/api/lib/uploads/entity-create";
import {
  FINALIZE_CLAIM_TIMEOUT_MS,
  legacyTmpUploadKey,
  sha256Base64ToHex,
  tmpUploadKey,
  tmpUploadKeys,
  UploadFinalizeError,
} from "@/api/lib/uploads/runtime";

const finalizeParamsSchema = t.Object({
  workspaceId: tSafeId("workspace"),
  uploadId: tSafeId("pendingUpload"),
});

const config = {
  description:
    "Step 3 of 3 of the file-upload flow: finalize an upload whose bytes have " +
    "already been PUT to the presigned URL from uploads.create. Verifies the " +
    "stored object against the size and checksum the URL was signed for, " +
    "then commits the durable record and returns finalizedResult, which is " +
    "an entity_create (entityId, fileId, fileName, renamed), entity_version " +
    "(entityId, entityVersionId, versionNumber, fileId, fileName), or " +
    "agent_skill (skillId, name, version) shape depending on the purpose the " +
    "upload was created with. Idempotent: replaying it on an already " +
    "finalized upload returns the same result rather than duplicating.",
  // permissions-exempt: the static gate is workspace:read because the
  // resource-appropriate grant depends on the upload's purpose, which
  // authorizeUploadPurpose (uploads/permissions.ts) checks in-handler.
  permissions: uploadRoutePermission,
  access: "write",
  mcp: { type: "capability", reason: "file_transport" },
  params: finalizeParamsSchema,
} satisfies HandlerConfig;

type ClaimedRow = typeof pendingUploads.$inferSelect;

const fileSecurityRejectionDetails = (
  error: UploadFinalizeError,
): ApiFileSecurityRejectionDetails | null => {
  if (
    error.code !== API_FILE_SECURITY_REJECTED_ERROR_CODE ||
    error.hint === undefined ||
    error.issues === undefined
  ) {
    return null;
  }
  return {
    code: API_FILE_SECURITY_REJECTED_ERROR_CODE,
    hint: error.hint,
    issues: error.issues,
  };
};

const finalizeUpload = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    memberRole,
    params,
    recordAuditEvent,
  }) {
    const uploadId = params.uploadId;

    const pending = yield* Result.await(
      safeDb((tx) =>
        tx.query.pendingUploads.findFirst({
          where: {
            id: { eq: uploadId },
            userId: { eq: user.id },
            workspaceId: { eq: workspaceId },
          },
          columns: { purpose: true },
        }),
      ),
    );
    if (!pending) {
      return Result.err(
        new HandlerError({ status: 404, message: "Upload not found" }),
      );
    }
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: pending.purpose,
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

    // 1. Claim — atomic transition into `scanning`. Re-claimable
    //    if a previous holder either died (status='scanning' AND
    //    claimed_at older than the timeout) or hit a transient
    //    error (status='failed' AND past the cool-down).
    const timeoutSec = Math.floor(FINALIZE_CLAIM_TIMEOUT_MS / 1000);
    const claimRequestId = Bun.randomUUIDv7().slice(0, 64);
    const claimedRows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — claim FSM state transition on
        // pending_uploads; ephemeral bookkeeping. The audit row for
        // the resulting entity is emitted by `finalizeEntityCreate`
        // inside the same domain transaction.
        return tx
          .update(pendingUploads)
          .set({
            status: "scanning",
            claimedAt: new Date(),
            claimedByRequestId: claimRequestId,
          })
          .where(
            sql`${pendingUploads.id} = ${uploadId}
              AND ${pendingUploads.workspaceId} = ${workspaceId}
              AND ${pendingUploads.userId} = ${user.id}
              AND ${pendingUploads.expiresAt} > NOW()
              AND (
                ${pendingUploads.status} = 'pending'
                OR (
                  ${pendingUploads.status} IN ('failed', 'scanning')
                  AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSec} * interval '1 second'
                )
              )`,
          )
          .returning();
      }),
    );
    const claimed = claimedRows.at(0);

    if (!claimed) {
      // Claim missed: look up the row and replay or refuse.
      const existing = yield* Result.await(
        safeDb((tx) =>
          tx.query.pendingUploads.findFirst({
            where: {
              id: { eq: uploadId },
              userId: { eq: user.id },
              workspaceId: { eq: workspaceId },
            },
          }),
        ),
      );
      if (!existing) {
        return Result.err(
          new HandlerError({ status: 404, message: "Upload not found" }),
        );
      }
      if (existing.status === "finalized" && existing.finalizedResult) {
        return Result.ok({ finalizedResult: existing.finalizedResult });
      }
      if (existing.status === "rejected") {
        return Result.err(
          new HandlerError({
            status: 422,
            message: existing.rejectReason ?? "Upload was previously rejected",
            ...(existing.rejectionDetails ?? {}),
          }),
        );
      }
      const expiredRows = yield* Result.await(
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        safeDb((tx) => {
          // audit: skip — expiry transition on pending_uploads;
          // the upload never became a durable entity.
          return tx
            .update(pendingUploads)
            .set({
              status: "rejected",
              rejectReason: "Upload URL expired",
              finalizedAt: new Date(),
            })
            .where(
              sql`${pendingUploads.id} = ${uploadId}
                AND ${pendingUploads.workspaceId} = ${workspaceId}
                AND ${pendingUploads.userId} = ${user.id}
                AND ${pendingUploads.expiresAt} <= NOW()
                AND (
                  ${pendingUploads.status} IN ('pending', 'failed')
                  OR (
                    ${pendingUploads.status} = 'scanning'
                    AND ${pendingUploads.claimedAt} < NOW() - ${timeoutSec} * interval '1 second'
                  )
                )`,
            )
            .returning({ id: pendingUploads.id });
        }),
      );
      if (expiredRows.at(0)) {
        return Result.err(
          new HandlerError({ status: 422, message: "Upload URL expired" }),
        );
      }
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Finalize already in progress for this upload",
        }),
      );
    }

    // From here on we own the row. Any early return must transition
    // the row to a terminal status; `scanning` left behind would
    // block re-claim until the timeout.
    const finalizeResult = yield* runFinalize({
      claimed,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      memberRole,
      uploadId,
      claimRequestId,
      safeDb,
      recordAuditEvent,
    });

    if (Result.isError(finalizeResult)) {
      const error = finalizeResult.error;
      const terminalStatus = error.status === 500 ? "failed" : "rejected";
      const failedRows = yield* Result.await(
        // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
        safeDb((tx) => {
          // audit: skip — terminal-state write on pending_uploads,
          // no domain entity to attribute.
          return tx
            .update(pendingUploads)
            .set({
              status: terminalStatus,
              rejectReason: error.rejectReason ?? error.message,
              rejectionDetails:
                terminalStatus === "rejected"
                  ? fileSecurityRejectionDetails(error)
                  : null,
              finalizedAt: terminalStatus === "rejected" ? new Date() : null,
            })
            .where(
              and(
                eq(pendingUploads.id, uploadId),
                eq(pendingUploads.userId, user.id),
                eq(pendingUploads.workspaceId, workspaceId),
                eq(pendingUploads.status, "scanning"),
                eq(pendingUploads.claimedByRequestId, claimRequestId),
              ),
            )
            .returning({ id: pendingUploads.id });
        }),
      );
      if (!failedRows.at(0)) {
        panic("Pending upload failure marker update returned no rows");
      }
      if (terminalStatus === "rejected") {
        // Best-effort tmp cleanup only for terminal rejections.
        // Transient failures keep tmp bytes so finalize can retry.
        await deleteStagedUploadObjects({
          organizationId: session.activeOrganizationId,
          uploadId,
          workspaceId,
          stage: "tmp-cleanup-after-reject",
        });
      }
      return Result.err(
        new HandlerError({
          status: error.status,
          message: error.message,
          code: error.code,
          hint: error.hint,
          issues: error.issues,
        }),
      );
    }

    return Result.ok({ finalizedResult: finalizeResult.value.finalizedResult });
  },
);

type RunFinalizeProps = {
  claimed: ClaimedRow;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  memberRole: { role: string };
  uploadId: SafeId<"pendingUpload">;
  claimRequestId: string;
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
};

type RunFinalizeOk = {
  finalizedResult: PendingUploadFinalizedResult;
};

type StagedUploadKeyProps = {
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
};

type StagedUploadObject = {
  head: HeadObjectResult;
  tmpKey: string;
};

const resolveStagedUploadObject = async ({
  organizationId,
  uploadId,
  workspaceId,
}: StagedUploadKeyProps): Promise<
  Result<StagedUploadObject, S3PresignError>
> => {
  const scopedTmpKey = tmpUploadKey({ organizationId, uploadId, workspaceId });
  const scopedHead = await headObject(scopedTmpKey);
  if (Result.isOk(scopedHead)) {
    return Result.ok({ head: scopedHead.value, tmpKey: scopedTmpKey });
  }

  const legacyTmpKey = legacyTmpUploadKey(uploadId);
  const legacyHead = await headObject(legacyTmpKey);
  if (Result.isOk(legacyHead)) {
    return Result.ok({ head: legacyHead.value, tmpKey: legacyTmpKey });
  }

  return Result.err(scopedHead.error);
};

const deleteStagedUploadObjects = async ({
  organizationId,
  stage,
  uploadId,
  workspaceId,
}: StagedUploadKeyProps & { stage: string }) => {
  for (const key of tmpUploadKeys({ organizationId, uploadId, workspaceId })) {
    await getS3()
      .delete(key)
      .catch((deleteError: unknown) =>
        captureError(deleteError, { key, stage, uploadId }),
      );
  }
};

/**
 * Generic finalize body. Verifies what S3 has against what the
 * pending row says, scans the bytes, dispatches into the
 * per-purpose domain finalizer, then removes the tmp object after the
 * purpose has durably accepted the upload.
 *
 * @yields SafeDb errors out to the safe-handler runner so the only
 *   errors that escape are the typed `UploadFinalizeError` cases.
 */
const runFinalize = async function* ({
  claimed,
  organizationId,
  workspaceId,
  userId,
  memberRole,
  uploadId,
  claimRequestId,
  safeDb,
  recordAuditEvent,
}: RunFinalizeProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<RunFinalizeOk, UploadFinalizeError>,
  unknown
> {
  // 2. S3 HEAD — exists? size matches? checksum matches?
  const stagedObject = await resolveStagedUploadObject({
    organizationId,
    uploadId: claimed.id,
    workspaceId,
  });
  if (Result.isError(stagedObject)) {
    return Result.err(
      new UploadFinalizeError({
        status: 404,
        message: "Upload not found in staging — URL likely expired",
        rejectReason: "tmp-head-failed",
      }),
    );
  }
  const { head, tmpKey } = stagedObject.value;
  if (head.contentLength !== claimed.declaredSize) {
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: `Uploaded size ${head.contentLength} does not match declared ${claimed.declaredSize}`,
        rejectReason: "size-mismatch",
      }),
    );
  }
  if (
    head.checksumSHA256 &&
    sha256Base64ToHex(head.checksumSHA256) !== claimed.declaredSha256
  ) {
    return Result.err(
      new UploadFinalizeError({
        status: 422,
        message: "Uploaded SHA-256 does not match declared",
        rejectReason: "sha256-mismatch",
      }),
    );
  }

  // 3. Download for scan.
  const fileBuffer = await readS3ArrayBuffer(tmpKey);
  if (!head.checksumSHA256) {
    const uploadedSha256 = new Bun.CryptoHasher("sha256")
      .update(fileBuffer)
      .digest("hex");
    if (uploadedSha256 !== claimed.declaredSha256) {
      return Result.err(
        new UploadFinalizeError({
          status: 422,
          message: "Uploaded SHA-256 does not match declared",
          rejectReason: "sha256-mismatch",
        }),
      );
    }
  }

  // 4. Scan — same pipeline the legacy upload handler ran inline.
  const scanResult = await scanFile({
    buffer: new Uint8Array(fileBuffer),
    declaredMimeType: claimed.declaredMime,
    fileName: claimed.declaredName,
  });
  if (Result.isError(scanResult)) {
    return Result.err(
      new UploadFinalizeError({
        status: 500,
        message: "File security scan failed",
        rejectReason: "scan-error",
      }),
    );
  }
  if (scanResult.value.verdict === "reject") {
    const rejection = fileSecurityRejection(scanResult.value);
    if (rejection === null) {
      panic("Rejecting scan had no rejecting findings");
    }
    return Result.err(
      new UploadFinalizeError({
        ...rejection,
        status: 422,
        rejectReason: rejection.message,
      }),
    );
  }
  let scanWarnings: string[] | undefined;
  if (scanResult.value.verdict === "warn") {
    scanWarnings = [];
    for (const finding of scanResult.value.findings) {
      if (finding.severity === "warn") {
        scanWarnings.push(finding.message);
      }
    }
  }

  // 4b. Reference removal, after the scan judged what the client actually
  //     sent. Every presigned purpose promotes through the same object and
  //     records the same size and hash, so this is where a stamped download
  //     coming back stops being version N's bytes carrying version N-1's code.
  const { bytes: storedBytes, strippedArchive } =
    await storedDocumentBytes(fileBuffer);
  const storedSha256Hex =
    strippedArchive === null
      ? claimed.declaredSha256
      : new Bun.CryptoHasher("sha256").update(storedBytes).digest("hex");

  // A server-side copy is the cheap promotion, but it would publish the bytes
  // the client staged. Stripped bytes exist only here, so they are written.
  const promoteTmpObject = async (finalKey: string) => {
    const promoted =
      strippedArchive === null
        ? await copyObject(tmpKey, finalKey)
        : await Result.tryPromise(
            async () =>
              await writeS3ObjectWithRetry({
                contentType: claimed.declaredMime,
                data: storedBytes,
                key: finalKey,
              }),
          );
    if (promoted.status === "error") {
      return Result.err(
        new UploadFinalizeError({
          status: 500,
          message: "Failed to promote tmp object",
          rejectReason:
            strippedArchive === null ? "copy-failed" : "write-failed",
        }),
      );
    }
    return Result.ok(undefined);
  };

  // 5. Purpose finalization. File-backed purposes promote the tmp
  //    object before committing DB rows that reference the final key.
  const purposeData = claimed.purposeData;
  const domainArgs = {
    safeDb,
    recordAuditEvent,
    organizationId,
    workspaceId,
    userId,
    fileBuffer: strippedArchive ?? fileBuffer,
    declaredName: claimed.declaredName,
    declaredMime: claimed.declaredMime,
    declaredSize: storedBytes.byteLength,
    declaredSha256Hex: storedSha256Hex,
    scanWarnings,
    promoteTmpObject,
    uploadId,
    claimRequestId,
  };

  // Dispatch on purposeData. Each variant is independent; the
  // `purposeData` field is the source of truth (it carries the
  // discriminator), and the body schemas at presign time guarantee
  // it matches the URL purpose.
  type RunAnyPurpose =
    Awaited<
      ReturnType<
        | typeof finalizeEntityCreate
        | typeof finalizeEntityVersion
        | typeof finalizeAgentSkill
      >
    > extends AsyncGenerator<unknown, infer R, unknown>
      ? R
      : never;
  let purposeOk: RunAnyPurpose;
  if (purposeData.type === "entity_create") {
    purposeOk = yield* finalizeEntityCreate({ ...domainArgs, purposeData });
  } else if (purposeData.type === "entity_version") {
    purposeOk = yield* finalizeEntityVersion({ ...domainArgs, purposeData });
  } else {
    purposeOk = yield* finalizeAgentSkill({
      safeDb,
      recordAuditEvent,
      organizationId,
      userId,
      memberRole,
      fileBuffer,
      declaredName: claimed.declaredName,
      declaredMime: claimed.declaredMime,
      uploadId,
      claimRequestId,
      scope: purposeData.scope,
      workspaceId,
    });
  }
  if (purposeOk.status === "error") {
    return Result.err(purposeOk.error);
  }

  const afterPromote = purposeOk.value.afterPromote;
  if (afterPromote) {
    const postPromoteResult = await Result.tryPromise(async () => {
      afterPromote();
      await Promise.resolve();
    });
    if (Result.isError(postPromoteResult)) {
      captureError(postPromoteResult.error, {
        uploadId: claimed.id,
        stage: "post-promote",
      });
    }
  }

  // 6. Tmp cleanup. Bucket lifecycle catches anything we miss.
  await getS3()
    .delete(tmpKey)
    .catch((deleteError: unknown) =>
      captureError(deleteError, {
        uploadId: claimed.id,
        stage: "tmp-cleanup-after-promote",
      }),
    );

  return Result.ok({ finalizedResult: purposeOk.value.finalizedResult });
};

export default finalizeUpload;
